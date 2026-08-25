/**
 * Durable Object that owns one rate-limit bucket.
 *
 * A sliding-window log, not a fixed window: we keep the timestamps of recent
 * hits and count how many fall inside the window. That costs a little more
 * storage than a counter but removes the fixed-window boundary burst (where an
 * attacker gets 2x the limit by straddling the reset), which matters for the
 * checkout endpoint.
 *
 * State lives in the DO's in-memory field plus its storage, so it survives
 * eviction. An alarm cleans up idle buckets so we do not pay to store one object
 * per IP forever.
 */

import type { DurableObjectState } from '@cloudflare/workers-types/2023-07-01';

interface ConsumeRequest {
  readonly limit: number;
  readonly windowSeconds: number;
}

interface BucketState {
  /** Unix ms timestamps of hits, ascending. Trimmed to the window on every read. */
  hits: number[];
}

/** Hard cap on retained timestamps, so a flood cannot grow the object unbounded. */
const MAX_RETAINED_HITS = 512;

export class RateLimiterDO {
  private state: BucketState | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  private async load(): Promise<BucketState> {
    if (this.state !== null) return this.state;
    const stored = await this.ctx.storage.get<BucketState>('bucket');
    this.state = stored ?? { hits: [] };
    return this.state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let body: ConsumeRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }

    const limit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : 1;
    const windowSeconds =
      Number.isSafeInteger(body.windowSeconds) && body.windowSeconds > 0 ? body.windowSeconds : 60;

    const url = new URL(request.url);
    if (url.pathname === '/peek') {
      const bucket = await this.load();
      const now = Date.now();
      const active = bucket.hits.filter((t) => t > now - windowSeconds * 1000);
      return Response.json({
        used: active.length,
        limit,
        remaining: Math.max(0, limit - active.length),
      });
    }

    // Serialise concurrent requests to this bucket. Without blockConcurrencyWhile
    // two simultaneous consumes could both read the same count and both allow.
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const bucket = await this.load();
      const now = Date.now();
      const cutoff = now - windowSeconds * 1000;

      // Trim expired hits.
      const active = bucket.hits.filter((t) => t > cutoff);

      if (active.length >= limit) {
        const oldest = active[0] ?? now;
        const retryAfter = Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000));
        bucket.hits = active;
        await this.ctx.storage.put('bucket', bucket);
        return { allowed: false, remaining: 0, retryAfter };
      }

      active.push(now);
      bucket.hits = active.length > MAX_RETAINED_HITS ? active.slice(-MAX_RETAINED_HITS) : active;
      await this.ctx.storage.put('bucket', bucket);

      // Self-clean: delete this object's storage once the window has certainly
      // lapsed with no further traffic.
      await this.ctx.storage.setAlarm(now + windowSeconds * 1000 + 60_000);

      return {
        allowed: true,
        remaining: Math.max(0, limit - active.length),
        retryAfter: windowSeconds,
      };
    });

    return Response.json(result);
  }

  /** Idle bucket cleanup. Keeps Durable Object storage cost proportional to live traffic. */
  async alarm(): Promise<void> {
    const bucket = await this.load();
    // If nothing has been recorded in the last hour, drop the object entirely.
    const newest = bucket.hits.length > 0 ? bucket.hits[bucket.hits.length - 1] : 0;
    if ((newest ?? 0) < Date.now() - 3_600_000) {
      await this.ctx.storage.deleteAll();
      this.state = null;
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
}
