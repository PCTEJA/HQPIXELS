/**
 * Rate limiting.
 *
 * Two backends behind one interface:
 *
 *   DurableObjectRateLimiter — strongly consistent. A single Durable Object
 *     instance per bucket key owns the counter, so "5 per 10 minutes" means
 *     exactly that, globally. This is the default and the only one used for
 *     money-adjacent endpoints (checkout, reservations, upload tickets).
 *
 *   KvRateLimiter — eventually consistent fallback. KV writes propagate between
 *     colos with a delay, so a distributed attacker can exceed the nominal limit
 *     by roughly the number of colos they hit before propagation. Acceptable for
 *     coarse controls (page-view flood protection); NOT acceptable for checkout.
 *     Used only when the DO binding is absent.
 *
 * This is the application layer. Cloudflare WAF rate-limiting rules sit in front
 * of it and are configured per environment (see DEPLOYMENT.md); the two are
 * complementary — the WAF sheds volumetric load before it reaches us, this layer
 * enforces per-user and per-resource fairness that the WAF cannot see.
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types/2023-07-01';
import { RATE_LIMITS, type RateLimitName } from '@shared/constants';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the window resets. Sent as Retry-After on a 429. */
  readonly retryAfter: number;
}

export interface RateLimiter {
  /**
   * Consume one unit from `key` under the named policy.
   *
   * Fails OPEN on backend errors. That is a deliberate availability choice: a
   * KV/DO outage must not stop people buying. The compensating controls are the
   * Cloudflare WAF rules in front and the alerting on limiter errors — see the
   * residual-risk register in SECURITY.md.
   */
  consume(policy: RateLimitName, key: string): Promise<RateLimitDecision>;
}

function policyFor(policy: RateLimitName): { limit: number; windowSeconds: number } {
  return RATE_LIMITS[policy];
}

function allowedDecision(limit: number, remaining: number, retryAfter: number): RateLimitDecision {
  return { allowed: true, limit, remaining, retryAfter };
}

// -----------------------------------------------------------------------------
// Durable Object backend
// -----------------------------------------------------------------------------

export class DurableObjectRateLimiter implements RateLimiter {
  constructor(
    private readonly namespace: DurableObjectNamespace,
    private readonly onError: (error: unknown, context: Record<string, unknown>) => void,
  ) {}

  async consume(policy: RateLimitName, key: string): Promise<RateLimitDecision> {
    const { limit, windowSeconds } = policyFor(policy);

    try {
      // One DO instance per (policy, key). idFromName is deterministic, so every
      // colo routes the same bucket to the same instance.
      const id = this.namespace.idFromName(`${policy}:${key}`);
      const stub = this.namespace.get(id);

      const response = await stub.fetch('https://rate-limiter.internal/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit, windowSeconds }),
      });

      if (!response.ok) throw new Error(`rate limiter returned ${response.status}`);

      const body = (await response.json()) as {
        allowed?: boolean;
        remaining?: number;
        retryAfter?: number;
      };

      return {
        allowed: body.allowed !== false,
        limit,
        remaining: typeof body.remaining === 'number' ? body.remaining : 0,
        retryAfter: typeof body.retryAfter === 'number' ? body.retryAfter : windowSeconds,
      };
    } catch (error) {
      this.onError(error, { policy, backend: 'durable_object' });
      return allowedDecision(limit, limit, 0);
    }
  }
}

// -----------------------------------------------------------------------------
// KV backend
// -----------------------------------------------------------------------------

export class KvRateLimiter implements RateLimiter {
  constructor(
    private readonly kv: KVNamespace,
    private readonly onError: (error: unknown, context: Record<string, unknown>) => void,
  ) {}

  async consume(policy: RateLimitName, key: string): Promise<RateLimitDecision> {
    const { limit, windowSeconds } = policyFor(policy);

    try {
      // Fixed window, aligned to the clock. Simple and cheap; the cost is that a
      // burst straddling a window boundary can briefly reach 2x the limit.
      const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
      const kvKey = `rl:${policy}:${key}:${windowStart}`;

      const current = await this.kv.get(kvKey);
      const count = current === null ? 0 : Number.parseInt(current, 10);
      const used = Number.isSafeInteger(count) && count >= 0 ? count : 0;
      const resetAt = windowStart + windowSeconds;
      const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));

      if (used >= limit) {
        return { allowed: false, limit, remaining: 0, retryAfter };
      }

      // Read-modify-write is racy under concurrency; the DO backend exists
      // precisely because that race is unacceptable on the payment path.
      await this.kv.put(kvKey, String(used + 1), {
        expirationTtl: Math.max(60, windowSeconds + 60),
      });

      return { allowed: true, limit, remaining: limit - used - 1, retryAfter };
    } catch (error) {
      this.onError(error, { policy, backend: 'kv' });
      return allowedDecision(limit, limit, 0);
    }
  }
}

// -----------------------------------------------------------------------------
// Test double
// -----------------------------------------------------------------------------

/** In-memory limiter for unit tests. Strongly consistent within one process. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  consume(policy: RateLimitName, key: string): Promise<RateLimitDecision> {
    const { limit, windowSeconds } = policyFor(policy);
    const nowSec = Math.floor(this.now() / 1000);
    const bucketKey = `${policy}:${key}`;
    const existing = this.buckets.get(bucketKey);

    if (!existing || existing.resetAt <= nowSec) {
      this.buckets.set(bucketKey, { count: 1, resetAt: nowSec + windowSeconds });
      return Promise.resolve({
        allowed: true,
        limit,
        remaining: limit - 1,
        retryAfter: windowSeconds,
      });
    }

    const retryAfter = Math.max(1, existing.resetAt - nowSec);
    if (existing.count >= limit) {
      return Promise.resolve({ allowed: false, limit, remaining: 0, retryAfter });
    }

    existing.count += 1;
    return Promise.resolve({
      allowed: true,
      limit,
      remaining: limit - existing.count,
      retryAfter,
    });
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** Never limits. Used by tests that are not exercising the limiter itself. */
export class NoopRateLimiter implements RateLimiter {
  consume(policy: RateLimitName): Promise<RateLimitDecision> {
    const { limit, windowSeconds } = policyFor(policy);
    return Promise.resolve({ allowed: true, limit, remaining: limit, retryAfter: windowSeconds });
  }
}
