/**
 * Public read endpoints — the only high-volume path in the system.
 *
 * Everything here must be servable without touching Postgres on a warm cache.
 * The chain is: edge cache -> KV -> database rebuild. A 304 from a conditional
 * request is the common case for a returning visitor.
 *
 * Nothing here is authenticated and nothing here reveals buyer identity, so
 * these responses are safe to share in a public cache. `assertCacheable` in
 * cache.ts enforces the "no Set-Cookie on a cacheable response" rule.
 */

import { Hono } from 'hono';
import {
  KV_KEY_MANIFEST,
  KV_KEY_RANKINGS,
  KV_KEY_STATS,
  MANIFEST_MAX_AGE_SECONDS,
  MANIFEST_SWR_SECONDS,
  RANKINGS_MAX_AGE_SECONDS,
  RANKINGS_SWR_SECONDS,
  STATS_MAX_AGE_SECONDS,
  STATS_SWR_SECONDS,
  TOTAL_CELLS,
} from '@shared/constants';
import { abuseReportSchema, placementIdParamSchema, quoteQuerySchema } from '@shared/schemas';
import { computeQuote, type PricingVersion } from '@shared/pricing';
import type { AppEnv } from '../context';
import { ApiError, validationFailed, zodFieldErrors } from '../lib/errors';
import {
  matchesIfNoneMatch,
  notModified,
  publicCacheControl,
  readCachedPayload,
  versionETag,
  NO_STORE,
} from '../lib/cache';
import { absoluteImageUrl } from '../lib/images';
import { audit, auditSecurityEvent } from '../lib/audit';
import { ipBucketKey, looksAutomated } from '../lib/client-ip';
import { surfaceForPath } from '../lib/analytics';
import { pricingVersionFromRow } from '../lib/pricing-adapter';

export const publicRoutes = new Hono<AppEnv>();

// -----------------------------------------------------------------------------
// GET /api/public/wall-manifest
// -----------------------------------------------------------------------------
publicRoutes.get('/wall-manifest', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');

  const { payload, source } = await readCachedPayload<Record<string, unknown>>({
    kv: deps.cacheKv,
    key: KV_KEY_MANIFEST,
    ttlSeconds: 3600,
    onError: (error, ctx) => logger.warn('manifest_cache_error', { ...ctx, error: String(error) }),
    rebuild: async () => {
      const manifest = await deps.db.buildWallManifest();
      const version = typeof manifest.manifestVersion === 'number' ? manifest.manifestVersion : 0;
      return {
        value: withAbsoluteImageUrls(manifest, deps.config),
        version,
        generatedAt: new Date(deps.now()).toISOString(),
      };
    },
  });

  const etag = versionETag('manifest', payload.version);
  const cacheControl = publicCacheControl({
    maxAge: MANIFEST_MAX_AGE_SECONDS,
    staleWhileRevalidate: MANIFEST_SWR_SECONDS,
    staleIfError: 86_400,
  });

  // The whole point of the version-derived ETag: a returning visitor's poll is
  // a few hundred bytes instead of the full manifest.
  if (matchesIfNoneMatch(c.req.header('If-None-Match') ?? null, etag)) {
    logger.debug('manifest_not_modified', { source, version: payload.version });
    return notModified(etag, cacheControl);
  }

  logger.debug('manifest_served', { source, version: payload.version });

  return c.json(payload.value, 200, {
    ETag: etag,
    'Cache-Control': cacheControl,
    // The manifest varies by nothing. Being explicit stops a proxy from
    // inventing a Vary and fragmenting the cache.
    Vary: 'Accept-Encoding',
  });
});

/**
 * The database emits a provider-relative `imagePath`; the browser needs an
 * absolute URL. Done here rather than in SQL so the delivery hostname stays in
 * configuration and switching image providers is not a data migration.
 */
function withAbsoluteImageUrls(
  manifest: Record<string, unknown>,
  config: import('../env').AppConfig,
): Record<string, unknown> {
  const placements = Array.isArray(manifest.placements) ? manifest.placements : [];

  return {
    ...manifest,
    placements: placements.map((entry) => {
      const placement = entry as Record<string, unknown>;
      const path = typeof placement.imagePath === 'string' ? placement.imagePath : null;
      const { imagePath: _imagePath, ...rest } = placement;
      return {
        ...rest,
        image: absoluteImageUrl(config, path),
        // Every placement in the manifest is, by definition, paid and approved.
        verified: true,
      };
    }),
  };
}

// -----------------------------------------------------------------------------
// GET /api/public/manifest-version
// -----------------------------------------------------------------------------
// Ultra-cheap freshness probe for a visible tab. Cached for 15s so a tab polling
// once a minute costs essentially nothing.
publicRoutes.get('/manifest-version', async (c) => {
  const deps = c.get('deps');

  const cached = await deps.cacheKv.get(KV_KEY_MANIFEST, 'json').catch(() => null);
  const version =
    cached !== null && typeof (cached as { version?: unknown }).version === 'number'
      ? (cached as { version: number }).version
      : await deps.db.manifestVersion();

  return c.json({ manifestVersion: version }, 200, {
    'Cache-Control': publicCacheControl({ maxAge: 15, staleWhileRevalidate: 60 }),
    ETag: versionETag('mv', version),
  });
});

// -----------------------------------------------------------------------------
// GET /api/public/stats
// -----------------------------------------------------------------------------
publicRoutes.get('/stats', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');

  const { payload, source } = await readCachedPayload<Record<string, unknown>>({
    kv: deps.cacheKv,
    key: KV_KEY_STATS,
    ttlSeconds: 900,
    onError: (error, ctx) => logger.warn('stats_cache_error', { ...ctx, error: String(error) }),
    rebuild: async () => {
      const stats = await deps.db.publicStats();
      return {
        value: stats,
        // Stats have no natural version; use the generation minute so the ETag
        // changes at the same cadence as the cache.
        version: Math.floor(deps.now() / 60_000),
        generatedAt: new Date(deps.now()).toISOString(),
      };
    },
  });

  const etag = versionETag('stats', payload.version);
  const cacheControl = publicCacheControl({
    maxAge: STATS_MAX_AGE_SECONDS,
    staleWhileRevalidate: STATS_SWR_SECONDS,
    staleIfError: 86_400,
  });

  if (matchesIfNoneMatch(c.req.header('If-None-Match') ?? null, etag)) {
    return notModified(etag, cacheControl);
  }

  logger.debug('stats_served', { source });
  return c.json(payload.value, 200, { ETag: etag, 'Cache-Control': cacheControl });
});

// -----------------------------------------------------------------------------
// GET /api/public/rankings
// -----------------------------------------------------------------------------
publicRoutes.get('/rankings', async (c) => {
  const deps = c.get('deps');

  const { payload } = await readCachedPayload<Record<string, unknown>>({
    kv: deps.cacheKv,
    key: KV_KEY_RANKINGS,
    ttlSeconds: 3600,
    rebuild: async () => {
      const boards = await deps.db.latestLeaderboards();
      return {
        value: boards,
        version: Math.floor(deps.now() / 300_000),
        generatedAt: new Date(deps.now()).toISOString(),
      };
    },
  });

  const etag = versionETag('rankings', payload.version);
  const cacheControl = publicCacheControl({
    maxAge: RANKINGS_MAX_AGE_SECONDS,
    staleWhileRevalidate: RANKINGS_SWR_SECONDS,
    staleIfError: 86_400,
  });

  if (matchesIfNoneMatch(c.req.header('If-None-Match') ?? null, etag)) {
    return notModified(etag, cacheControl);
  }

  return c.json(payload.value, 200, { ETag: etag, 'Cache-Control': cacheControl });
});

// -----------------------------------------------------------------------------
// GET /api/public/pricing
// -----------------------------------------------------------------------------
publicRoutes.get('/pricing', async (c) => {
  const deps = c.get('deps');
  const row = await deps.db.activePricingVersion();

  if (row === null) {
    throw new ApiError('maintenance', {
      message: 'Pricing is being updated. Please try again in a moment.',
      logContext: { reason: 'no_active_pricing_version', severity: 'critical' },
    });
  }

  const pricing = pricingVersionFromRow(row);

  return c.json(
    {
      version: pricing.version,
      currency: pricing.currency,
      centsPerLogicalPixel: pricing.centsPerLogicalPixel,
      minimumPurchaseCents: pricing.centsPerLogicalPixel * 100,
      zoneMultipliers: pricing.zoneMultipliers,
      minCells: pricing.minCells,
      maxCells: pricing.maxCells,
      reservationTtlSeconds: pricing.reservationTtlSeconds,
      grid: { size: 100, cellLogicalSize: 10, totalCells: TOTAL_CELLS },
    },
    200,
    { 'Cache-Control': publicCacheControl({ maxAge: 300, staleWhileRevalidate: 3600 }) },
  );
});

// -----------------------------------------------------------------------------
// GET /api/public/quote
// -----------------------------------------------------------------------------
// A price preview plus a *hint* about availability. Explicitly NOT a reservation:
// the response says so, and the reservation RPC re-checks everything, because
// between this call and a claim another buyer may win the race.
publicRoutes.get('/quote', async (c) => {
  const deps = c.get('deps');

  const parsed = quoteQuerySchema.safeParse({
    x: c.req.query('x'),
    y: c.req.query('y'),
    w: c.req.query('w'),
    h: c.req.query('h'),
  });
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }

  const row = await deps.db.activePricingVersion();
  if (row === null) throw new ApiError('maintenance');

  const pricing = pricingVersionFromRow(row);
  const rect = parsed.data;

  let quote;
  try {
    quote = computeQuote(pricing, rect);
  } catch (error) {
    throw validationFailed({
      message: error instanceof Error ? error.message : 'That selection is not valid.',
      logContext: { rect },
    });
  }

  const unavailable = await deps.db.unavailableCells(rect.x, rect.y, rect.w, rect.h, 50);

  return c.json(
    {
      quote,
      unavailableCells: unavailable.map((cell) => ({ x: cell.cell_x, y: cell.cell_y })),
      available: unavailable.length === 0,
      reservationTtlSeconds: pricing.reservationTtlSeconds,
      // Stated plainly so no client treats this as a hold.
      note: 'A quote is not a reservation. Units are only held once you claim them.',
    },
    200,
    // Availability changes constantly; a stale quote would mislead.
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// POST /api/public/view
// -----------------------------------------------------------------------------
/**
 * Page-view beacon.
 *
 * Honesty note, which is also written on the /stats page: this counter is
 * incremented by the browser reporting its own page load. It is filtered for
 * obvious automation and rate limited per visitor cookie, but it is not an
 * audited figure, and the UI therefore labels it "Total page views" — never
 * "visitors" and never "people".
 *
 * Counting server-side on the document request would be more trustworthy, but
 * the document is served from the edge cache specifically so a traffic spike
 * costs nothing; the honest label is the better trade.
 *
 * The write goes to a Durable Object buffer, so this endpoint performs no
 * database work at all.
 */
publicRoutes.post('/view', async (c) => {
  const deps = c.get('deps');

  // Same-origin only. Prevents a third-party page from inflating our counter.
  const origin = c.req.header('Origin');
  if (origin !== deps.config.siteOrigin && deps.config.isProduction) {
    // Silently accepted-and-discarded: a 403 here would just tell a spammer to
    // change one header.
    return c.body(null, 204);
  }

  const visitorId = c.get('visitorId');
  const bucketKey = await ipBucketKey(
    visitorId ?? c.get('clientIp'),
    deps.config.signingSecret,
    'view',
  );
  const decision = await deps.rateLimiter.consume('clickRedirect', bucketKey);

  const automated = looksAutomated(c.req.raw);
  const body = await c.req.json<{ path?: string }>().catch(() => ({} as { path?: string }));
  const path = typeof body.path === 'string' && body.path.length < 200 ? body.path : '/';

  // Over-limit or automated traffic is recorded as `filtered`, so the excluded
  // volume is visible internally rather than silently vanishing.
  deps.analytics.recordView(surfaceForPath(path), automated || !decision.allowed);

  return c.body(null, 204, { 'Cache-Control': NO_STORE });
});

// -----------------------------------------------------------------------------
// POST /api/public/impressions
// -----------------------------------------------------------------------------
// Which placements were actually in the viewport. Labelled an estimate in the
// buyer dashboard, because that is what it is.
publicRoutes.post('/impressions', async (c) => {
  const deps = c.get('deps');

  if (deps.config.isProduction && c.req.header('Origin') !== deps.config.siteOrigin) {
    return c.body(null, 204);
  }

  const visitorId = c.get('visitorId');
  const bucketKey = await ipBucketKey(
    visitorId ?? c.get('clientIp'),
    deps.config.signingSecret,
    'impressions',
  );
  const decision = await deps.rateLimiter.consume('clickRedirect', bucketKey);
  if (!decision.allowed || looksAutomated(c.req.raw)) return c.body(null, 204);

  const body = await c.req
    .json<{ placementIds?: string[] }>()
    .catch(() => ({} as { placementIds?: string[] }));

  if (!Array.isArray(body.placementIds)) return c.body(null, 204);

  const ids = body.placementIds
    .filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, 200);

  deps.analytics.recordImpressions(ids);
  return c.body(null, 204, { 'Cache-Control': NO_STORE });
});

// -----------------------------------------------------------------------------
// POST /api/public/report
// -----------------------------------------------------------------------------
// Abuse reporting, open to anonymous visitors on purpose: requiring an account
// to report malware would mean malware stays up longer.
publicRoutes.post('/report', async (c) => {
  const deps = c.get('deps');
  const auditCtx = c.get('auditContext');

  const body = await c.req.json().catch(() => null);
  const parsed = abuseReportSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }

  const turnstile = await deps.verifyTurnstile({
    token: parsed.data.turnstileToken,
    action: 'abuse-report',
    remoteIp: c.get('clientIp'),
  });
  if (!turnstile.ok) {
    auditSecurityEvent(auditCtx, 'security.turnstile_rejected', {
      action: 'abuse-report',
      reason: turnstile.reason,
    });
    throw new ApiError('turnstile_failed', { logContext: { reason: turnstile.reason } });
  }

  const key = await ipBucketKey(c.get('clientIp'), deps.config.signingSecret, 'abuse');
  const decision = await deps.rateLimiter.consume('abuseReport', key);
  if (!decision.allowed) {
    throw new ApiError('rate_limited', { retryAfter: decision.retryAfter });
  }

  const result = await deps.db.fileAbuseReport({
    placementId: parsed.data.placementId,
    category: parsed.data.category,
    details: parsed.data.details,
    ipPrefix: c.get('ipPrefix'),
    reporterId: null,
  });

  audit(auditCtx, {
    action: 'abuse.reported',
    targetType: 'placement',
    targetId: parsed.data.placementId,
    detail: {
      category: parsed.data.category,
      autoDisabled: 'autoDisabled' in result ? Boolean(result.autoDisabled) : false,
    },
  });

  // Always the same answer, whether or not the placement exists. Otherwise this
  // endpoint becomes an oracle for enumerating placement ids.
  return c.json(
    { received: true, message: 'Thank you. Our moderation team will review this.' },
    202,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// GET /api/public/placement/:placementId
// -----------------------------------------------------------------------------
// Public detail for the accessible list view and share cards. Serves only what
// is already in the manifest, from the manifest cache, so it adds no database load.
publicRoutes.get('/placement/:placementId', async (c) => {
  const deps = c.get('deps');

  const parsed = placementIdParamSchema.safeParse({ placementId: c.req.param('placementId') });
  if (!parsed.success) throw new ApiError('not_found');

  const cached = await deps.cacheKv.get(KV_KEY_MANIFEST, 'json').catch(() => null);
  const manifest =
    cached !== null
      ? ((cached as { value?: unknown }).value as Record<string, unknown> | undefined)
      : undefined;

  const placements = Array.isArray(manifest?.placements) ? manifest.placements : [];
  const match = placements.find(
    (entry) => (entry as { id?: unknown }).id === parsed.data.placementId,
  );

  if (match === undefined) throw new ApiError('not_found');

  return c.json(match, 200, {
    'Cache-Control': publicCacheControl({
      maxAge: MANIFEST_MAX_AGE_SECONDS,
      staleWhileRevalidate: MANIFEST_SWR_SECONDS,
    }),
  });
});

export type PublicPricingVersion = PricingVersion;
