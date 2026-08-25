/**
 * Authentication endpoints.
 *
 * Three ways in, no passwords: Google OAuth, GitHub OAuth, email magic link.
 *
 * The session is established by the Worker and stored in HttpOnly cookies. The
 * browser never receives a token it can read, so an XSS bug cannot steal a
 * session — which is the single most valuable property of this design.
 */

import { Hono } from 'hono';
import { CSRF_TTL_SECONDS } from '@shared/constants';
import { magicLinkRequestSchema, oauthStartSchema, profileUpdateSchema } from '@shared/schemas';
import type { AppEnv } from '../context';
import { currentUser, requireUser } from '../context';
import { ApiError, validationFailed, zodFieldErrors } from '../lib/errors';
import { NO_STORE } from '../lib/cache';
import { audit, auditSecurityEvent } from '../lib/audit';
import { ipBucketKey } from '../lib/client-ip';
import { issueCsrfToken } from '../lib/csrf';
import { clearOauthFlowCookie, oauthFlowCookie, readCookie } from '../lib/cookies';
import { COOKIE_OAUTH_FLOW } from '@shared/constants';
import {
  isSupportedProvider,
  safeRedirectPath,
  signOAuthState,
  verifyOAuthState,
} from '../lib/auth';
import { attachBrowserCookies } from '../middleware';
import { isOk } from '../lib/supabase';
import { sha256Hex } from '../lib/crypto';

export const authRoutes = new Hono<AppEnv>();

// -----------------------------------------------------------------------------
// GET /api/auth/session
// -----------------------------------------------------------------------------
/**
 * The client's first call on boot.
 *
 * Does three things at once, deliberately:
 *   1. reports who (if anyone) is signed in,
 *   2. mints a CSRF token bound to that identity and sets the cookie,
 *   3. sets the opaque visitor cookie if absent.
 *
 * It has to be here rather than on the HTML document because the document is
 * served from the edge cache and a cached Set-Cookie would be a session-leak.
 */
authRoutes.get('/session', async (c) => {
  const user = await currentUser(c);
  const token = await attachBrowserCookies(c, user?.id ?? null);

  return c.json(
    {
      authenticated: user !== null,
      user:
        user === null
          ? null
          : {
              id: user.id,
              // The buyer's own email, to their own session. Not in any public
              // response.
              email: user.email,
              emailVerified: user.emailVerified,
              displayName: user.displayName,
              handle: user.handle,
              foundingBuyer: user.foundingBuyer,
              isAdmin: user.isAdmin,
            },
      csrfToken: token,
      csrfExpiresInSeconds: CSRF_TTL_SECONDS,
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// POST /api/auth/magic-link
// -----------------------------------------------------------------------------
authRoutes.post('/magic-link', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');

  const body = await c.req.json().catch(() => null);
  const parsed = magicLinkRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }
  const { email, turnstileToken, redirectPath } = parsed.data;

  const turnstile = await deps.verifyTurnstile({
    token: turnstileToken,
    action: 'signin',
    remoteIp: c.get('clientIp'),
  });
  if (!turnstile.ok) {
    auditSecurityEvent(auditCtx, 'security.turnstile_rejected', {
      action: 'signin',
      reason: turnstile.reason,
    });
    throw new ApiError('turnstile_failed');
  }

  // Limited per IP AND per email address. Per-IP alone lets one attacker
  // enumerate many addresses; per-email alone lets a botnet flood one inbox.
  const ipKey = await ipBucketKey(c.get('clientIp'), deps.config.signingSecret, 'auth');
  // The email is hashed, so the rate-limit store never holds a list of addresses
  // people tried to sign in with.
  const emailKey = (await sha256Hex(`auth:${email}`)).slice(0, 32);

  for (const key of [`ip:${ipKey}`, `email:${emailKey}`]) {
    const decision = await deps.rateLimiter.consume('authStart', key);
    if (!decision.allowed) {
      auditSecurityEvent(auditCtx, 'security.rate_limited', {
        policy: 'authStart',
        keyKind: key.startsWith('ip:') ? 'ip' : 'email',
      });
      // Same generic response as success, so this is not an oracle for whether
      // an address is registered or rate limited.
      return c.json(
        {
          sent: true,
          message: 'If that address can sign in, a link is on its way. Check your inbox.',
        },
        202,
        { 'Cache-Control': NO_STORE },
      );
    }
  }

  const client = deps.authClientFor(c.get('cookieJar'));
  const target = safeRedirectPath(redirectPath);

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      // Supabase appends the code; our callback exchanges it for a session.
      emailRedirectTo: `${deps.config.siteUrl}/api/auth/callback?next=${encodeURIComponent(target)}`,
      // Sign-up and sign-in are the same action for a magic link. Allowing
      // creation here is what makes "no password" workable.
      shouldCreateUser: true,
    },
  });

  if (error) {
    // Logged, never surfaced: the error text distinguishes "no such user" from
    // "rate limited by the mail provider", and both are useful to an attacker.
    logger.warn('magic_link_send_failed', { reason: error.message.slice(0, 200) });
  }

  audit(auditCtx, {
    action: 'auth.magic_link_requested',
    targetType: 'email',
    // The hash, not the address: the audit log should not become a mailing list.
    targetId: emailKey,
    detail: { delivered: !error, redirectTo: target },
  });

  // Always the same answer. Account enumeration is prevented by the response
  // being identical whether or not the address exists.
  return c.json(
    { sent: true, message: 'If that address can sign in, a link is on its way. Check your inbox.' },
    202,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// POST /api/auth/oauth/start
// -----------------------------------------------------------------------------
authRoutes.post('/oauth/start', async (c) => {
  const deps = c.get('deps');
  const auditCtx = c.get('auditContext');

  const body = await c.req.json().catch(() => null);
  const parsed = oauthStartSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }
  const { provider, redirectPath } = parsed.data;

  // The schema enum already closes this, but an explicit check documents that
  // the provider is never taken from free-form input.
  if (!isSupportedProvider(provider)) throw validationFailed();

  const ipKey = await ipBucketKey(c.get('clientIp'), deps.config.signingSecret, 'auth');
  const decision = await deps.rateLimiter.consume('authStart', `oauth:${ipKey}`);
  if (!decision.allowed) {
    throw new ApiError('rate_limited', { retryAfter: decision.retryAfter });
  }

  const target = safeRedirectPath(redirectPath);
  const { state, nonce } = await signOAuthState(deps.config.signingSecret, target);

  const client = deps.authClientFor(c.get('cookieJar'));

  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${deps.config.siteUrl}/api/auth/callback?next=${encodeURIComponent(target)}`,
      // Supabase stores the PKCE verifier through our cookie jar, so it lands in
      // an HttpOnly cookie rather than anywhere JavaScript can read.
      skipBrowserRedirect: true,
      queryParams: { state },
    },
  });

  if (error || !data.url) {
    throw new ApiError('upstream_unavailable', {
      message: 'We could not start that sign-in. Please try again.',
      logContext: { provider, reason: error?.message.slice(0, 200) },
    });
  }

  audit(auditCtx, {
    action: 'auth.oauth_started',
    targetType: 'provider',
    targetId: provider,
    detail: { redirectTo: target },
  });

  // The nonce goes in its own short-lived HttpOnly cookie. The callback requires
  // BOTH a validly signed state and the matching nonce, which is what prevents
  // login CSRF (an attacker feeding us their own authorization code).
  c.res.headers.append(
    'Set-Cookie',
    oauthFlowCookie(nonce, { isProduction: deps.config.isProduction }),
  );

  return c.json({ url: data.url }, 200, { 'Cache-Control': NO_STORE });
});

// -----------------------------------------------------------------------------
// GET /api/auth/callback
// -----------------------------------------------------------------------------
/**
 * OAuth / magic-link callback.
 *
 * A GET, because the identity provider redirects the browser here. It is
 * therefore not CSRF-protected by the global middleware, and the signed `state`
 * plus the nonce cookie are what protect it instead.
 *
 * On any failure we redirect to a friendly page rather than rendering an error,
 * because this URL is visited directly by a human clicking a link in an email.
 */
authRoutes.get('/callback', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const next = safeRedirectPath(url.searchParams.get('next'));

  const failRedirect = (reason: string): Response => {
    logger.info('auth_callback_failed', { reason });
    auditSecurityEvent(auditCtx, 'security.origin_rejected', { stage: 'auth_callback', reason });
    return c.redirect(`${deps.config.siteUrl}/?authError=${encodeURIComponent(reason)}`, 303);
  };

  // The provider itself reported a problem (user declined, etc.).
  if (errorParam !== null) {
    return c.redirect(
      `${deps.config.siteUrl}/?authError=${encodeURIComponent('provider_declined')}`,
      303,
    );
  }

  if (code === null || code === '' || code.length > 512) {
    return failRedirect('missing_code');
  }

  // OAuth flows carry a state; magic-link flows do not. Validate it when present
  // and require the nonce cookie to match.
  if (state !== null) {
    const nonce = readCookie(c.req.raw, COOKIE_OAUTH_FLOW);
    const verified = await verifyOAuthState(deps.config.signingSecret, state, nonce);
    if (!verified.ok) return failRedirect(verified.reason);
  }

  const jar = c.get('cookieJar');
  const client = deps.authClientFor(jar);

  const { data, error } = await client.auth.exchangeCodeForSession(code);

  if (error || !data.session || !data.user) {
    return failRedirect('code_exchange_failed');
  }

  // Session cookies were written into the jar by the exchange; the global
  // middleware applies them to this response.
  const response = c.redirect(`${deps.config.siteUrl}${next}`, 303);

  // The one-time OAuth nonce has served its purpose.
  response.headers.append(
    'Set-Cookie',
    clearOauthFlowCookie({ isProduction: deps.config.isProduction }),
  );

  // Mint a CSRF token bound to the NEW identity. Without this the client would
  // still hold an anonymous-bound token and its first mutation would fail.
  const csrf = await issueCsrfToken(deps.config.signingSecret, data.user.id);
  const { csrfCookie } = await import('../lib/cookies');
  response.headers.append(
    'Set-Cookie',
    csrfCookie(csrf, { isProduction: deps.config.isProduction }, CSRF_TTL_SECONDS),
  );
  response.headers.set('Cache-Control', NO_STORE);

  audit(auditCtx, {
    action: 'auth.session_established',
    targetType: 'user',
    targetId: data.user.id,
    actorId: data.user.id,
    actorLabel: 'buyer',
    detail: { method: state !== null ? 'oauth' : 'magic_link', next },
  });

  logger.info('auth_session_established', { userId: data.user.id });

  return response;
});

// -----------------------------------------------------------------------------
// POST /api/auth/signout
// -----------------------------------------------------------------------------
authRoutes.post('/signout', async (c) => {
  const deps = c.get('deps');
  const user = await currentUser(c);

  const client = deps.authClientFor(c.get('cookieJar'));
  // `global` revokes the refresh token server-side, so the session cannot be
  // resumed from a stolen cookie after sign-out.
  await client.auth.signOut({ scope: 'global' }).catch(() => undefined);

  if (user !== null) {
    audit(c.get('auditContext'), {
      action: 'auth.signed_out',
      targetType: 'user',
      targetId: user.id,
      actorId: user.id,
      actorLabel: 'buyer',
    });
  }

  // Replace the CSRF token with an anonymous-bound one so the page keeps working
  // after sign-out.
  const token = await issueCsrfToken(deps.config.signingSecret, null);
  const { csrfCookie } = await import('../lib/cookies');
  c.res.headers.append(
    'Set-Cookie',
    csrfCookie(token, { isProduction: deps.config.isProduction }, CSRF_TTL_SECONDS),
  );

  return c.json({ signedOut: true, csrfToken: token }, 200, { 'Cache-Control': NO_STORE });
});

// -----------------------------------------------------------------------------
// PATCH /api/auth/profile
// -----------------------------------------------------------------------------
authRoutes.patch('/profile', async (c) => {
  const deps = c.get('deps');
  const user = await requireUser(c);

  const body = await c.req.json().catch(() => null);
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }

  const result = await deps.db.updateProfile(
    user.id,
    parsed.data.displayName ?? null,
    parsed.data.handle ?? null,
  );

  if (!isOk(result)) {
    if (result.code === 'handle_taken') {
      throw validationFailed({
        message: 'That handle is already taken.',
        fields: { handle: 'Already taken.' },
      });
    }
    throw new ApiError('not_found');
  }

  return c.json({ displayName: result.displayName, handle: result.handle }, 200, {
    'Cache-Control': NO_STORE,
  });
});
