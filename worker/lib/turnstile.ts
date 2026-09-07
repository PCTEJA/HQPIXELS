/**
 * Cloudflare Turnstile verification.
 *
 * The whole point of this module is that the widget on the page proves nothing.
 * The token it produces is only meaningful once THIS code has exchanged it with
 * Cloudflare's siteverify endpoint and checked the response — including the
 * hostname and action, which is what stops a token minted on an attacker's own
 * Turnstile site (or on our own site for a cheap action) being replayed against
 * an expensive one.
 *
 * tests/unit/turnstile.test.ts covers the bypass attempts: missing token, empty
 * token, token for the wrong action, token for the wrong hostname, and a
 * siteverify response that says success but with mismatched metadata.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's documented always-passes test secret. */
const TEST_SECRET_ALWAYS_PASSES = '1x0000000000000000000000000000000AA';
/** Cloudflare's documented always-fails test secret. */
const TEST_SECRET_ALWAYS_FAILS = '2x0000000000000000000000000000000AA';

export type TurnstileAction = 'signin' | 'reserve' | 'upload' | 'checkout' | 'abuse-report';

export interface TurnstileVerifyInput {
  readonly secret: string;
  readonly token: string | null | undefined;
  readonly action: TurnstileAction;
  /** Remote IP, if known. Improves Cloudflare's scoring; optional. */
  readonly remoteIp?: string | null;
  /** Hostnames the token is allowed to have been issued for. */
  readonly expectedHostnames: readonly string[];
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

export type TurnstileResult =
  | { readonly ok: true; readonly hostname: string | null; readonly challengeTs: string | null }
  | {
      readonly ok: false;
      readonly reason:
        | 'token_missing'
        | 'token_malformed'
        | 'verification_failed'
        | 'action_mismatch'
        | 'hostname_mismatch'
        | 'duplicate_token'
        | 'upstream_error';
      /** Cloudflare's error codes, for the log only. */
      readonly errorCodes?: readonly string[];
    };

interface SiteverifyResponse {
  success?: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

export async function verifyTurnstile(input: TurnstileVerifyInput): Promise<TurnstileResult> {
  const { secret, token, action, remoteIp, expectedHostnames } = input;
  const doFetch = input.fetchImpl ?? fetch;

  if (token === null || token === undefined || token === '') {
    return { ok: false, reason: 'token_missing' };
  }
  // Turnstile tokens are opaque but bounded. A megabyte "token" is an attack on
  // the siteverify endpoint, not a real submission.
  if (token.length < 10 || token.length > 2048) {
    return { ok: false, reason: 'token_malformed' };
  }

  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);
  // Tokens are already single-use. We do not retry Siteverify here, so omit
  // its optional UUID idempotency key; a token-derived string is rejected.

  let payload: SiteverifyResponse;
  try {
    const response = await doFetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, reason: 'upstream_error' };
    payload = await response.json();
  } catch {
    // Fail CLOSED. Unlike rate limiting, a Turnstile outage must not become an
    // open door on the endpoints that cost us money.
    return { ok: false, reason: 'upstream_error' };
  }

  if (payload.success !== true) {
    const codes = payload['error-codes'] ?? [];
    if (codes.includes('timeout-or-duplicate')) {
      return { ok: false, reason: 'duplicate_token', errorCodes: codes };
    }
    return { ok: false, reason: 'verification_failed', errorCodes: codes };
  }

  // The test secrets return success with no metadata; skip the metadata checks
  // for them so local development works, but never skip them for a real secret.
  const isTestSecret = secret === TEST_SECRET_ALWAYS_PASSES || secret === TEST_SECRET_ALWAYS_FAILS;

  if (!isTestSecret) {
    // Action binding: a token obtained from the cheap sign-in widget must not be
    // usable to create a Checkout Session.
    if (payload.action !== action) {
      return { ok: false, reason: 'action_mismatch' };
    }

    // Hostname binding: rejects a token minted on a Turnstile site the attacker
    // controls.
    if (typeof payload.hostname !== 'string') {
      return { ok: false, reason: 'hostname_mismatch' };
    }
    const hostname = payload.hostname.toLowerCase();
    const allowed = expectedHostnames.some((h) => {
      const expected = h.toLowerCase();
      return hostname === expected || hostname === `www.${expected}`;
    });
    if (!allowed) return { ok: false, reason: 'hostname_mismatch' };
  }

  return {
    ok: true,
    hostname: payload.hostname ?? null,
    challengeTs: payload.challenge_ts ?? null,
  };
}

/** Hostnames a Turnstile token may legitimately carry, derived from the site URL. */
export function turnstileHostnames(siteHost: string, isProduction: boolean): string[] {
  const hosts = new Set<string>([siteHost.split(':')[0] ?? siteHost]);
  if (!isProduction) {
    hosts.add('localhost');
    hosts.add('127.0.0.1');
  }
  return [...hosts];
}
