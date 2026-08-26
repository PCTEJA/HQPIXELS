/**
 * Analytics client — the write side of the "no database write per page view"
 * rule.
 *
 * Sharding strategy, which is the whole design:
 *
 *   Page views  -> spread across N shards at random. We only ever need the sum,
 *                  so any shard will do, and spreading avoids a single Durable
 *                  Object becoming the global write bottleneck at 100k
 *                  concurrent viewers.
 *
 *   Clicks      -> sharded by placement id, deterministically. Click
 *                  de-duplication needs the same (visitor, placement) pair to
 *                  land on the same object, otherwise a visitor could be counted
 *                  once per shard.
 *
 *   Impressions -> sharded by placement id too, for the same reason.
 *
 * Every call is fire-and-forget via waitUntil: analytics must never add latency
 * to, or be able to fail, a user-facing request.
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types/2023-07-01';
import type { Logger } from './logger';

/**
 * Number of view shards.
 *
 * 16 gives headroom well past the initial target: a Durable Object handles
 * thousands of requests per second, and each of these is a tiny in-memory
 * increment. Raising it later is safe — the read path is a SUM over rows, not
 * over shards, so shard count is not baked into any stored data.
 */
const VIEW_SHARDS = 16;

/** Placement shards. Independent of VIEW_SHARDS so they can be tuned separately. */
const PLACEMENT_SHARDS = 16;

export type AnalyticsSurface = 'home' | 'wall' | 'rankings' | 'stats' | 'placement' | 'other';

export interface AnalyticsClient {
  recordView(surface: AnalyticsSurface, filtered: boolean): void;
  recordClick(placementId: string, visitorId: string | null, filtered: boolean): void;
  recordImpressions(placementIds: readonly string[]): void;
  /** Force a flush. Used by the cron safety net. */
  flushAll(): Promise<void>;
  /** Pending-work snapshot for the admin health view. */
  backlog(): Promise<number>;
}

/** FNV-1a. Small, fast, stable across isolates — that last part is what matters. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export class DurableObjectAnalytics implements AnalyticsClient {
  constructor(
    private readonly namespace: DurableObjectNamespace,
    private readonly waitUntil: (promise: Promise<unknown>) => void,
    private readonly logger: Logger,
  ) {}

  private stub(name: string) {
    return this.namespace.get(this.namespace.idFromName(name));
  }

  private send(shard: string, path: string, body: unknown): void {
    const promise = this.stub(shard)
      .fetch(`https://analytics.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      .then((response) => {
        if (!response.ok) {
          this.logger.warn('analytics_buffer_rejected', { shard, path, status: response.status });
        }
      })
      .catch((error: unknown) => {
        // Losing a view count is acceptable; failing the page is not.
        this.logger.warn('analytics_buffer_unreachable', {
          shard,
          path,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      });

    this.waitUntil(promise);
  }

  recordView(surface: AnalyticsSurface, filtered: boolean): void {
    const shard = `views-${Math.floor(Math.random() * VIEW_SHARDS)}`;
    this.send(shard, '/view', { surface, filtered });
  }

  recordClick(placementId: string, visitorId: string | null, filtered: boolean): void {
    const shard = `placements-${fnv1a(placementId) % PLACEMENT_SHARDS}`;
    this.send(shard, '/click', { placementId, visitorId, filtered });
  }

  recordImpressions(placementIds: readonly string[]): void {
    if (placementIds.length === 0) return;

    // Group by shard so a viewport full of placements is a handful of calls
    // rather than one per placement.
    const grouped = new Map<number, string[]>();
    for (const id of placementIds.slice(0, 400)) {
      const shard = fnv1a(id) % PLACEMENT_SHARDS;
      const bucket = grouped.get(shard);
      if (bucket) bucket.push(id);
      else grouped.set(shard, [id]);
    }

    for (const [shard, ids] of grouped) {
      this.send(`placements-${shard}`, '/impressions', { placementIds: ids });
    }
  }

  async flushAll(): Promise<void> {
    const shards: string[] = [];
    for (let i = 0; i < VIEW_SHARDS; i += 1) shards.push(`views-${i}`);
    for (let i = 0; i < PLACEMENT_SHARDS; i += 1) shards.push(`placements-${i}`);

    // Sequential in small batches: flushing 32 objects in parallel would open 32
    // simultaneous database connections from one cron invocation.
    const batchSize = 4;
    for (let i = 0; i < shards.length; i += batchSize) {
      const batch = shards.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (shard) => {
          try {
            await this.stub(shard).fetch('https://analytics.internal/flush', { method: 'POST' });
          } catch (error) {
            this.logger.warn('analytics_flush_failed', {
              shard,
              error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
            });
          }
        }),
      );
    }
  }

  async backlog(): Promise<number> {
    let total = 0;
    const shards: string[] = [];
    for (let i = 0; i < VIEW_SHARDS; i += 1) shards.push(`views-${i}`);
    for (let i = 0; i < PLACEMENT_SHARDS; i += 1) shards.push(`placements-${i}`);

    await Promise.all(
      shards.map(async (shard) => {
        try {
          const response = await this.stub(shard).fetch('https://analytics.internal/stats');
          if (!response.ok) return;
          const body = (await response.json()) as {
            pendingViewKeys?: number;
            pendingClickKeys?: number;
            pendingImpressionKeys?: number;
          };
          total +=
            (body.pendingViewKeys ?? 0) +
            (body.pendingClickKeys ?? 0) +
            (body.pendingImpressionKeys ?? 0);
        } catch {
          // A shard we cannot reach contributes nothing to the reported backlog.
        }
      }),
    );

    return total;
  }
}

/** No-op client for tests and for the case where the DO binding is absent. */
export class NoopAnalytics implements AnalyticsClient {
  readonly views: Array<{ surface: AnalyticsSurface; filtered: boolean }> = [];
  readonly clicks: Array<{ placementId: string; visitorId: string | null; filtered: boolean }> = [];
  readonly impressions: string[] = [];

  recordView(surface: AnalyticsSurface, filtered: boolean): void {
    this.views.push({ surface, filtered });
  }
  recordClick(placementId: string, visitorId: string | null, filtered: boolean): void {
    this.clicks.push({ placementId, visitorId, filtered });
  }
  recordImpressions(placementIds: readonly string[]): void {
    this.impressions.push(...placementIds);
  }
  flushAll(): Promise<void> {
    return Promise.resolve();
  }
  backlog(): Promise<number> {
    return Promise.resolve(0);
  }
}

/** Which surface a path counts as, for the page-view breakdown. */
export function surfaceForPath(pathname: string): AnalyticsSurface {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/wall')) return 'wall';
  if (pathname.startsWith('/rankings')) return 'rankings';
  if (pathname.startsWith('/stats')) return 'stats';
  if (pathname.startsWith('/p/')) return 'placement';
  return 'other';
}

export const __testing = { fnv1a, VIEW_SHARDS, PLACEMENT_SHARDS };
