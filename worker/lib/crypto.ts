/**
 * Cryptographic helpers, all built on WebCrypto (available in workerd, Node 22
 * and browsers, so this module is testable without a shim).
 *
 * Nothing here invents a primitive. It exists to make the *safe* call the easy
 * one: constant-time comparison by default, base64url everywhere, and HMAC keys
 * that are imported once per use rather than being handled as raw strings.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// -----------------------------------------------------------------------------
// base64url
// -----------------------------------------------------------------------------

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8ToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

export function base64UrlToUtf8(value: string): string {
  return decoder.decode(base64UrlToBytes(value));
}

// -----------------------------------------------------------------------------
// Random
// -----------------------------------------------------------------------------

/** Cryptographically random base64url token. 32 bytes = 256 bits by default. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** Lowercase hex, for request ids that end up in logs and user-facing messages. */
export function randomHex(byteLength = 8): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// -----------------------------------------------------------------------------
// Constant-time comparison
// -----------------------------------------------------------------------------

/**
 * Compare two strings without leaking their contents through timing.
 *
 * Length is compared first and returns early — that leaks only the length, which
 * is public for every token we compare (all fixed-format). The byte loop then
 * runs over the full length with no early exit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// -----------------------------------------------------------------------------
// SHA-256
// -----------------------------------------------------------------------------

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data =
    typeof input === 'string'
      ? encoder.encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// -----------------------------------------------------------------------------
// HMAC-SHA256 signing
// -----------------------------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Import (and memoise) an HMAC key.
 *
 * Memoising is safe here: the Worker isolate is per-deployment, the secret does
 * not change within an isolate's lifetime, and `importKey` on every request
 * would be pure overhead on the hot CSRF path.
 */
function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, promise);
  return promise;
}

export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function hmacVerify(
  secret: string,
  message: string,
  signature: string,
): Promise<boolean> {
  // Recompute and compare in constant time rather than using subtle.verify with
  // attacker-controlled base64: a malformed signature would throw there, and the
  // throw/no-throw difference is itself an oracle.
  const expected = await hmacSign(secret, message);
  return timingSafeEqual(expected, signature);
}

// -----------------------------------------------------------------------------
// Signed, expiring payloads
// -----------------------------------------------------------------------------

export interface SignedPayloadOptions {
  readonly secret: string;
  /** Namespace, so a token minted for one purpose cannot be replayed for another. */
  readonly purpose: string;
  readonly ttlSeconds: number;
}

/**
 * `<purpose>.<expiryEpoch>.<base64url(payload)>.<hmac>`
 *
 * Used for CSRF tokens and the OAuth `state` value. The purpose string is inside
 * the signed material, which is what stops a CSRF token being presented as an
 * OAuth state.
 */
export async function signPayload(
  payload: string,
  options: SignedPayloadOptions,
  nowMs = Date.now(),
): Promise<string> {
  const expiry = Math.floor(nowMs / 1000) + options.ttlSeconds;
  const body = `${options.purpose}.${expiry}.${utf8ToBase64Url(payload)}`;
  const signature = await hmacSign(options.secret, body);
  return `${body}.${signature}`;
}

export type VerifyResult =
  | { readonly ok: true; readonly payload: string }
  | {
      readonly ok: false;
      readonly reason: 'malformed' | 'bad_purpose' | 'expired' | 'bad_signature';
    };

export async function verifyPayload(
  token: string,
  options: Omit<SignedPayloadOptions, 'ttlSeconds'>,
  nowMs = Date.now(),
): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };

  const [purpose, expiryRaw, payloadRaw, signature] = parts as [string, string, string, string];
  if (purpose !== options.purpose) return { ok: false, reason: 'bad_purpose' };

  const body = `${purpose}.${expiryRaw}.${payloadRaw}`;
  // Signature first, then expiry: never act on unauthenticated contents, not
  // even to read a timestamp out of them.
  if (!(await hmacVerify(options.secret, body, signature))) {
    return { ok: false, reason: 'bad_signature' };
  }

  const expiry = Number.parseInt(expiryRaw, 10);
  if (!Number.isSafeInteger(expiry)) return { ok: false, reason: 'malformed' };
  if (Math.floor(nowMs / 1000) > expiry) return { ok: false, reason: 'expired' };

  try {
    return { ok: true, payload: base64UrlToUtf8(payloadRaw) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
