/**
 * Durable Object that buffers analytics events and flushes them to Postgres in
 * batches.
 *
 * This object is the reason a traffic spike does not become a database write
 * storm. At 100,000 concurrent viewers, a row-per-view design would be the first
 * thing to fall over; here, a page view is an in-memory counter increment on one
 * of a small number of shard objects, and the database sees one INSERT ... ON
 * CONFLICT per shard per minute.
 *
 * Ordering guarantee that makes it safe: the buffer is cleared ONLY after the
 * database call succeeds. A failed flush retries with the same accumulated
 * counts, so a transient database error costs latency in the public counter, not
 * data. The trade-off is that a flush which succeeds but whose response is lost
 * would double count; that window is one alarm interval and the counts involved
 * are page views, not money.
 */

import type { DurableObjectState } from '@cloudflare/workers-types/2023-07-01';
import { ANALYTICS_BUCKET_SECONDS, ANALYTICS_FLUSH_INTERVAL_MS } from '@shared/constants';

type Surface = 'home' | 'wall' | 'rankings' | 'stats' | 'placement' | 'other';

interface ViewKey {
  readonly bucketStart: string;
  readonly surface: Surface;
}

interface BufferState {
  /** `${bucketStart}|${surface}` -> { views, filtered } */
  views: Record<string, { views: number; filtered: number }>;
  /** `${bucketStart}|${placementId}` -> { clicks, filtered, visitors } */
  clicks: Record<string, { clicks: number; filtered: number; visitors: string[] }>;
  /** `${bucketStart}|${placementId}` -> impressions */
  impressions: Record<string, number>;
  /** Consecutive failed flushes, for backoff and alerting. */
  failures: number;
  lastFlushAt: number;
}

/** Bounds memory: a hostile client cannot make one object hold unlimited keys. */
const MAX_KEYS_PER_KIND = 2000;
const MAX_TRACKED_VISITORS_PER_KEY = 64;

export interface AnalyticsFlushTarget {
  ingestViews(batch: unknown[]): Promise<void>;
  ingestClicks(batch: unknown[]): Promise<void>;
  ingestImpressions(batch: unknown[]): Promise<void>;
}

function bucketStartIso(nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const aligned = Math.floor(seconds / ANALYTICS_BUCKET_SECONDS) * ANALYTICS_BUCKET_SECONDS;
  return new Date(aligned * 1000).toISOString();
}

function emptyState(): BufferState {
  return { views: {}, clicks: {}, impressions: {}, failures: 0, lastFlushAt: 0 };
}

export class AnalyticsBufferDO {
  private state: BufferState | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Record<string, unknown>,
  ) {}

  private async load(): Promise<BufferState> {
    if (this.state !== null) return this.state;
    const stored = await this.ctx.storage.get<BufferState>('buffer');
    this.state = stored ?? emptyState();
    return this.state;
  }

  private async save(state: BufferState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put('buffer', state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/stats') {
      const state = await this.load();
      return Response.json({
        pendingViewKeys: Object.keys(state.views).length,
        pendingClickKeys: Object.keys(state.clicks).length,
        pendingImpressionKeys: Object.keys(state.impressions).length,
        failures: state.failures,
        lastFlushAt: state.lastFlushAt,
      });
    }

    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    if (url.pathname === '/flush') {
      const ok = await this.flush();
      return Response.json({ ok });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }

    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      const now = Date.now();
      const bucket = bucketStartIso(now);

      if (url.pathname === '/view') {
        const { surface, filtered } = body as { surface?: string; filtered?: boolean };
        const key = `${bucket}|${normaliseSurface(surface)}`;
        const entry = state.views[key] ?? { views: 0, filtered: 0 };
        if (filtered === true) entry.filtered += 1;
        else entry.views += 1;
        if (Object.keys(state.views).length < MAX_KEYS_PER_KIND || state.views[key] !== undefined) {
          state.views[key] = entry;
        }
      } else if (url.pathname === '/click') {
        const { placementId, visitorId, filtered } = body as {
          placementId?: string;
          visitorId?: string;
          filtered?: boolean;
        };
        if (typeof placementId === 'string' && placementId.length === 36) {
          const key = `${bucket}|${placementId}`;
          const entry = state.clicks[key] ?? { clicks: 0, filtered: 0, visitors: [] };

          // Click fraud control: one counted click per visitor per bucket. A
          // repeat from the same visitor inside the window is recorded as
          // filtered, so the buyer can see the difference.
          const isRepeat = typeof visitorId === 'string' && entry.visitors.includes(visitorId);

          if (filtered === true || isRepeat) {
            entry.filtered += 1;
          } else {
            entry.clicks += 1;
            if (
              typeof visitorId === 'string' &&
              entry.visitors.length < MAX_TRACKED_VISITORS_PER_KEY
            ) {
              entry.visitors.push(visitorId);
            }
          }

          if (
            Object.keys(state.clicks).length < MAX_KEYS_PER_KIND ||
            state.clicks[key] !== undefined
          ) {
            state.clicks[key] = entry;
          }
        }
      } else if (url.pathname === '/impressions') {
        const { placementIds } = body as { placementIds?: unknown };
        if (Array.isArray(placementIds)) {
          // Cap per request so one client cannot claim impressions for the whole
          // wall in a single call.
          for (const id of placementIds.slice(0, 200)) {
            if (typeof id !== 'string' || id.length !== 36) continue;
            const key = `${bucket}|${id}`;
            if (
              Object.keys(state.impressions).length >= MAX_KEYS_PER_KIND &&
              state.impressions[key] === undefined
            ) {
              continue;
            }
            state.impressions[key] = (state.impressions[key] ?? 0) + 1;
          }
        }
      }

      await this.save(state);

      const existingAlarm = await this.ctx.storage.getAlarm();
      if (existingAlarm === null) {
        await this.ctx.storage.setAlarm(now + ANALYTICS_FLUSH_INTERVAL_MS);
      }
    });

    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const flushed = await this.flush();
    const state = await this.load();

    const pending =
      Object.keys(state.views).length +
      Object.keys(state.clicks).length +
      Object.keys(state.impressions).length;

    if (pending > 0 || !flushed) {
      // Exponential backoff on repeated failure, capped, so a database outage
      // does not turn into a tight retry loop billed per invocation.
      const backoff = Math.min(2 ** Math.min(state.failures, 5), 32);
      await this.ctx.storage.setAlarm(Date.now() + ANALYTICS_FLUSH_INTERVAL_MS * backoff);
    }
  }

  /**
   * Flush to Postgres. Returns false on failure, leaving the buffer intact.
   *
   * The database calls go through the injected target when present (tests) or a
   * direct Supabase RPC otherwise.
   */
  private async flush(): Promise<boolean> {
    const state = await this.load();

    const viewBatch = Object.entries(state.views).map(([key, value]) => {
      const [bucketStart, surface] = key.split('|');
      return { bucketStart, surface, views: value.views, filtered: value.filtered };
    });
    const clickBatch = Object.entries(state.clicks).map(([key, value]) => {
      const [bucketStart, placementId] = key.split('|');
      return {
        bucketStart,
        placementId,
        clicks: value.clicks,
        filtered: value.filtered,
        distinctVisitors: value.visitors.length,
      };
    });
    const impressionBatch = Object.entries(state.impressions).map(([key, impressions]) => {
      const [bucketStart, placementId] = key.split('|');
      return { bucketStart, placementId, impressions };
    });

    if (viewBatch.length === 0 && clickBatch.length === 0 && impressionBatch.length === 0) {
      return true;
    }

    try {
      const target = await this.resolveTarget();
      if (viewBatch.length > 0) await target.ingestViews(viewBatch);
      if (clickBatch.length > 0) await target.ingestClicks(clickBatch);
      if (impressionBatch.length > 0) await target.ingestImpressions(impressionBatch);

      // Cleared only after every call succeeded.
      await this.save({
        views: {},
        clicks: {},
        impressions: {},
        failures: 0,
        lastFlushAt: Date.now(),
      });
      return true;
    } catch (error) {
      state.failures += 1;
      await this.save(state);

      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'analytics_flush_failed',
          failures: state.failures,
          pendingViews: viewBatch.length,
          pendingClicks: clickBatch.length,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        }),
      );
      return false;
    }
  }

  /**
   * Build the flush target from the DO's env.
   *
   * The DO cannot import the Worker's request-scoped Supabase client, so it
   * constructs its own minimal RPC caller. Deliberately hand-rolled fetch rather
   * than the Supabase SDK: this is three POSTs and the SDK would be a large
   * dependency inside every analytics object.
   */
  private resolveTarget(): Promise<AnalyticsFlushTarget> {
    const url = typeof this.env.SUPABASE_URL === 'string' ? this.env.SUPABASE_URL : '';
    const key =
      typeof this.env.SUPABASE_SERVICE_ROLE_KEY === 'string'
        ? this.env.SUPABASE_SERVICE_ROLE_KEY
        : '';

    if (url === '' || key === '') {
      return Promise.reject(new Error('analytics buffer is missing Supabase configuration'));
    }

    const call = async (fn: string, payload: unknown): Promise<void> => {
      const response = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`${fn} failed with ${response.status}`);
      }
    };

    return Promise.resolve({
      ingestViews: (batch) => call('ingest_view_aggregates', { p_batch: batch }),
      ingestClicks: (batch) => call('ingest_click_aggregates', { p_batch: batch }),
      ingestImpressions: (batch) => call('ingest_impression_aggregates', { p_batch: batch }),
    });
  }
}

function normaliseSurface(value: string | undefined): Surface {
  switch (value) {
    case 'home':
    case 'wall':
    case 'rankings':
    case 'stats':
    case 'placement':
      return value;
    default:
      return 'other';
  }
}

/** Exported for the unit tests. */
export const __testing = { bucketStartIso, normaliseSurface };
export type { ViewKey };
