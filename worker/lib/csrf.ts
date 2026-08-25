/**
 * CSRF protection: signed double-submit token, plus the origin check in
 * http-security.ts. Both must pass for any state-changing request.
 *
 * Why signed rather than a plain random double-submit value:
 *
 *   A plain double-submit token only proves the requester could both set and
 *   read a cookie on our domain. An attacker who can write a cookie for
 *   hqpixels.com from a compromised sibling subdomain can satisfy that. Binding
 *   the token to the session id with an HMAC means a token minted for one
 *   session is useless in another, so cookie-injection alone is not enough.
 *
 * Token layout (from crypto.signPayload):
 *   csrf.<expiry>.<base64url(sessionBinding)>.<hmac>
 *
 * where sessionBinding is the authenticated user id, or a stable anonymous
 * marker for pre-login forms (magic-link request).
 */

import { CSRF_HEADER, CSRF_TTL_SECONDS } from '@shared/constants';
import { signPayload, timingSafeEqual, verifyPayload } from './crypto';

const PURPOSE = 'csrf';
const ANONYMOUS_BINDING = 'anon';

export function csrfBindingFor(userId: string | null): string {
  return userId ?? ANONYMOUS_BINDING;
}

export async function issueCsrfToken(secret: string, userId: string | null): Promise<string> {
  return signPayload(csrfBindingFor(userId), {
    secret,
    purpose: PURPOSE,
    ttlSeconds: CSRF_TTL_SECONDS,
  });
}

export type CsrfResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'header_missing'
        | 'cookie_missing'
        | 'mismatch'
        | 'invalid_signature'
        | 'expired'
        | 'wrong_session';
    };

export interface VerifyCsrfInput {
  readonly secret: string;
  readonly headerToken: string | null;
  readonly cookieToken: string | null;
  /** Authenticated user id, or null for a pre-login request. */
  readonly userId: string | null;
}

/**
 * Verify a CSRF token.
 *
 * Order of checks is deliberate:
 *   1. both halves present
 *   2. they are byte-identical (the "double submit")
 *   3. the signature is valid and unexpired
 *   4. the binding matches the current session
 *
 * Step 4 is the one that most implementations omit, and it is the one that turns
 * this from "proves same-origin-ish" into "proves same-session".
 */
export async function verifyCsrf(input: VerifyCsrfInput): Promise<CsrfResult> {
  const { secret, headerToken, cookieToken, userId } = input;

  if (headerToken === null || headerToken === '') return { ok: false, reason: 'header_missing' };
  if (cookieToken === null || cookieToken === '') return { ok: false, reason: 'cookie_missing' };
  if (!timingSafeEqual(headerToken, cookieToken)) return { ok: false, reason: 'mismatch' };

  const verified = await verifyPayload(headerToken, { secret, purpose: PURPOSE });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason === 'expired' ? 'expired' : 'invalid_signature' };
  }

  const expected = csrfBindingFor(userId);

  // A token minted while anonymous is accepted after sign-in for exactly one
  // case: the sign-in request itself. Everything else must be bound to the
  // current user, so an attacker cannot mint an anonymous token and reuse it
  // against an authenticated session.
  if (!timingSafeEqual(verified.payload, expected)) {
    return { ok: false, reason: 'wrong_session' };
  }

  return { ok: true };
}

/** Methods that mutate state and therefore require CSRF + origin validation. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiresCsrf(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function readCsrfHeader(request: Request): string | null {
  return request.headers.get(CSRF_HEADER);
}
