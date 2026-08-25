/**
 * Worker entry point.
 *
 * Responsibilities, and nothing else:
 *   * validate configuration (fail closed on a missing secret)
 *   * build the request-scoped dependency graph
 *   * hand the request to the Hono app
 *   * dispatch cron triggers
 *   * export the Durable Object classes
 *
 * Deliberately thin. All behaviour lives in app.ts and the routes, which are
 * testable without workerd.
 */

import type { ExecutionContext, ScheduledEvent } from '@cloudflare/workers-types/2023-07-01';
import { createApp } from './app';
import type { Deps } from './context';
import { ConfigError, loadConfig, type Env } from './env';
import { createLogger } from './lib/logger';
import { randomHex } from './lib/crypto';
import { createDb, createRpcCaller } from './lib/supabase';
import { DurableObjectRateLimiter, KvRateLimiter, type RateLimiter } from './lib/rate-limit';
import { createImageClient } from './lib/images';
import { createStripeClient } from './lib/stripe';
import { verifyTurnstile, turnstileHostnames } from './lib/turnstile';
import { createAuthClient } from './lib/auth';
import { DurableObjectAnalytics, NoopAnalytics, type AnalyticsClient } from './lib/analytics';
import { runScheduled } from './jobs';

export { RateLimiterDO } from './do/rate-limiter';
export { AnalyticsBufferDO } from './do/analytics-buffer';

/**
 * Build the dependency graph for one request (or one cron run).
 *
 * Per-invocation rather than cached at module scope: the isolate is shared
 * between requests, and a cached client holding a request-scoped cookie jar or
 * logger would leak one request's context into another. The objects here are
 * cheap; the Stripe client is additionally lazy because most requests never need
 * it.
 */
function buildDeps(env: Env, ctx: ExecutionContext, logger: ReturnType<typeof createLogger>): Deps {
  const config = loadConfig(env);

  const rpc = createRpcCaller({
    url: config.supabaseUrl,
    serviceKey: config.supabaseServiceKey,
  });
  const db = createDb(rpc);

  // Strong consistency for anything that gates money. The KV limiter is a
  // documented fallback for a deployment without the Durable Object binding.
  const rateLimiter: RateLimiter =
    typeof env.RATE_LIMITER?.idFromName === 'function'
      ? new DurableObjectRateLimiter(env.RATE_LIMITER, (error, context) => {
          logger.error('rate_limiter_error', {
            ...context,
            error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
            severity: 'high',
          });
        })
      : new KvRateLimiter(env.RATE_KV, (error, context) => {
          logger.warn('rate_limiter_error', { ...context, error: String(error) });
        });

  const analytics: AnalyticsClient =
    typeof env.ANALYTICS_BUFFER?.idFromName === 'function'
      ? new DurableObjectAnalytics(
          env.ANALYTICS_BUFFER,
          (promise) => ctx.waitUntil(promise),
          logger,
        )
      : new NoopAnalytics();

  let stripeClient: ReturnType<typeof createStripeClient> | null = null;

  return {
    config,
    db,
    rateLimiter,
    images: createImageClient(config),
    stripe: () => {
      stripeClient ??= createStripeClient(config);
      return stripeClient;
    },
    verifyTurnstile: (input) =>
      verifyTurnstile({
        ...input,
        secret: input.secret ?? config.turnstileSecretKey,
        expectedHostnames:
          input.expectedHostnames ?? turnstileHostnames(config.siteHost, config.isProduction),
      }),
    cacheKv: env.CACHE_KV,
    analytics,
    now: () => Date.now(),
    authClientFor: (jar) => createAuthClient(config, jar),
  };
}

/**
 * Canonical-host redirect.
 *
 * One canonical origin, always. Running on both apex and www would split the
 * cache, break the cookie domain expectations, and give an attacker two origins
 * to play same-origin games with.
 */
function canonicalRedirect(request: Request, siteOrigin: string): Response | null {
  const url = new URL(request.url);

  // Local development uses localhost/127.0.0.1 and must not be redirected.
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return null;

  let canonical: URL;
  try {
    canonical = new URL(siteOrigin);
  } catch {
    return null;
  }

  const needsHostFix = url.hostname !== canonical.hostname;
  const needsSchemeFix = url.protocol !== canonical.protocol;

  if (!needsHostFix && !needsSchemeFix) return null;

  // Never redirect the webhook: Stripe would follow it, but a redirect on a
  // signed POST is a good way to create confusing failures. The endpoint is
  // configured with the canonical URL in the first place.
  if (url.pathname === '/api/stripe/webhook') return null;

  const target = new URL(url.pathname + url.search, canonical.origin);

  return new Response(null, {
    status: 301,
    headers: {
      Location: target.toString(),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get('CF-Ray')?.slice(0, 32) ?? randomHex(8);
    const logger = createLogger({ requestId, environment: env.ENVIRONMENT ?? 'development' });

    let deps: Deps;
    try {
      deps = buildDeps(env, ctx, logger);
    } catch (error) {
      // A missing secret must never degrade into "works but insecure". Names
      // only in the log; nothing about configuration reaches the client.
      if (error instanceof ConfigError) {
        logger.error('startup_configuration_invalid', {
          missing: error.missing,
          severity: 'critical',
        });
      } else {
        logger.error('startup_failed', {
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          severity: 'critical',
        });
      }

      return Response.json(
        {
          error: {
            code: 'maintenance',
            message: 'HQPixels is briefly unavailable. Please try again in a few minutes.',
            requestId,
          },
        },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': '120',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    }

    const redirect = canonicalRedirect(request, deps.config.siteOrigin);
    if (redirect !== null) return redirect;

    const app = createApp({
      deps,
      waitUntil: (promise) => ctx.waitUntil(promise),
      enableHsts: deps.config.isProduction || deps.config.environment === 'staging',
    });

    return app.fetch(request, env, ctx);
  },

  /**
   * Cron dispatch.
   *
   * Each expression maps to a set of jobs in worker/jobs/index.ts. Failures are
   * logged and recorded in `job_runs`; a failing job never prevents the others
   * from running, and never throws out of here (which would make Cloudflare
   * retry the whole batch).
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const requestId = `cron-${randomHex(6)}`;
    const logger = createLogger({
      requestId,
      environment: env.ENVIRONMENT ?? 'development',
      base: { cron: event.cron },
    });

    try {
      const deps = buildDeps(env, ctx, logger);
      await runScheduled(event.cron, deps, logger);
    } catch (error) {
      logger.error('scheduled_dispatch_failed', {
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
        severity: 'critical',
      });
    }
  },
};
