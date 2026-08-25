/**
 * Edge caching for the public read path.
 *
 * The performance requirement is blunt: a warm homepage or wall view must not
 * touch the database. This module is how that happens:
 *
 *   request -> Cloudflare edge cache (Cache API)   [no Worker CPU beyond a lookup]
 *           -> KV (globally replicated, ~ms)       [no database]
 *           -> database rebuild                    [only on a cold/dirty key]
 *
 * Plus conditional requests: the client sends If-None-Match with the manifest
 * version it already has, and a 304 costs a few hundred bytes instead of the
 * whole manifest. A visible tab revalidating once a minute is therefore nearly
 * free, which is what lets us avoid a WebSocket per visitor.
 */

import type { KVNamespace } from '@cloudflare/workers-types/2023-07-01';

export interface CachePolicy {
  /** Seconds the response is fresh. */
  readonly maxAge: number;
  /** Seconds a stale response may be served while revalidating behind it. */
  readonly staleWhileRevalidate: number;
  /** Seconds a stale response may be served if the origin is erroring. */
  readonly staleIfError?: number;
}

/**
 * Cache-Control for a public, cacheable response.
 *
 * `stale-while-revalidate` is the important part for a traffic spike: after
 * `maxAge`, the edge serves the stale copy INSTANTLY to every visitor while a
 * single request revalidates. A million viewers therefore produce one origin
 * request per colo per window, not a million.
 */
export function publicCacheControl(policy: CachePolicy): string {
  const parts = [
    'public',
    `max-age=${policy.maxAge}`,
    `s-maxage=${policy.maxAge}`,
    `stale-while-revalidate=${policy.staleWhileRevalidate}`,
  ];
  if (policy.staleIfError !== undefined) parts.push(`stale-if-error=${policy.staleIfError}`);
  return parts.join(', ');
}

/**
 * Cache-Control for anything private or user-specific.
 *
 * `private` alone is not enough for a shared cache that ignores it, so we also
 * set no-store. Every authenticated and every mutating response uses this.
 */
export const NO_STORE = 'no-store, no-cache, must-revalidate, private';

/** Immutable, content-hashed static assets. */
export const IMMUTABLE_ASSET = 'public, max-age=31536000, immutable';

// -----------------------------------------------------------------------------
// ETags
// -----------------------------------------------------------------------------

/**
 * A strong ETag derived from the manifest version.
 *
 * Version-derived rather than content-hash-derived on purpose: the database
 * already maintains a monotonic counter that changes exactly when the public
 * wall changes, so we get correct invalidation without hashing a megabyte of
 * JSON on every request.
 */
export function versionETag(kind: string, version: number | string): string {
  return `"${kind}-${version}"`;
}

/**
 * RFC-compliant If-None-Match evaluation.
 *
 * Handles the list form (`"a", "b"`), the wildcard, and the `W/` weak prefix.
 * Getting this wrong means either never returning 304 (wasted bandwidth) or
 * always returning 304 (stale wall forever), so it is worth the few lines.
 */
export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null || header === '') return false;
  const trimmed = header.trim();
  if (trimmed === '*') return true;

  const normalise = (value: string) => value.trim().replace(/^W\//, '');
  const target = normalise(etag);

  return trimmed
    .split(',')
    .map(normalise)
    .some((candidate) => candidate === target);
}

export function notModified(etag: string, cacheControl: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      'Cache-Control': cacheControl,
    },
  });
}

// -----------------------------------------------------------------------------
// KV-backed cached payloads
// -----------------------------------------------------------------------------

export interface CachedPayload<T> {
  readonly value: T;
  readonly version: number;
  readonly generatedAt: string;
}

export interface KvCacheOptions<T> {
  readonly kv: KVNamespace;
  readonly key: string;
  /** Rebuilds from the database. Called only on a miss or when dirty. */
  readonly rebuild: () => Promise<CachedPayload<T>>;
  /** KV TTL. A safety net; correctness comes from explicit invalidation. */
  readonly ttlSeconds: number;
  readonly onError?: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * Read a payload from KV, rebuilding from the database on a miss.
 *
 * Returns `{ payload, source }` so the caller can log the hit rate — the single
 * most important number for whether the cost model holds at scale.
 */
export async function readCachedPayload<T>(
  options: KvCacheOptions<T>,
): Promise<{ payload: CachedPayload<T>; source: 'kv' | 'origin' }> {
  try {
    const cached = await options.kv.get(options.key, 'json');
    if (cached !== null && isCachedPayload<T>(cached)) {
      return { payload: cached, source: 'kv' };
    }
  } catch (error) {
    options.onError?.(error, { key: options.key, stage: 'kv_read' });
  }

  const fresh = await options.rebuild();

  // Write-behind: a failed cache write must not fail the request. The next
  // reader simply rebuilds.
  try {
    await options.kv.put(options.key, JSON.stringify(fresh), {
      expirationTtl: Math.max(60, options.ttlSeconds),
    });
  } catch (error) {
    options.onError?.(error, { key: options.key, stage: 'kv_write' });
  }

  return { payload: fresh, source: 'origin' };
}

function isCachedPayload<T>(value: unknown): value is CachedPayload<T> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    'value' in candidate &&
    typeof candidate.version === 'number' &&
    typeof candidate.generatedAt === 'string'
  );
}

export async function writeCachedPayload<T>(
  kv: KVNamespace,
  key: string,
  payload: CachedPayload<T>,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(key, JSON.stringify(payload), { expirationTtl: Math.max(60, ttlSeconds) });
}

/**
 * Invalidate a KV key.
 *
 * Deleting rather than overwriting is deliberate: an overwrite races with an
 * in-flight rebuild and could reinstate older content, whereas a delete makes
 * the next reader rebuild from the database.
 */
export async function invalidateCachedPayload(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

// -----------------------------------------------------------------------------
// Cloudflare Cache API
// -----------------------------------------------------------------------------

/**
 * Store a public response in the colo's cache so subsequent requests in the same
 * region never enter our code at all.
 *
 * Only ever called for responses that are already safe to share: no Set-Cookie,
 * no Authorization-dependent content, no user data. `assertCacheable` enforces
 * that rather than relying on the caller remembering.
 */
export function assertCacheable(response: Response): void {
  if (response.headers.has('Set-Cookie')) {
    throw new Error('Refusing to cache a response with Set-Cookie');
  }
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (cacheControl.includes('private') || cacheControl.includes('no-store')) {
    throw new Error('Refusing to cache a response marked private/no-store');
  }
}

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Wraps the global `caches.default`, or a no-op where the Cache API is absent. */
export function edgeCache(): EdgeCache {
  const store = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
  if (!store) {
    return {
      match: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
    };
  }
  return {
    match: (request) => store.match(request),
    put: async (request, response) => {
      assertCacheable(response);
      await store.put(request, response);
    },
  };
}
