/**
 * Authentication and session management.
 *
 * Design decisions, and why:
 *
 * 1. Sessions live in HttpOnly cookies set by this Worker. The browser never
 *    holds an access token in JavaScript-reachable storage, so an XSS bug
 *    cannot exfiltrate a session. This is the single highest-value decision in
 *    the file.
 *
 * 2. OAuth uses PKCE, with the code verifier stored in a short-lived HttpOnly
 *    cookie and the `state` value HMAC-signed and bound to the intended
 *    redirect path. An attacker cannot inject their own authorization code
 *    (login CSRF) because they cannot produce a matching signed state, and
 *    cannot steal ours because the verifier never leaves the cookie.
 *
 * 3. There is NO password authentication. Google, GitHub and email magic link
 *    only. That removes credential stuffing, password reuse, password reset
 *    flows, and password storage from the threat model entirely.
 *
 * 4. `is_admin` is read from the database on every request that needs it — never
 *    from a JWT claim. See the comment on public.session_profile.
 *
 * 5. The post-login redirect target is validated against a path allowlist, so
 *    the sign-in flow can never be turned into an open redirect.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { COOKIE_SESSION_PREFIX } from '@shared/constants';
import type { AppConfig } from '../env';
import { parseCookies, serializeCookie } from './cookies';
import { randomToken, signPayload, verifyPayload } from './crypto';
import type { Db, SessionProfile } from './supabase';

// -----------------------------------------------------------------------------
// Redirect allowlist
// -----------------------------------------------------------------------------

/**
 * Paths a user may be sent to after signing in.
 *
 * An allowlist of PREFIXES, not a "starts with /" check: `//evil.example.com`
 * and `/\evil.example.com` both start with a slash and both are protocol-relative
 * URLs that browsers will follow off-site.
 */
const ALLOWED_REDIRECT_PREFIXES = [
  '/',
  '/wall',
  '/claim',
  '/dashboard',
  '/rankings',
  '/stats',
  '/pricing',
  '/faq',
] as const;

export function safeRedirectPath(candidate: string | null | undefined): string {
  if (typeof candidate !== 'string' || candidate === '') return '/dashboard';
  if (candidate.length > 200) return '/dashboard';

  // Reject anything that could be interpreted as an absolute or
  // protocol-relative URL, or that smuggles a scheme.
  if (!candidate.startsWith('/')) return '/dashboard';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/dashboard';
  if (candidate.includes('://') || candidate.includes('\\')) return '/dashboard';
  // Control characters and their percent-encodings are header-injection
  // material once this value reaches a Location header. Checked numerically
  // rather than with a regex literal, so no control byte lives in source.
  for (const ch of candidate) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) return '/dashboard';
  }
  if (/%0[ad]/i.test(candidate)) return '/dashboard';

  const path = candidate.split('?')[0]?.split('#')[0] ?? '/';
  const matches = ALLOWED_REDIRECT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return matches ? candidate : '/dashboard';
}

// -----------------------------------------------------------------------------
// Cookie plumbing for @supabase/ssr
// -----------------------------------------------------------------------------

/**
 * Collects the Set-Cookie headers Supabase wants to write so the caller can
 * apply them to the outgoing response.
 *
 * Supabase chunks large session cookies across `<prefix>.0`, `<prefix>.1`, ...
 * which is why the names are dynamic and we cannot hardcode a single one.
 */
export class CookieJar {
  private readonly pending: string[] = [];

  constructor(
    private readonly incoming: Map<string, string>,
    private readonly isProduction: boolean,
  ) {}

  getAll(): Array<{ name: string; value: string }> {
    return [...this.incoming.entries()].map(([name, value]) => ({ name, value }));
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    if (options.maxAge === 0) this.incoming.delete(name);
    else this.incoming.set(name, value);
    // Force our security posture regardless of what the library asks for.
    // Supabase's defaults are reasonable but we do not want them to be the
    // authority on HttpOnly/Secure for a session cookie.
    this.pending.push(
      serializeCookie(name, value, {
        httpOnly: true,
        secure: this.isProduction,
        sameSite: 'Lax',
        path: '/',
        ...(options.maxAge !== undefined ? { maxAgeSeconds: options.maxAge } : {}),
      }),
    );
  }

  remove(name: string): void {
    this.incoming.delete(name);
    this.pending.push(
      serializeCookie(name, 'x', {
        httpOnly: true,
        secure: this.isProduction,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 0,
      }),
    );
  }

  /** Set-Cookie header values to append to the response. */
  headers(): readonly string[] {
    return this.pending;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }
}

export function createCookieJar(request: Request, config: AppConfig): CookieJar {
  return new CookieJar(parseCookies(request.headers.get('Cookie')), config.isProduction);
}

/**
 * A Supabase client bound to this request's cookies.
 *
 * Uses the ANON key, not the service key: this client acts as the user. The
 * service key is used only by the RPC layer in supabase.ts and must never be
 * handed to anything that processes a user-supplied token.
 */
export function createAuthClient(
  config: AppConfig,
  jar: CookieJar,
  fetchImpl?: typeof fetch,
): SupabaseClient {
  return createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (cookies: Array<{ name: string; value: string; options?: CookieOptions }>) => {
        for (const cookie of cookies) {
          jar.set(cookie.name, cookie.value, cookie.options ?? {});
        }
      },
    },
    cookieOptions: {
      name: COOKIE_SESSION_PREFIX,
      path: '/',
      sameSite: 'lax',
      secure: config.isProduction,
      httpOnly: true,
    },
    auth: {
      // PKCE for OAuth. The verifier is written to a cookie by the jar above.
      flowType: 'pkce',
      // The Worker is not a browser: nothing should auto-refresh in the
      // background or read a URL fragment.
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
    },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

// -----------------------------------------------------------------------------
// Resolving the caller
// -----------------------------------------------------------------------------

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly isAdmin: boolean;
  readonly foundingBuyer: boolean;
  readonly displayName: string | null;
  readonly handle: string | null;
}

export type ResolveSessionResult =
  | { readonly authenticated: true; readonly user: AuthenticatedUser }
  | {
      readonly authenticated: false;
      readonly reason: 'no_session' | 'invalid_session' | 'no_profile';
    };

/**
 * Resolve the caller from their session cookies.
 *
 * `getUser()` validates the token against the Supabase Auth server rather than
 * trusting the JWT locally. That costs one network hop on authenticated requests
 * and is the right trade: a locally-verified token stays valid until expiry even
 * after the user signs out or is banned. Public, cacheable routes never call
 * this, so the hop is confined to the transactional path.
 */
export async function resolveSession(
  client: SupabaseClient,
  db: Db,
): Promise<ResolveSessionResult> {
  const { data, error } = await client.auth.getUser();

  if (error || !data.user) {
    return { authenticated: false, reason: error ? 'invalid_session' : 'no_session' };
  }

  const profile = await db.sessionProfile(data.user.id);
  if (profile.ok !== true) {
    return { authenticated: false, reason: 'no_profile' };
  }

  const row = profile as unknown as SessionProfile;

  return {
    authenticated: true,
    user: {
      id: row.id,
      email: row.email,
      // Trust the DATABASE for verification state, which the auth trigger keeps
      // in sync, rather than the JWT payload.
      emailVerified: row.emailVerified === true,
      isAdmin: row.isAdmin === true,
      foundingBuyer: row.foundingBuyer === true,
      displayName: row.displayName ?? null,
      handle: row.handle ?? null,
    },
  };
}

// -----------------------------------------------------------------------------
// OAuth state
// -----------------------------------------------------------------------------

const OAUTH_STATE_PURPOSE = 'oauth-state';

export interface OAuthStatePayload {
  readonly redirectPath: string;
  readonly nonce: string;
}

export async function signOAuthState(
  secret: string,
  redirectPath: string,
): Promise<{ state: string; nonce: string }> {
  const nonce = randomToken(16);
  const state = await signPayload(
    JSON.stringify({ redirectPath: safeRedirectPath(redirectPath), nonce }),
    { secret, purpose: OAUTH_STATE_PURPOSE, ttlSeconds: 600 },
  );
  return { state, nonce };
}

export async function verifyOAuthState(
  secret: string,
  state: string | null,
  expectedNonce: string | null,
): Promise<{ ok: true; redirectPath: string } | { ok: false; reason: string }> {
  if (state === null || state === '') return { ok: false, reason: 'state_missing' };
  if (expectedNonce === null || expectedNonce === '') return { ok: false, reason: 'nonce_missing' };

  const verified = await verifyPayload(state, { secret, purpose: OAUTH_STATE_PURPOSE });
  if (!verified.ok) return { ok: false, reason: `state_${verified.reason}` };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(verified.payload) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: 'state_malformed' };
  }

  // The nonce ties this callback to the browser that started the flow. Without
  // it, a signed state captured from someone else's flow could be replayed.
  if (payload.nonce !== expectedNonce) return { ok: false, reason: 'nonce_mismatch' };

  return { ok: true, redirectPath: safeRedirectPath(payload.redirectPath) };
}

/** Providers we support. Deliberately closed: no dynamic provider from input. */
export const SUPPORTED_OAUTH_PROVIDERS = ['google', 'github'] as const;
export type OAuthProvider = (typeof SUPPORTED_OAUTH_PROVIDERS)[number];

export function isSupportedProvider(value: string): value is OAuthProvider {
  return (SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(value);
}
