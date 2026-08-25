/**
 * The Hono application.
 *
 * Exported as `createApp(deps)` rather than as a module-level singleton so that
 * tests can drive the real router with fake dependencies:
 *
 *   const app = createApp(fakeDeps());
 *   const res = await app.request('/api/checkout/session', { method: 'POST', ... });
 *
 * That is why every integration test in this repo exercises the actual
 * middleware chain — CSRF, origin checks, rate limits, error mapping — instead of
 * calling handler functions directly and hoping the middleware would have run.
 */

import { Hono } from 'hono';
import type { AppEnv, Deps } from './context';
import { ApiError, describeUnknownError, mapDatabaseError } from './lib/errors';
import { RpcError } from './lib/supabase';
import { ConfigError } from './env';
import {
  bodyLimit,
  mutationCircuitBreaker,
  originAndCsrf,
  requestContext,
  responseHardening,
} from './middleware';
import { NO_STORE } from './lib/cache';
import { authRoutes } from './routes/auth';
import { publicRoutes } from './routes/public';
import { reservationRoutes } from './routes/reservations';
import { uploadRoutes } from './routes/uploads';
import { checkoutRoutes } from './routes/checkout';
import { stripeWebhookRoutes } from './routes/stripe-webhook';
import { dashboardRoutes } from './routes/dashboard';
import { adminRoutes } from './routes/admin';
import { goRoutes } from './routes/go';
import { seoRoutes } from './routes/seo';

export interface CreateAppOptions {
  readonly deps: Deps;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /**
   * HSTS is opt-in per deployment. Enabling it before the domain reliably serves
   * HTTPS locks visitors out for a year, so DEPLOYMENT.md turns it on as an
   * explicit late step.
   */
  readonly enableHsts?: boolean;
}

export function createApp(options: CreateAppOptions) {
  const app = new Hono<AppEnv>();

  // --- global middleware, in order --------------------------------------------
  app.use('*', requestContext({ deps: options.deps, waitUntil: options.waitUntil }));
  app.use('*', responseHardening(options.enableHsts ?? options.deps.config.isProduction));
  app.use('*', bodyLimit());
  app.use('/api/*', mutationCircuitBreaker());
  app.use('/api/*', originAndCsrf());

  // --- CORS preflight ---------------------------------------------------------
  // Same-origin only, so a preflight is answered by the header middleware and
  // needs no per-route handling. 204 with no body.
  app.options('/api/*', (c) => c.body(null, 204));

  // --- routes -----------------------------------------------------------------
  app.route('/api/auth', authRoutes);
  app.route('/api/public', publicRoutes);
  app.route('/api/reservations', reservationRoutes);
  app.route('/api/uploads', uploadRoutes);
  app.route('/api/checkout', checkoutRoutes);
  app.route('/api/stripe/webhook', stripeWebhookRoutes);
  app.route('/api/dashboard', dashboardRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/go', goRoutes);
  app.route('/', seoRoutes);

  // --- liveness ---------------------------------------------------------------
  // Deliberately says almost nothing. A health endpoint that reports versions,
  // dependency status or configuration is a reconnaissance gift.
  app.get('/api/health', (c) =>
    c.json({ ok: true, environment: c.get('deps').config.environment }, 200, {
      'Cache-Control': NO_STORE,
    }),
  );

  // --- 404 for unmatched API routes -------------------------------------------
  // Anything not under /api or /go is a client route and is handled by the asset
  // layer's SPA fallback, so this only fires for genuinely unknown API paths.
  app.notFound((c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/api/') || pathname.startsWith('/go/')) {
      return c.json(
        {
          error: {
            code: 'not_found',
            message: 'We could not find that.',
            requestId: c.get('requestId') ?? 'unknown',
          },
        },
        404,
        { 'Cache-Control': NO_STORE },
      );
    }
    return c.json(
      { error: { code: 'not_found', message: 'Not found', requestId: 'unknown' } },
      404,
    );
  });

  // --- the single error boundary ----------------------------------------------
  /**
   * Every thrown error becomes a sanitised response here.
   *
   * The contract: the client gets a stable code, a short human sentence and a
   * request id. The log gets everything else. There is no path by which a stack
   * trace, a SQL message, or a provider response body reaches a browser.
   */
  app.onError((error, c) => {
    const logger = c.get('logger');
    const requestId = c.get('requestId') ?? 'unknown';

    // 1. Errors we raised deliberately.
    if (error instanceof ApiError) {
      const level = error.status >= 500 ? 'error' : 'warn';
      logger?.[level]('request_failed', {
        code: error.code,
        status: error.status,
        ...error.logContext,
        ...(error.cause !== undefined ? { cause: describeUnknownError(error.cause) } : {}),
      });

      const headers: Record<string, string> = { 'Cache-Control': NO_STORE };
      if (error.retryAfter !== undefined) headers['Retry-After'] = String(error.retryAfter);

      return c.json(error.toBody(requestId), error.status as 400, headers);
    }

    // 2. Configuration problems: a missing secret must be a loud 503, never a
    //    silently degraded security control.
    if (error instanceof ConfigError) {
      // Names only. Never values.
      logger?.error('configuration_invalid', { missing: error.missing, severity: 'critical' });
      return c.json(
        {
          error: {
            code: 'maintenance',
            message: 'HQPixels is briefly unavailable. Please try again in a few minutes.',
            requestId,
          },
        },
        503,
        { 'Cache-Control': NO_STORE, 'Retry-After': '120' },
      );
    }

    // 3. Database/RPC failures. `mapDatabaseError` recognises the named
    //    exceptions our migrations raise and turns the rest into a generic 500.
    if (error instanceof RpcError) {
      const mapped = mapDatabaseError(error, { rpc: error.fn, rpcStatus: error.status });
      logger?.error('database_error', {
        rpc: error.fn,
        status: error.status,
        code: mapped.code,
        ...mapped.logContext,
      });
      return c.json(mapped.toBody(requestId), mapped.status as 500, { 'Cache-Control': NO_STORE });
    }

    // 4. Anything else. Log fully, tell the user nothing.
    logger?.error('unhandled_error', {
      ...describeUnknownError(error),
      severity: 'high',
    });

    return c.json(
      {
        error: {
          code: 'internal_error',
          message: 'Something went wrong on our side. Quote this reference if you contact us.',
          requestId,
        },
      },
      500,
      { 'Cache-Control': NO_STORE },
    );
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
