/**
 * Request context and dependency injection.
 *
 * Everything the routes need arrives as `Deps`. Nothing reaches for a global or
 * for `env` directly. That is what makes `tests/integration/*.test.ts` able to
 * drive real HTTP requests through the real router with fake Supabase, Stripe,
 * Turnstile and KV — no network, no workerd, no test containers.
 */

import type { Context } from 'hono';
import type Stripe from 'stripe';
import type { KVNamespace } from '@cloudflare/workers-types/2023-07-01';
import type { AppConfig } from './env';
import type { Db } from './lib/supabase';
import type { RateLimiter } from './lib/rate-limit';
import type { ImageClient } from './lib/images';
import type { AnalyticsClient } from './lib/analytics';
import type { Logger } from './lib/logger';
import type { AuthenticatedUser, CookieJar } from './lib/auth';
import type { AuditContext } from './lib/audit';
import type { TurnstileResult, TurnstileVerifyInput } from './lib/turnstile';
import { ApiError, unauthenticated, forbidden } from './lib/errors';
import { resolveSession } from './lib/auth';
import { auditSecurityEvent } from './lib/audit';

/** Injectable Turnstile verifier, so tests do not hit Cloudflare. */
export type TurnstileVerifier = (
  input: Omit<TurnstileVerifyInput, 'secret' | 'expectedHostnames'> & {
    secret?: string;
    expectedHostnames?: readonly string[];
  },
) => Promise<TurnstileResult>;

export interface Deps {
  readonly config: AppConfig;
  readonly db: Db;
  readonly rateLimiter: RateLimiter;
  readonly images: ImageClient;
  /** Lazy: the Stripe client is only constructed for routes that need it. */
  readonly stripe: () => Stripe;
  readonly verifyTurnstile: TurnstileVerifier;
  readonly cacheKv: KVNamespace;
  readonly analytics: AnalyticsClient;
  /** Injectable clock, so expiry logic is testable without waiting. */
  readonly now: () => number;
  /** Supabase auth client factory, bound to this request's cookie jar. */
  readonly authClientFor: (jar: CookieJar) => import('@supabase/supabase-js').SupabaseClient;
}

/** Hono context variables. */
export interface AppVariables {
  requestId: string;
  logger: Logger;
  deps: Deps;
  cspNonce: string;
  clientIp: string | null;
  ipPrefix: string | null;
  userAgentFamily: string | null;
  cookieJar: CookieJar;
  auditContext: AuditContext;
  /** Opaque, rotating visitor id. Created on demand, never linked to identity. */
  visitorId: string | null;
  /** Cached session resolution. `undefined` = not yet resolved. */
  sessionResolved?: { user: AuthenticatedUser | null };
}

export interface AppEnv {
  Variables: AppVariables;
}

export type AppContext = Context<AppEnv>;

// -----------------------------------------------------------------------------
// Authorization helpers
// -----------------------------------------------------------------------------

/**
 * Resolve the caller once per request.
 *
 * Cached in the context because a route may check authentication, then
 * verification, then ownership; three `getUser()` round trips would be wasteful
 * and would triple the failure surface.
 */
export async function currentUser(c: AppContext): Promise<AuthenticatedUser | null> {
  const cached = c.get('sessionResolved');
  if (cached !== undefined) return cached.user;

  const deps = c.get('deps');
  const client = deps.authClientFor(c.get('cookieJar'));
  const result = await resolveSession(client, deps.db);

  const user = result.authenticated ? result.user : null;
  c.set('sessionResolved', { user });

  if (!result.authenticated && result.reason === 'invalid_session') {
    c.get('logger').info('session_invalid', { reason: result.reason });
  }

  return user;
}

/**
 * Require an authenticated caller.
 *
 * Throws `ApiError`, which the global error handler turns into a sanitised
 * response. Throwing rather than returning means a route physically cannot
 * continue past a failed check by forgetting an `if`.
 */
export async function requireUser(c: AppContext): Promise<AuthenticatedUser> {
  const user = await currentUser(c);
  if (user === null) throw unauthenticated();
  return user;
}

/**
 * Require an authenticated caller with a verified email address.
 *
 * Applied to everything that spends money or holds inventory. Magic-link and
 * OAuth sign-ins both yield a verified address, so in practice this only ever
 * blocks an account in an unusual state — which is exactly when you want it to.
 */
export async function requireVerifiedUser(c: AppContext): Promise<AuthenticatedUser> {
  const user = await requireUser(c);
  if (!user.emailVerified) {
    throw new ApiError('email_unverified', { logContext: { userId: user.id } });
  }
  return user;
}

/**
 * Require an admin.
 *
 * Three independent gates, all of which must pass:
 *   1. an authenticated session,
 *   2. `profiles.is_admin` in the database (read fresh, never from a JWT),
 *   3. presence in the ADMIN_EMAIL_ALLOWLIST configured as a Worker secret.
 *
 * Gate 3 means that even a full database compromise that flips `is_admin` does
 * not grant admin access without also changing a Cloudflare secret. A denial is
 * audited, because someone probing /admin is worth knowing about.
 *
 * `ADMIN_SURFACE_DISABLED=true` is the break-glass switch: it turns the entire
 * admin surface off without a deploy.
 */
export async function requireAdmin(c: AppContext): Promise<AuthenticatedUser> {
  const deps = c.get('deps');

  if (deps.config.adminSurfaceDisabled) {
    throw new ApiError('not_found', { logContext: { reason: 'admin_surface_disabled' } });
  }

  const user = await currentUser(c);

  // Deliberately 404, not 403: a guessed admin URL must not confirm that an
  // admin surface exists at all.
  if (user === null) {
    auditSecurityEvent(c.get('auditContext'), 'security.admin_access_denied', {
      stage: 'unauthenticated',
      path: new URL(c.req.url).pathname,
    });
    throw new ApiError('not_found');
  }

  if (!user.isAdmin) {
    auditSecurityEvent(
      c.get('auditContext'),
      'security.admin_access_denied',
      { stage: 'not_admin', path: new URL(c.req.url).pathname },
      user.id,
    );
    throw new ApiError('not_found');
  }

  const allowlist = deps.config.adminEmailAllowlist;
  if (allowlist.length === 0 || !allowlist.includes(user.email.toLowerCase())) {
    auditSecurityEvent(
      c.get('auditContext'),
      'security.admin_access_denied',
      {
        stage: 'not_allowlisted',
        path: new URL(c.req.url).pathname,
        allowlistConfigured: allowlist.length > 0,
        severity: 'high',
      },
      user.id,
    );
    throw forbidden({
      message: 'Admin access requires an allowlisted account.',
      logContext: { userId: user.id, reason: 'admin_email_not_allowlisted' },
    });
  }

  return user;
}
