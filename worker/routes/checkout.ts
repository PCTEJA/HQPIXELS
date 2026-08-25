/**
 * Checkout Session creation.
 *
 * Controls applied here, in order, matching the brief's requirements:
 *
 *   1. authenticated AND email-verified buyer          (requireVerifiedUser)
 *   2. valid CSRF token and same-origin request        (global middleware)
 *   3. Turnstile verification, bound to the 'checkout' action
 *   4. strict rate limit, per user AND per reservation
 *   5. reservation ownership, state and non-expiration  (database)
 *   6. price computed server-side from immutable reservation data
 *   7. one active Checkout Session per reservation      (partial unique index)
 *   8. Stripe idempotency key from reservation id + attempt counter
 *   9. a single line item with a server-generated integer total
 *  10. session expiry clamped so it never outlives the hold
 *
 * The client sends only a reservation id and a Turnstile token. There is no
 * amount, currency, quantity, line item, price id or success URL in the request
 * body — those fields do not exist in the schema, so tampering has nothing to
 * tamper with.
 */

import { Hono } from 'hono';
import { CHECKOUT_MIN_REMAINING_SECONDS, STRIPE_CHECKOUT_MIN_TTL_SECONDS } from '@shared/constants';
import { createCheckoutSchema, reservationIdParamSchema } from '@shared/schemas';
import type { AppEnv } from '../context';
import { requireVerifiedUser } from '../context';
import { ApiError, validationFailed, zodFieldErrors } from '../lib/errors';
import { NO_STORE } from '../lib/cache';
import { audit, auditSecurityEvent } from '../lib/audit';
import { createCheckoutSession } from '../lib/stripe';
import { isOk } from '../lib/supabase';

export const checkoutRoutes = new Hono<AppEnv>();

// -----------------------------------------------------------------------------
// POST /api/checkout/session
// -----------------------------------------------------------------------------
checkoutRoutes.post('/session', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');
  const user = await requireVerifiedUser(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createCheckoutSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }
  const { reservationId, turnstileToken } = parsed.data;

  // --- 3. Turnstile -----------------------------------------------------------
  const turnstile = await deps.verifyTurnstile({
    token: turnstileToken,
    action: 'checkout',
    remoteIp: c.get('clientIp'),
  });
  if (!turnstile.ok) {
    auditSecurityEvent(
      auditCtx,
      'security.turnstile_rejected',
      { action: 'checkout', reason: turnstile.reason },
      user.id,
    );
    throw new ApiError('turnstile_failed');
  }

  // --- 4. rate limit, per user and per reservation ----------------------------
  // Per-reservation as well as per-user: without it, one buyer with several
  // reservations could hammer Stripe's session-creation endpoint within their
  // per-user allowance.
  for (const key of [`user:${user.id}`, `res:${reservationId}`]) {
    const decision = await deps.rateLimiter.consume('checkout', key);
    if (!decision.allowed) {
      auditSecurityEvent(auditCtx, 'security.rate_limited', { policy: 'checkout', key }, user.id);
      throw new ApiError('rate_limited', {
        retryAfter: decision.retryAfter,
        message: 'Too many payment attempts. Wait a moment before trying again.',
      });
    }
  }

  // --- 5. ownership, state, expiry (from the database) ------------------------
  const detail = await deps.db.reservationDetail(reservationId, user.id);
  if (!isOk(detail)) {
    auditSecurityEvent(
      auditCtx,
      'security.idor_attempt',
      { resource: 'checkout', reservationId },
      user.id,
    );
    throw new ApiError('not_found');
  }

  const reservation = (
    detail as unknown as {
      reservation: {
        id: string;
        state: string;
        x: number;
        y: number;
        w: number;
        h: number;
        cells: number;
        logicalPixels: number;
        totalCents: number;
        currency: string;
        pricingVersion: number;
        expiresAt: string;
        checkoutAttempt: number;
        acceptedTermsVersion: string | null;
      };
      placement: {
        id: string;
        status: string;
        imagePath: string | null;
        destinationUrl: string | null;
      };
    }
  ).reservation;
  const placement = (
    detail as unknown as {
      placement: {
        id: string;
        status: string;
        imagePath: string | null;
        destinationUrl: string | null;
      };
    }
  ).placement;

  if (reservation.state === 'checkout_created') {
    // Handled below by open_checkout, which returns the existing session so a
    // double click lands the buyer on the same Stripe page.
  } else if (!['ready_for_checkout', 'payment_failed'].includes(reservation.state)) {
    throw new ApiError('reservation_state_invalid', {
      message:
        reservation.state === 'reserved'
          ? 'Add your artwork, title and destination link before paying.'
          : 'This claim is not ready for payment.',
      logContext: { state: reservation.state },
    });
  }

  // Terms must have been accepted for THIS reservation, not merely at some point
  // by this account.
  if (reservation.acceptedTermsVersion === null || reservation.acceptedTermsVersion === '') {
    throw new ApiError('reservation_state_invalid', {
      message: 'Accept the terms and content policy before paying.',
      logContext: { reason: 'terms_not_accepted' },
    });
  }

  // Defence in depth: the database CHECK already prevents publishing an
  // incomplete placement, but taking money for one would still be wrong.
  if (placement.imagePath === null || placement.destinationUrl === null) {
    throw new ApiError('reservation_state_invalid', {
      message: 'Add your artwork and destination link before paying.',
      logContext: { reason: 'placement_incomplete' },
    });
  }

  // --- 10. expiry arithmetic --------------------------------------------------
  const nowMs = deps.now();
  const expiresAtMs = new Date(reservation.expiresAt).getTime();
  const remainingSeconds = Math.floor((expiresAtMs - nowMs) / 1000);

  if (remainingSeconds <= 0) {
    throw new ApiError('reservation_expired');
  }

  // Stripe requires expires_at at least 30 minutes out. If the hold has less
  // than that left we cannot create a session that expires before the hold does,
  // and we refuse rather than break the invariant.
  if (remainingSeconds < CHECKOUT_MIN_REMAINING_SECONDS) {
    throw new ApiError('checkout_window_too_short', {
      logContext: { remainingSeconds, required: CHECKOUT_MIN_REMAINING_SECONDS },
    });
  }

  // Land exactly on the hold's expiry when possible, but never before Stripe's
  // 30 minute floor. Given the check above, the floor is always satisfiable.
  const sessionExpiryEpoch = Math.max(
    Math.floor(expiresAtMs / 1000),
    Math.floor(nowMs / 1000) + STRIPE_CHECKOUT_MIN_TTL_SECONDS,
  );
  // ...and clamp back down so the session can never outlive the hold.
  const clampedExpiryEpoch = Math.min(sessionExpiryEpoch, Math.floor(expiresAtMs / 1000));

  if (clampedExpiryEpoch * 1000 <= nowMs + STRIPE_CHECKOUT_MIN_TTL_SECONDS * 1000 - 1000) {
    // Belt and braces: if the clamp ever produced something Stripe would reject,
    // fail loudly rather than sending an invalid request.
    throw new ApiError('checkout_window_too_short', {
      logContext: { clampedExpiryEpoch, nowMs, severity: 'high' },
    });
  }

  // --- 8/9. create the session ------------------------------------------------
  // The attempt counter is bumped by open_checkout, so the key we send Stripe
  // must use the NEXT value. Doing it in this order means the database is the
  // source of truth for the counter and a crash between the two leaves a unique
  // key unused rather than reused.
  const nextAttempt = reservation.checkoutAttempt + 1;

  let session;
  try {
    session = await createCheckoutSession(deps.stripe(), {
      reservationId: reservation.id,
      placementId: placement.id,
      ownerId: user.id,
      buyerEmail: user.email,
      // Straight from the immutable reservation row.
      amountCents: reservation.totalCents,
      cells: reservation.cells,
      logicalPixels: reservation.logicalPixels,
      rect: { x: reservation.x, y: reservation.y, w: reservation.w, h: reservation.h },
      pricingVersion: reservation.pricingVersion,
      checkoutAttempt: nextAttempt,
      expiresAtEpoch: clampedExpiryEpoch,
      siteUrl: deps.config.siteUrl,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'checkout_window_too_short') {
      throw new ApiError('checkout_window_too_short');
    }
    logger.error('stripe_session_create_failed', {
      reservationId: reservation.id,
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    });
    throw new ApiError('upstream_unavailable', {
      message: 'Our payment provider is not responding. No charge has been made.',
      cause: error,
    });
  }

  // Stripe's own answer must match what we asked for. If it does not, do not
  // record the session — refuse and alert.
  if (session.amountTotal !== null && session.amountTotal !== reservation.totalCents) {
    logger.error('stripe_amount_disagreement', {
      reservationId: reservation.id,
      expected: reservation.totalCents,
      stripeReported: session.amountTotal,
      severity: 'critical',
    });
    throw new ApiError('internal_error', {
      message: 'We could not confirm the payment amount. Nothing has been charged.',
    });
  }

  // --- 7. record it, or discover a session is already open --------------------
  const opened = await deps.db.openCheckout({
    reservationId: reservation.id,
    ownerId: user.id,
    sessionId: session.sessionId,
    amountCents: reservation.totalCents,
    expiresAt: session.expiresAt,
  });

  if (!isOk(opened)) {
    if (opened.code === 'checkout_already_open') {
      const existingSessionId =
        typeof opened.existingSessionId === 'string' ? opened.existingSessionId : null;

      logger.info('checkout_already_open', {
        reservationId: reservation.id,
        existingSessionId,
      });

      // Idempotent from the buyer's point of view: send them to the session that
      // already exists. Because Stripe's idempotency key is derived from
      // (reservation, attempt), the session we just created for a repeated click
      // IS the same object, so there is no orphan and no double charge.
      if (existingSessionId !== null) {
        const existingUrl =
          existingSessionId === session.sessionId
            ? session.url
            : `${deps.config.siteUrl}/claim/resume?reservation=${reservation.id}`;
        return c.json(
          {
            url: existingUrl,
            sessionId: existingSessionId,
            expiresAt:
              typeof opened.existingExpiresAt === 'string'
                ? opened.existingExpiresAt
                : session.expiresAt,
            reused: true,
          },
          200,
          { 'Cache-Control': NO_STORE },
        );
      }

      throw new ApiError('checkout_already_open');
    }

    if (opened.code === 'reservation_expired') throw new ApiError('reservation_expired');
    if (opened.code === 'not_found') throw new ApiError('not_found');

    throw new ApiError('reservation_state_invalid', { logContext: { code: opened.code } });
  }

  audit(auditCtx, {
    action: 'checkout.session_created',
    targetType: 'reservation',
    targetId: reservation.id,
    actorId: user.id,
    actorLabel: 'buyer',
    detail: {
      sessionId: session.sessionId,
      amountCents: reservation.totalCents,
      checkoutAttempt: opened.checkoutAttempt,
      expiresAt: session.expiresAt,
    },
  });

  logger.info('checkout_session_created', {
    reservationId: reservation.id,
    sessionId: session.sessionId,
    amountCents: reservation.totalCents,
    checkoutAttempt: opened.checkoutAttempt,
  });

  return c.json(
    {
      url: session.url,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      reused: false,
    },
    201,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// GET /api/checkout/status/:reservationId
// -----------------------------------------------------------------------------
/**
 * What the success page polls.
 *
 * Read-only, and structurally so: the RPC behind it is declared STABLE in
 * PostgreSQL, which means it cannot perform a write. Refreshing the success page
 * a hundred times cannot publish a placement or settle a payment — only a
 * signature-verified webhook (or the reconciler) can do that.
 */
checkoutRoutes.get('/status/:reservationId', async (c) => {
  const deps = c.get('deps');
  const user = await requireVerifiedUser(c);

  const parsed = reservationIdParamSchema.safeParse({
    reservationId: c.req.param('reservationId'),
  });
  if (!parsed.success) throw new ApiError('not_found');

  const status = await deps.db.reservationStatus(parsed.data.reservationId, user.id);
  if (!isOk(status)) throw new ApiError('not_found');

  const record = status as unknown as {
    reservationId: string;
    reservationState: string;
    paymentStatus: string;
    placementStatus: string;
    placementId: string | null;
    amountCents: number;
    currency: string;
    fulfilled: boolean;
    moderationNote: string | null;
  };

  return c.json(
    {
      reservationId: record.reservationId,
      reservationState: record.reservationState,
      paymentStatus: record.paymentStatus,
      placementStatus: record.placementStatus,
      amountCents: record.amountCents,
      currency: record.currency,
      fulfilled: record.fulfilled,
      shareUrl:
        record.placementStatus === 'active' && record.placementId !== null
          ? `${deps.config.siteUrl}/wall?focus=${record.placementId}`
          : null,
      moderationNote: record.moderationNote,
      // Sets expectations honestly instead of implying it is already live.
      nextStep:
        record.reservationState === 'paid_pending_review'
          ? 'Your payment is confirmed. A person reviews every placement before it appears on the wall.'
          : record.reservationState === 'active'
            ? 'Your placement is live.'
            : record.reservationState === 'checkout_created'
              ? 'We are waiting for Stripe to confirm your payment. This page updates automatically.'
              : null,
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});
