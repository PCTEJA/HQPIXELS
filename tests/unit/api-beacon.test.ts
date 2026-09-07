import { afterEach, describe, expect, it, vi } from 'vitest';
import { beacon, setCsrfToken } from '../../src/lib/api';
import { CSRF_HEADER } from '@shared/constants';

afterEach(() => {
  setCsrfToken(null);
  vi.unstubAllGlobals();
});

describe('analytics beacons', () => {
  it('bootstraps CSRF before the first page view and preserves keepalive', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'fresh-token' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    beacon('/api/public/view', { path: '/wall' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/session');
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/public/view',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: expect.objectContaining({ [CSRF_HEADER]: 'fresh-token' }),
      }),
    ]);
  });

  it('refreshes a stale token once and retries the beacon', async () => {
    setCsrfToken('stale-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'csrf_failed' } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ csrfToken: 'new-token' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    beacon('/api/public/impressions', { ids: [] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        keepalive: true,
        headers: expect.objectContaining({ [CSRF_HEADER]: 'new-token' }),
      }),
    );
  });

  it('swallows network failures', async () => {
    setCsrfToken('token');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    expect(beacon('/api/public/view', {})).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
