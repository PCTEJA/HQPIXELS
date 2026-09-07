import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../worker/context';
import { normalizeImageDeliveryBase } from '../../worker/env';
import { createCheckoutSession, createStripeClient } from '../../worker/lib/stripe';
import { reservationRoutes } from '../../worker/routes/reservations';
import { ApiError } from '../../worker/lib/errors';
import { fakeConfig, fakeDeps } from '../integration/test-helpers';

it('removes dashboard image and variant placeholders from the delivery base', () => {
  expect(
    normalizeImageDeliveryBase('https://imagedelivery.net/account/<image_id>/<variant_name>'),
  ).toBe('https://imagedelivery.net/account');
  expect(
    normalizeImageDeliveryBase(
      'https://imagedelivery.net/account/%3Cimage_id%3E/%3Cvariant_name%3E',
    ),
  ).toBe('https://imagedelivery.net/account');
});

it('explicitly uses standard card Checkout despite account Managed Payments defaults', async () => {
  const expires = Math.floor(Date.now() / 1000) + 2400;
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      id: 'cs_test',
      url: 'https://checkout.stripe.com/test',
      expires_at: expires,
      amount_total: 1000,
    }),
  );
  const result = await createCheckoutSession(createStripeClient(fakeConfig(), fetchImpl), {
    reservationId: 'hold',
    placementId: 'plot',
    ownerId: 'owner',
    buyerEmail: 'test@example.com',
    amountCents: 1000,
    cells: 1,
    logicalPixels: 100,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    pricingVersion: 1,
    checkoutAttempt: 1,
    expiresAtEpoch: expires,
    siteUrl: 'https://hqpixels.com',
  });
  expect(result.amountTotal).toBe(1000);
  const init = fetchImpl.mock.calls[0]?.[1];
  if (typeof init?.body !== 'string') throw new Error('Expected form-encoded Stripe request');
  const body = new URLSearchParams(init.body);
  expect(body.has('payment_intent_data[statement_descriptor_suffix]')).toBe(false);
  expect(body.get('managed_payments[enabled]')).toBe('false');
  expect(body.get('payment_method_types[0]')).toBe('card');
  expect(body.get('line_items[0][price_data][unit_amount]')).toBe('1000');
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
    'hqpixels:checkout:hold:1:standard-v1',
  );
});

const holdId = '48cf1b20-129b-441f-88d9-65211272a98f';

it('releases the authenticated owner hold and returns a non-cacheable response', async () => {
  const { app, deps } = previewApp(true);
  const cancel = vi.fn().mockResolvedValue({ ok: true, cellsReleased: 1 });
  deps.db.cancelReservation = cancel;
  const response = await app.request(`/api/reservations/${holdId}/cancel`, { method: 'POST' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ removed: true, cellsReleased: 1 });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(cancel).toHaveBeenCalledWith(holdId, 'owner');
});

it.each(['not_found', 'reservation_state_invalid'])(
  'does not report removal for %s',
  async (code) => {
    const { app, deps } = previewApp(true);
    deps.db.cancelReservation = vi.fn().mockResolvedValue({ ok: false, code });
    const response = await app.request(`/api/reservations/${holdId}/cancel`, { method: 'POST' });
    expect(response.status).toBe(code === 'not_found' ? 404 : 409);
  },
);

it('requires authentication to remove a hold', async () => {
  const { app, deps } = previewApp(true, false);
  const cancel = vi.fn();
  deps.db.cancelReservation = cancel;
  const response = await app.request(`/api/reservations/${holdId}/cancel`, { method: 'POST' });
  expect(response.status).toBe(401);
  expect(cancel).not.toHaveBeenCalled();
});
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
);

// The header sniffer enforces a minimum 10 x 10 image.
new DataView(png.buffer).setUint32(16, 10);
new DataView(png.buffer).setUint32(20, 10);

function previewApp(ownsHold: boolean, signedIn = true) {
  const deps = fakeDeps();
  deps.db.reservationDetail = vi
    .fn()
    .mockResolvedValue(
      ownsHold
        ? { ok: true, reservation: {}, placement: { imagePath: 'image-id/wall' } }
        : { ok: false, code: 'not_found' },
    );
  const fetchPreview = vi.fn().mockResolvedValue(png);
  deps.images.fetchPreview = fetchPreview;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('sessionResolved', {
      user: signedIn
        ? {
            id: 'owner',
            email: 'test@example.com',
            emailVerified: true,
            isAdmin: false,
            foundingBuyer: false,
            displayName: null,
            handle: null,
          }
        : null,
    });
    await next();
  });
  app.onError((error) =>
    Response.json(
      { error: error.message },
      { status: error instanceof ApiError ? error.status : 500 },
    ),
  );
  app.route('/api/reservations', reservationRoutes);
  return { app, deps, fetchPreview };
}

it('serves an owner-only, non-cacheable private artwork preview', async () => {
  const { app } = previewApp(true);
  const response = await app.request(`/api/reservations/${holdId}/artwork`);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  const detail = await app.request(`/api/reservations/${holdId}`);
  expect((await detail.json()).placement.imageUrl).toBe(`/api/reservations/${holdId}/artwork`);
});

it.each([
  [false, true, 404],
  [true, false, 401],
])('denies unauthorized preview (%s, %s)', async (owns, signedIn, status) => {
  const { app, fetchPreview } = previewApp(owns, signedIn);
  const response = await app.request(`/api/reservations/${holdId}/artwork`);
  expect(response.status).toBe(status);
  expect(fetchPreview).not.toHaveBeenCalled();
});
