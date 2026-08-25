/**
 * Cookie handling.
 *
 * Every cookie this application sets goes through `serializeCookie` here, which
 * makes the secure defaults unavoidable: HttpOnly unless explicitly opted out,
 * Secure in production, an explicit SameSite, and Path=/.
 *
 * We parse cookies ourselves rather than pulling in a dependency because the
 * parsing rules matter: a duplicate cookie name must resolve deterministically
 * (first wins) or an attacker who can set a cookie on a sibling subdomain could
 * shadow the real session.
 */

import {
  COOKIE_CSRF,
  COOKIE_OAUTH_FLOW,
  COOKIE_SESSION_PREFIX,
  COOKIE_VISITOR,
} from '@shared/constants';

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface CookieOptions {
  readonly maxAgeSeconds?: number;
  readonly sameSite?: SameSite;
  /** Defaults to true. Set false ONLY for the CSRF token, which JS must read. */
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly path?: string;
  readonly domain?: string;
}

const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * Serialise a Set-Cookie value.
 *
 * Throws on an invalid name or a value containing a control character or
 * separator — header injection through a cookie value is a real class of bug and
 * silently stripping would hide it.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME_RE.test(name)) {
    throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`);
  }
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x21 || cp === 0x22 || cp === 0x2c || cp === 0x3b || cp === 0x5c || cp > 0x7e) {
      throw new Error(`Invalid character in cookie value for ${name}`);
    }
  }

  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
    parts.push(
      `Expires=${new Date(Date.now() + Math.max(0, options.maxAgeSeconds) * 1000).toUTCString()}`,
    );
  }
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);

  return parts.join('; ');
}

/** Expire a cookie. Must mirror the original Path/Domain or the browser keeps it. */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, 'x', { ...options, maxAgeSeconds: 0 });
}

/**
 * Parse a Cookie header.
 *
 * First occurrence of a name wins. This matters: if an attacker with control of
 * a sibling subdomain sets a second `hq-auth` cookie, browsers may send both,
 * and "last wins" would let them overwrite the real session (session fixation).
 */
export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header || header.length > 8192) return out;

  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq < 1) continue;
    const name = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (name === '' || !COOKIE_NAME_RE.test(name)) continue;
    if (out.has(name)) continue;
    out.set(name, value);
  }
  return out;
}

export function readCookie(request: Request, name: string): string | null {
  return parseCookies(request.headers.get('Cookie')).get(name) ?? null;
}

// -----------------------------------------------------------------------------
// Purpose-specific cookie builders
// -----------------------------------------------------------------------------

export interface CookieContext {
  readonly isProduction: boolean;
}

/**
 * Session cookie (Supabase access/refresh tokens).
 *
 * SameSite=Lax, not Strict: the OAuth provider redirects the browser back to us
 * as a cross-site top-level navigation, and a Strict cookie would not be sent on
 * that request, so the callback could not establish the session. Lax still
 * blocks the cookie on cross-site POSTs, which is the CSRF-relevant case, and
 * the signed CSRF token covers the rest.
 */
export function sessionCookie(
  index: number,
  value: string,
  ctx: CookieContext,
  maxAgeSeconds: number,
): string {
  return serializeCookie(`${COOKIE_SESSION_PREFIX}.${index}`, value, {
    httpOnly: true,
    secure: ctx.isProduction,
    sameSite: 'Lax',
    maxAgeSeconds,
  });
}

export function clearSessionCookie(index: number, ctx: CookieContext): string {
  return clearCookie(`${COOKIE_SESSION_PREFIX}.${index}`, {
    httpOnly: true,
    secure: ctx.isProduction,
    sameSite: 'Lax',
  });
}

/**
 * The CSRF token cookie is the ONLY one that is not HttpOnly — the page's own
 * JavaScript has to read it to echo it in the X-Hq-Csrf header. That is the
 * double-submit pattern, and it is safe because the token is HMAC-bound to the
 * session: reading it tells an attacker nothing they can use from another
 * origin, and they cannot read it cross-origin anyway.
 */
export function csrfCookie(value: string, ctx: CookieContext, maxAgeSeconds: number): string {
  return serializeCookie(COOKIE_CSRF, value, {
    httpOnly: false,
    secure: ctx.isProduction,
    sameSite: 'Strict',
    maxAgeSeconds,
  });
}

/**
 * OAuth PKCE verifier + state. Short-lived and HttpOnly.
 *
 * SameSite=Lax so it survives the provider's redirect back to us.
 */
export function oauthFlowCookie(value: string, ctx: CookieContext): string {
  return serializeCookie(COOKIE_OAUTH_FLOW, value, {
    httpOnly: true,
    secure: ctx.isProduction,
    sameSite: 'Lax',
    maxAgeSeconds: 600,
  });
}

export function clearOauthFlowCookie(ctx: CookieContext): string {
  return clearCookie(COOKIE_OAUTH_FLOW, {
    httpOnly: true,
    secure: ctx.isProduction,
    sameSite: 'Lax',
  });
}

/**
 * Opaque visitor id, used only to de-duplicate outbound clicks and to bucket
 * anonymous rate limits. Not linked to an account, not used for analytics
 * identity, rotated daily by its own Max-Age.
 */
export function visitorCookie(value: string, ctx: CookieContext, maxAgeSeconds: number): string {
  return serializeCookie(COOKIE_VISITOR, value, {
    httpOnly: true,
    secure: ctx.isProduction,
    sameSite: 'Lax',
    maxAgeSeconds,
  });
}
