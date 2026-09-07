import { describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../../worker/lib/turnstile';

const input = {
  secret: 'test-real-secret',
  token: 'opaque-token-for-testing',
  action: 'signin' as const,
  expectedHostnames: ['hqpixels.com'],
};
const valid = { success: true, action: 'signin', hostname: 'hqpixels.com' };

describe('Turnstile verification', () => {
  it('sends a valid Siteverify request without the malformed idempotency key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(valid));
    expect(await verifyTurnstile({ ...input, fetchImpl })).toMatchObject({ ok: true });
    const options = fetchImpl.mock.calls[0]?.[1];
    const body = options?.body as FormData;
    expect(body.get('secret')).toBe(input.secret);
    expect(body.get('response')).toBe(input.token);
    expect(body.has('idempotency_key')).toBe(false);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [{ success: true, hostname: 'hqpixels.com' }, 'action_mismatch'],
    [{ ...valid, action: 'checkout' }, 'action_mismatch'],
    [{ success: true, action: 'signin' }, 'hostname_mismatch'],
    [{ ...valid, hostname: 'evil.example' }, 'hostname_mismatch'],
    [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, 'duplicate_token'],
    [{ success: false, 'error-codes': ['invalid-input-secret'] }, 'verification_failed'],
  ])('rejects invalid verification metadata: %j', async (payload, reason) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    expect(await verifyTurnstile({ ...input, fetchImpl })).toMatchObject({ ok: false, reason });
  });

  it('fails closed on network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network failure'));
    expect(await verifyTurnstile({ ...input, fetchImpl })).toEqual({
      ok: false,
      reason: 'upstream_error',
    });
  });

  it('rejects missing tokens before contacting Cloudflare', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await verifyTurnstile({ ...input, token: '', fetchImpl })).toEqual({
      ok: false,
      reason: 'token_missing',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
