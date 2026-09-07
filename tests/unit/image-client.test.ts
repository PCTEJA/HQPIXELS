import { afterEach, expect, it, vi } from 'vitest';
import { createImageClient } from '../../worker/lib/images';
import { fakeConfig } from '../integration/test-helpers';

afterEach(() => vi.unstubAllGlobals());

it('preserves the global fetch receiver for every Images operation', async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', function (this: unknown, _url: RequestInfo | URL, init?: RequestInit) {
    // Workers rejects a native fetch invoked with the image client as `this`.
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    calls.push(init ?? {});
    if (init?.method === 'POST') {
      return Promise.resolve(
        Response.json({
          success: true,
          result: {
            id: 'image-test',
            uploadURL: 'https://upload.imagedelivery.net/test/image-test',
          },
        }),
      );
    }
    if (init?.method === 'PATCH' || init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-2/3' },
      }),
    );
  });
  const client = createImageClient(fakeConfig());
  const ticket = await client.createDirectUpload({
    ownerId: 'owner-test',
    reservationId: 'hold-test',
  });
  expect(ticket.imageAssetId).toBe('image-test');
  expect((calls[0]?.body as FormData).get('requireSignedURLs')).toBe('true');
  expect(await client.fetchForValidation(ticket.imageAssetId)).toEqual({
    bytes: new Uint8Array([1, 2, 3]),
    totalBytes: 3,
  });
  await client.publish(ticket.imageAssetId);
  await client.delete(ticket.imageAssetId);
  expect(calls.map((call) => call.method ?? 'GET')).toEqual(['POST', 'GET', 'PATCH', 'DELETE']);
});
