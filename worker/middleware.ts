/**
 * Global middleware.
 *
 * Order is load-bearing and is asserted by tests/integration/middleware.test.ts:
 *
 *   1. requestContext  — correlation id, logger, IP, cookie jar. Everything else
 *                        depends on these existing.
 *   2. bodyLimit       — reject oversized bodies before parsing anything.
 *   3. originAndCsrf   — for mutating methods only. Runs BEFORE any handler so a
 *                        forged cross-site request never reaches business logic.
 *   4. securityHeaders — applied on the way out, to every response including
 *                        errors and 404s.
 *
 * Rate limiting is per-route rather than global, because the right limit for
 * "create a Checkout Session" and "load the wall manifest" differ by orders of
 * magnitude. A global circuit breaker on mutations is applied here.
 */

import type { MiddlewareHandler } from 'hono';
import {
  CORRELATION_HEADER,
  CSRF_TTL_SECONDS,
  VISITOR_COOKIE_TTL_SECONDS,
} from '@shared/constants';
import type { AppContext, AppEnv } from './context';
import { ApiError } from './lib/errors';
import { createLogger } from './lib/logger';
import { randomHex, randomToken } from './lib/crypto';
import { getClientIp, ipBucketKey, toNetworkPrefix, userAgentFamily } from './lib/client-ip';
import {
  allowedOrigins,
  checkOrigin,
  corsHeaders,
  newCspNonce,
  securityHeaders,
} from './lib/http-security';
import { issueCsrfToken, readCsrfHeader, requiresCsrf, verifyCsrf } from './lib/csrf';
import { createCookieJar } from './lib/auth';
import { csrfCookie, readCookie, visitorCookie } from './lib/cookies';
import { auditSecurityEvent } from './lib/audit';
import { currentUser } from './context';
import { COOKIE_CSRF, COOKIE_VISITOR } from '@shared/constants';
import type { Deps } from './context';

/** Largest JSON body we will read. Uploads go direct to the image provider. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** The Stripe webhook body can be larger; still bounded. */
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

export interface RequestContextOptions {
  readonly deps: Deps;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

export function requestContext(options: RequestContextOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { deps } = options;

    // Prefer Cloudflare's ray id so a log line can be correlated with
    // Cloudflare's own logs; fall back to a random id locally.
    const requestId = c.req.header('CF-Ray')?.slice(0, 32) ?? randomHex(8);
    const clientIp = getClientIp(c.req.raw, deps.config.isProduction);
    const ipPrefix = toNetworkPrefix(clientIp);
    const uaFamily = userAgentFamily(c.req.raw);

    const logger = createLogger({
      requestId,
      environment: deps.config.environment,
      base: {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        ipPrefix,
        uaFamily,
        colo: c.req.header('CF-IPCountry') ?? undefined,
      },
    });

    const jar = createCookieJar(c.req.raw, deps.config);

    c.set('requestId', requestId);
    c.set('logger', logger);
    c.set('deps', deps);
    c.set('cspNonce', newCspNonce());
    c.set('clientIp', clientIp);
    c.set('ipPrefix', ipPrefix);
    c.set('userAgentFamily', uaFamily);
    c.set('cookieJar', jar);
    c.set('visitorId', readCookie(c.req.raw, COOKIE_VISITOR));
    c.set('auditContext', {
      db: deps.db,
      logger,
      requestId,
      ipPrefix,
      userAgentFamily: uaFamily,
      waitUntil: options.waitUntil,
    });

    const startedAt = Date.now();
    await next();

    // Correlation id on every response, so a user can quote it to support.
    c.res.headers.set(CORRELATION_HEADER, requestId);

    // Apply any cookies Supabase asked us to write during the request.
    for (const cookie of jar.headers()) {
      c.res.headers.append('Set-Cookie', cookie);
    }

    const durationMs = Date.now() - startedAt;
    // Log at info for mutations and errors, debug for routine reads, so
    // production logs stay affordable.
    const level = c.res.status >= 400 || c.req.method !== 'GET' ? 'info' : 'debug';
    logger[level]('request_complete', { status: c.res.status, durationMs });
  };
}

/**
 * Reject oversized bodies before anything parses them.
 *
 * Content-Length can be absent or lie, so this is a first filter; the actual
 * read is also bounded by the runtime. Its real value is cheap rejection of an
 * obvious flood.
 */
export function bodyLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();

    const isWebhook = new URL(c.req.url).pathname === '/api/stripe/webhook';
    const limit = isWebhook ? MAX_WEBHOOK_BODY_BYTES : MAX_JSON_BODY_BYTES;

    const declared = c.req.header('Content-Length');
    if (declared !== undefined) {
      const size = Number.parseInt(declared, 10);
      if (Number.isSafeInteger(size) && size > limit) {
        throw new ApiError('payload_too_large', {
          logContext: { declaredBytes: size, limit },
        });
      }
    }

    return next();
  };
}

/**
 * Origin validation and CSRF for state-changing requests.
 *
 * Exemptions, each justified:
 *   * `/api/stripe/webhook` — a server-to-server call with no browser, no
 *     cookies and therefore no CSRF exposure. It is authenticated by an HMAC
 *     signature instead, which is strictly stronger.
 *   * `/api/auth/callback` — a GET, so not covered anyway.
 */
export function originAndCsrf(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!requiresCsrf(c.req.method)) return next();

    const pathname = new URL(c.req.url).pathname;
    if (pathname === '/api/stripe/webhook') return next();

    const deps = c.get('deps');
    const audit = c.get('auditContext');
    const origins = allowedOrigins(deps.config);

    const origin = checkOrigin(c.req.raw, origins);
    if (!origin.ok) {
      auditSecurityEvent(audit, 'security.origin_rejected', {
        reason: origin.reason,
        path: pathname,
        // The received origin is logged (not echoed to the client) so a
        // legitimate misconfiguration is diagnosable.
        received: c.req.header('Origin') ?? null,
      });
      throw new ApiError('origin_rejected', { logContext: { reason: origin.reason } });
    }

    // The CSRF token is bound to the session, so we need to know who the caller
    // claims to be before we can validate it.
    const user = await currentUser(c);

    const result = await verifyCsrf({
      secret: deps.config.signingSecret,
      headerToken: readCsrfHeader(c.req.raw),
      cookieToken: readCookie(c.req.raw, COOKIE_CSRF),
      userId: user?.id ?? null,
    });

    if (!result.ok) {
      auditSecurityEvent(
        audit,
        'security.csrf_rejected',
        { reason: result.reason, path: pathname },
        user?.id ?? null,
      );
      throw new ApiError('csrf_failed', { logContext: { reason: result.reason } });
    }

    return next();
  };
}

/**
 * Global circuit breaker on mutating traffic, per source.
 *
 * Per-endpoint limits stop a targeted attack on one expensive route; this stops
 * a broad spray across many routes from adding up to the same thing.
 */
export function mutationCircuitBreaker(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!requiresCsrf(c.req.method)) return next();
    if (new URL(c.req.url).pathname === '/api/stripe/webhook') return next();

    const deps = c.get('deps');
    const key = await ipBucketKey(c.get('clientIp'), deps.config.signingSecret, 'mutation');
    const decision = await deps.rateLimiter.consume('mutationGlobal', key);

    if (!decision.allowed) {
      auditSecurityEvent(c.get('auditContext'), 'security.rate_limited', {
        policy: 'mutationGlobal',
        path: new URL(c.req.url).pathname,
      });
      throw new ApiError('rate_limited', {
        retryAfter: decision.retryAfter,
        logContext: { policy: 'mutationGlobal' },
      });
    }

    return next();
  };
}

/**
 * Security headers + CORS on the way out.
 *
 * Runs for EVERY response, including ones produced by the error handler, which
 * is why it is a middleware rather than something each route remembers.
 */
export function responseHardening(enableHsts: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();

    const deps = c.get('deps');
    const pathname = new URL(c.req.url).pathname;
    const isApi = pathname.startsWith('/api/');

    const headers = securityHeaders({
      config: deps.config,
      nonce: c.get('cspNonce'),
      isApi,
      enableHsts,
    });

    for (const [key, value] of Object.entries(headers)) {
      // Do not clobber a header a route set deliberately (e.g. a redirect's own
      // CSP-free response).
      if (!c.res.headers.has(key)) c.res.headers.set(key, value);
    }

    for (const [key, value] of Object.entries(corsHeaders(c.req.raw, deps.config))) {
      c.res.headers.set(key, value);
    }
  };
}

/**
 * Attach the CSRF and visitor cookies to a response.
 *
 * NOT a middleware, and deliberately so.
 *
 * The HTML document is served from Cloudflare's asset layer and is edge-cached,
 * so it must never carry a Set-Cookie — a cached response with someone else's
 * cookie in it is a session-leak bug waiting to happen. Instead the client calls
 * `GET /api/auth/session` on boot, which is uncacheable, and that response
 * carries both cookies.
 *
 * The CSRF token is bound to whoever is signed in at that moment, which is why
 * it has to be minted after the session is resolved rather than blindly on
 * every navigation.
 */
export async function attachBrowserCookies(c: AppContext, userId: string | null): Promise<string> {
  const deps = c.get('deps');
  const ctx = { isProduction: deps.config.isProduction };

  const token = await issueCsrfToken(deps.config.signingSecret, userId);
  c.res.headers.append('Set-Cookie', csrfCookie(token, ctx, CSRF_TTL_SECONDS));

  if (c.get('visitorId') === null) {
    const fresh = randomToken(16);
    c.set('visitorId', fresh);
    c.res.headers.append('Set-Cookie', visitorCookie(fresh, ctx, VISITOR_COOKIE_TTL_SECONDS));
  }

  // This response sets cookies, so it must never be shared by a cache.
  c.res.headers.set('Cache-Control', 'no-store, private');
  return token;
}
