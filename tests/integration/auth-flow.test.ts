import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../worker/app';
import {
  createAuthClient,
  signOAuthState,
  verifyOAuthState,
  CookieJar,
} from '../../worker/lib/auth';
import { issueCsrfToken } from '../../worker/lib/csrf';
import { fakeDeps } from './test-helpers';

function setup(otpStatus = 200) {
  const baseDeps = fakeDeps();
  baseDeps.db.writeAudit = vi.fn().mockResolvedValue(undefined);
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(
        Response.json(
          otpStatus === 200 ? {} : { msg: 'private SMTP diagnostic', code: 'unexpected_failure' },
          { status: otpStatus },
        ),
      ),
    );
  const deps = {
    ...baseDeps,
    authClientFor: (jar: CookieJar) => createAuthClient(baseDeps.config, jar, fetchImpl),
  };
  const app = createApp({
    deps,
    waitUntil: (promise) => {
      void promise.catch(() => undefined);
    },
  });
  return { deps, app, fetchImpl };
}

async function post(path: string, body: object, setupResult: ReturnType<typeof setup>) {
  const token = await issueCsrfToken(setupResult.deps.config.signingSecret, null);
  return setupResult.app.request(`http://localhost:3000/api/auth/${path}`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      'Content-Type': 'application/json',
      'x-hq-csrf': token,
      Cookie: `hq-csrf=${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('OAuth and email authentication', () => {
  it('exchanges the callback code, sets session cookies, and returns to the signed claim path', async () => {
    const result = setup();
    const start = await post('oauth/start', { provider: 'google', redirectPath: '/claim' }, result);
    const { url } = (await start.json()) as { url: string };
    const callback = new URL(new URL(url).searchParams.get('redirect_to')!);
    callback.searchParams.set('code', 'test-auth-code');
    callback.searchParams.set('next', '/dashboard');
    const cookies = start.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'test@example.com',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
    };
    result.fetchImpl.mockResolvedValue(
      Response.json({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'bearer',
        expires_in: 3600,
        user,
      }),
    );
    const response = await result.app.request(callback.toString(), {
      headers: { Cookie: cookies },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/claim');
    expect(response.headers.get('set-cookie')).toContain('hq-auth=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('hq-csrf=');
    const sentBody = result.fetchImpl.mock.calls[0]?.[1]?.body;
    if (typeof sentBody !== 'string') throw new Error('Expected JSON exchange body');
    const requestBody = JSON.parse(sentBody) as Record<string, unknown>;
    expect(requestBody.auth_code).toBe('test-auth-code');
    expect(requestBody.code_verifier).toBeTruthy();
  });
  it('preserves Supabase provider state and carries signed app state in redirect_to', async () => {
    const result = setup();
    const response = await post(
      'oauth/start',
      { provider: 'google', redirectPath: '/claim' },
      result,
    );
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.searchParams.has('state')).toBe(false);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    const callback = new URL(authorize.searchParams.get('redirect_to')!);
    expect(callback.searchParams.get('flow')).toBe('oauth');
    const nonce = response.headers.get('set-cookie')?.match(/hq-oauth=([^;]+)/)?.[1] ?? null;
    expect(
      await verifyOAuthState(
        result.deps.config.signingSecret,
        callback.searchParams.get('app_state'),
        nonce,
      ),
    ).toEqual({ ok: true, redirectPath: '/claim' });
    expect(response.headers.get('set-cookie')).toContain('code-verifier');
  });

  it('rejects OAuth callbacks missing app state before exchanging the code', async () => {
    const { app, fetchImpl } = setup();
    const response = await app.request(
      'http://localhost:3000/api/auth/callback?flow=oauth&code=test',
    );
    expect(response.headers.get('location')).toContain('authError=state_missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects callbacks from a different browser before exchanging the code', async () => {
    const { app, deps, fetchImpl } = setup();
    const { state } = await signOAuthState(deps.config.signingSecret, '/claim');
    const response = await app.request(
      `http://localhost:3000/api/auth/callback?flow=oauth&code=test&app_state=${encodeURIComponent(state)}`,
      { headers: { Cookie: 'hq-oauth=wrong-browser' } },
    );
    expect(response.headers.get('location')).toContain('authError=nonce_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [500, 502],
    [429, 429],
    [200, 202],
  ])('maps provider %i to HTTP %i', async (providerStatus, expectedStatus) => {
    const result = setup(providerStatus);
    const response = await post(
      'magic-link',
      { email: 'test@example.com', turnstileToken: 'valid-test-token', redirectPath: '/claim' },
      result,
    );
    expect(response.status).toBe(expectedStatus);
    expect(await response.text()).not.toContain('private SMTP diagnostic');
  });

  it('keeps the cookie view current during an auth exchange', () => {
    const jar = new CookieJar(new Map(), true);
    jar.set('session', 'new-value');
    expect(jar.getAll()).toEqual([{ name: 'session', value: 'new-value' }]);
    jar.set('session', '', { maxAge: 0 });
    expect(jar.getAll()).toEqual([]);
  });
});
