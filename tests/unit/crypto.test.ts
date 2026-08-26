/**
 * Unit tests for worker/lib/crypto.ts.
 *
 * These test the cryptographic primitives used for CSRF tokens, OAuth state,
 * and other signed payloads.
 */

import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  base64UrlToUtf8,
  bytesToBase64Url,
  hmacSign,
  hmacVerify,
  randomHex,
  randomToken,
  sha256Hex,
  signPayload,
  timingSafeEqual,
  utf8ToBase64Url,
  verifyPayload,
} from '../../worker/lib/crypto';

describe('bytesToBase64Url / base64UrlToBytes', () => {
  it('round-trips empty array', () => {
    const bytes = new Uint8Array(0);
    const encoded = bytesToBase64Url(bytes);
    const decoded = base64UrlToBytes(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const encoded = bytesToBase64Url(bytes);
    const decoded = base64UrlToBytes(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('produces URL-safe characters (no +, /, =)', () => {
    const bytes = new Uint8Array([255, 255, 255, 255]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('handles standard base64 input with padding', () => {
    const decoded = base64UrlToBytes('AAAA');
    expect(decoded).toEqual(new Uint8Array([0, 0, 0]));
  });
});

describe('utf8ToBase64Url / base64UrlToUtf8', () => {
  it('round-trips ASCII text', () => {
    const text = 'hello world';
    expect(base64UrlToUtf8(utf8ToBase64Url(text))).toBe(text);
  });

  it('round-trips Unicode text', () => {
    const text = '日本語 emoji 😀';
    expect(base64UrlToUtf8(utf8ToBase64Url(text))).toBe(text);
  });

  it('round-trips empty string', () => {
    expect(base64UrlToUtf8(utf8ToBase64Url(''))).toBe('');
  });
});

describe('randomToken', () => {
  it('generates 32-byte token by default', () => {
    const token = randomToken();
    // Base64url of 32 bytes is ~43 characters
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token.length).toBeLessThanOrEqual(45);
  });

  it('generates different tokens each time', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(randomToken());
    }
    expect(tokens.size).toBe(100);
  });

  it('respects custom byte length', () => {
    const token = randomToken(16);
    // Base64url of 16 bytes is ~22 characters
    expect(token.length).toBeGreaterThanOrEqual(20);
    expect(token.length).toBeLessThanOrEqual(24);
  });

  it('produces URL-safe output', () => {
    for (let i = 0; i < 10; i++) {
      const token = randomToken();
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(token).not.toContain('=');
    }
  });
});

describe('randomHex', () => {
  it('generates 8-byte (16-char) hex by default', () => {
    const hex = randomHex();
    expect(hex.length).toBe(16);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('generates different values each time', () => {
    const values = new Set<string>();
    for (let i = 0; i < 100; i++) {
      values.add(randomHex());
    }
    expect(values.size).toBe(100);
  });

  it('respects custom byte length', () => {
    const hex = randomHex(4);
    expect(hex.length).toBe(8);
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeEqual('hello', 'world')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeEqual('hello', 'hello!')).toBe(false);
  });

  it('returns false for non-strings', () => {
    expect(timingSafeEqual(null as unknown as string, 'hello')).toBe(false);
    expect(timingSafeEqual('hello', null as unknown as string)).toBe(false);
    expect(timingSafeEqual(undefined as unknown as string, 'hello')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('handles Unicode correctly', () => {
    expect(timingSafeEqual('日本語', '日本語')).toBe(true);
    expect(timingSafeEqual('日本語', '中国语')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('produces correct hash for known input', async () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const hash = await sha256Hex('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('produces lowercase hex', async () => {
    const hash = await sha256Hex('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts Uint8Array', async () => {
    const bytes = new TextEncoder().encode('hello');
    const hash = await sha256Hex(bytes);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('hmacSign / hmacVerify', () => {
  const secret = 'test-secret-key-at-least-32-chars!';
  const message = 'important message';

  it('produces a signature', async () => {
    const sig = await hmacSign(secret, message);
    expect(sig.length).toBeGreaterThan(0);
  });

  it('verifies valid signature', async () => {
    const sig = await hmacSign(secret, message);
    const valid = await hmacVerify(secret, message, sig);
    expect(valid).toBe(true);
  });

  it('rejects tampered message', async () => {
    const sig = await hmacSign(secret, message);
    const valid = await hmacVerify(secret, 'tampered message', sig);
    expect(valid).toBe(false);
  });

  it('rejects wrong secret', async () => {
    const sig = await hmacSign(secret, message);
    const valid = await hmacVerify('wrong-secret-key-at-least-32-chars!', message, sig);
    expect(valid).toBe(false);
  });

  it('rejects tampered signature', async () => {
    const sig = await hmacSign(secret, message);
    const valid = await hmacVerify(secret, message, sig + 'x');
    expect(valid).toBe(false);
  });

  it('produces consistent signatures', async () => {
    const sig1 = await hmacSign(secret, message);
    const sig2 = await hmacSign(secret, message);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different messages', async () => {
    const sig1 = await hmacSign(secret, 'message 1');
    const sig2 = await hmacSign(secret, 'message 2');
    expect(sig1).not.toBe(sig2);
  });
});

describe('signPayload / verifyPayload', () => {
  const secret = 'test-secret-key-that-is-sufficiently-long-32';
  const purpose = 'test';
  const ttlSeconds = 3600;

  it('round-trips a payload', async () => {
    const payload = 'user-123';
    const token = await signPayload(payload, { secret, purpose, ttlSeconds });
    const result = await verifyPayload(token, { secret, purpose });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toBe(payload);
    }
  });

  it('rejects expired token', async () => {
    const nowMs = Date.now();
    const pastMs = nowMs - 2 * 3600 * 1000; // 2 hours ago
    const token = await signPayload('payload', { secret, purpose, ttlSeconds }, pastMs);
    const result = await verifyPayload(token, { secret, purpose }, nowMs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });

  it('rejects wrong purpose', async () => {
    const token = await signPayload('payload', { secret, purpose: 'csrf', ttlSeconds });
    const result = await verifyPayload(token, { secret, purpose: 'oauth' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad_purpose');
    }
  });

  it('rejects tampered payload', async () => {
    const token = await signPayload('payload', { secret, purpose, ttlSeconds });
    // Tamper with the payload portion (3rd segment)
    const parts = token.split('.');
    parts[2] = utf8ToBase64Url('tampered');
    const tampered = parts.join('.');
    const result = await verifyPayload(tampered, { secret, purpose });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad_signature');
    }
  });

  it('rejects malformed token', async () => {
    const result = await verifyPayload('not.a.valid.token.format', { secret, purpose });
    expect(result.ok).toBe(false);
  });

  it('rejects token with wrong number of parts', async () => {
    const result = await verifyPayload('only.three.parts', { secret, purpose });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('rejects very long tokens (DoS protection)', async () => {
    const longToken = 'a'.repeat(5000);
    const result = await verifyPayload(longToken, { secret, purpose });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('handles Unicode in payload', async () => {
    const payload = 'user-日本語-😀';
    const token = await signPayload(payload, { secret, purpose, ttlSeconds });
    const result = await verifyPayload(token, { secret, purpose });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toBe(payload);
    }
  });

  it('token contains purpose prefix', async () => {
    const token = await signPayload('payload', { secret, purpose: 'csrf', ttlSeconds });
    expect(token.startsWith('csrf.')).toBe(true);
  });
});
