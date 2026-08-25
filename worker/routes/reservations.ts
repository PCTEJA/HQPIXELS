/**
 * Reservation endpoints — where inventory gets locked.
 *
 * Every route here: authenticated, email-verified, CSRF- and origin-checked (by
 * global middleware), Turnstile-verified, rate limited on two windows, and
 * server-authoritative on price. The database RPC re-checks all of it.
 */

import { Hono } from 'hono';
import {
  CHECKOUT_MIN_REMAINING_SECONDS,
  MAX_UPLOAD_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
} from '@shared/constants';
import {
  acceptTermsSchema,
  createReservationSchema,
  placementDetailsSchema,
  reservationIdParamSchema,
} from '@shared/schemas';
import { computeQuote } from '@shared/pricing';
import { urlManualReviewReasons } from '@shared/url-safety';
import type { AppContext, AppEnv } from '../context';
import { requireVerifiedUser } from '../context';
import { ApiError, validationFailed, zodFieldErrors } from '../lib/errors';
import { NO_STORE } from '../lib/cache';
import { audit, auditSecurityEvent } from '../lib/audit';
import { pricingVersionFromRowChecked } from '../lib/pricing-adapter';
import { absoluteImageUrl, isPlausibleUploadSize, sniffImage } from '../lib/images';
import { isOk } from '../lib/supabase';

export const reservationRoutes = new Hono<AppEnv>();

/** The terms version a buyer must accept. Bump when the terms change materially. */
export const CURRENT_TERMS_VERSION = '2026-08-01';

// -----------------------------------------------------------------------------
// POST /api/reservations
// -----------------------------------------------------------------------------
reservationRoutes.post('/', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');
  const user = await requireVerifiedUser(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createReservationSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }
  const input = parsed.data;

  if (input.acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
    throw validationFailed({
      message: 'Our terms have been updated. Reload the page and review them before continuing.',
      fields: { acceptedTermsVersion: 'Outdated terms version.' },
      logContext: { submitted: input.acceptedTermsVersion, current: CURRENT_TERMS_VERSION },
    });
  }

  const turnstile = await deps.verifyTurnstile({
    token: input.turnstileToken,
    action: 'reserve',
    remoteIp: c.get('clientIp'),
  });
  if (!turnstile.ok) {
    auditSecurityEvent(
      auditCtx,
      'security.turnstile_rejected',
      { action: 'reserve', reason: turnstile.reason },
      user.id,
    );
    throw new ApiError('turnstile_failed', { logContext: { reason: turnstile.reason } });
  }

  // Two windows: a burst limit and an hourly limit. Both keyed to the user, so a
  // botnet with many IPs still cannot park inventory under one account.
  for (const policy of ['reserveBurst', 'reserveHourly'] as const) {
    const decision = await deps.rateLimiter.consume(policy, user.id);
    if (!decision.allowed) {
      auditSecurityEvent(auditCtx, 'security.rate_limited', { policy }, user.id);
      throw new ApiError('rate_limited', {
        retryAfter: decision.retryAfter,
        logContext: { policy },
      });
    }
  }

  // --- authoritative price -----------------------------------------------------
  const row = await deps.db.activePricingVersion();
  if (row === null) {
    throw new ApiError('maintenance', {
      logContext: { reason: 'no_active_pricing_version', severity: 'critical' },
    });
  }

  const { pricing, droppedZones } = pricingVersionFromRowChecked(row);
  if (droppedZones > 0) {
    // A malformed zone changes the price, so this is never just noise.
    logger.error('pricing_zone_malformed', {
      pricingVersion: pricing.version,
      droppedZones,
      severity: 'high',
    });
  }

  // The client tells us which version it *saw*. If the active version has moved
  // on, the price it displayed is stale and we must not silently charge the new
  // one.
  if (input.pricingVersion !== pricing.version) {
    throw new ApiError('quote_changed', {
      message: 'Our pricing changed while you were choosing. Review the new total before claiming.',
      logContext: { submitted: input.pricingVersion, active: pricing.version },
    });
  }

  let quote;
  try {
    quote = computeQuote(pricing, input.rect);
  } catch (error) {
    throw validationFailed({
      message: error instanceof Error ? error.message : 'That selection is not valid.',
      logContext: { rect: input.rect },
    });
  }

  // Client disagreement is a user-facing condition, not an error. It happens
  // legitimately when a zone multiplier changes mid-session.
  if (quote.totalCents !== input.expectedTotalCents) {
    logger.info('quote_mismatch', {
      expected: input.expectedTotalCents,
      actual: quote.totalCents,
      userId: user.id,
    });
    return c.json(
      {
        error: {
          code: 'quote_changed',
          message: 'The price for that selection changed. Review the new total before claiming.',
          requestId: c.get('requestId'),
        },
        quote,
      },
      409,
      { 'Cache-Control': NO_STORE },
    );
  }

  // --- the atomic claim --------------------------------------------------------
  const result = await deps.db.reserveCells({
    ownerId: user.id,
    x: input.rect.x,
    y: input.rect.y,
    w: input.rect.w,
    h: input.rect.h,
    pricingVersion: pricing.version,
    expectedTotalCents: input.expectedTotalCents,
    // Cross-checked against the database's own computation. A mismatch raises
    // inside the RPC and never charges anyone.
    workerTotalCents: quote.totalCents,
    quoteBreakdown: { lines: quote.lines, baseCents: quote.baseCents },
    termsVersion: input.acceptedTermsVersion,
    ipPrefix: c.get('ipPrefix'),
  });

  if (!isOk(result)) {
    return respondToReserveFailure(c, result, quote);
  }

  audit(auditCtx, {
    action: 'reservation.created',
    targetType: 'reservation',
    targetId: result.reservation.id,
    actorId: user.id,
    actorLabel: 'buyer',
    detail: {
      rect: `${input.rect.x},${input.rect.y},${input.rect.w},${input.rect.h}`,
      cells: result.reservation.cells,
      totalCents: result.reservation.totalCents,
      pricingVersion: pricing.version,
      termsVersion: input.acceptedTermsVersion,
    },
  });

  logger.info('reservation_created', {
    reservationId: result.reservation.id,
    cells: result.reservation.cells,
    totalCents: result.reservation.totalCents,
  });

  return c.json(
    {
      reservation: {
        id: result.reservation.id,
        state: result.reservation.state,
        rect: {
          x: result.reservation.x,
          y: result.reservation.y,
          w: result.reservation.w,
          h: result.reservation.h,
        },
        cells: result.reservation.cells,
        logicalPixels: result.reservation.logicalPixels,
        totalCents: result.reservation.totalCents,
        currency: result.reservation.currency,
        pricingVersion: result.reservation.pricingVersion,
        expiresAt: result.reservation.expiresAt,
        createdAt: result.reservation.createdAt,
      },
      quote,
      placement: {
        id: result.placementId,
        status: 'draft',
        title: '',
        altText: '',
        destinationHost: null,
        imageUrl: null,
      },
      upload: {
        maxBytes: MAX_UPLOAD_BYTES,
        allowedTypes: ALLOWED_IMAGE_MIME_TYPES,
      },
    },
    201,
    { 'Cache-Control': NO_STORE },
  );
});

/**
 * Turn an RPC refusal into an honest HTTP response.
 *
 * Kept as a single function so every failure code has a defined, reviewed
 * mapping — the alternative is a chain of ifs where a new code silently becomes
 * a 500.
 */
function respondToReserveFailure(
  c: AppContext,
  result: { ok: false; code: string; [key: string]: unknown },
  quote: unknown,
): Response {
  const requestId = c.get('requestId');
  const headers = { 'Cache-Control': NO_STORE };

  switch (result.code) {
    case 'cells_unavailable':
      return c.json(
        {
          error: {
            code: 'cells_unavailable',
            message: 'Someone claimed part of that area first. Choose another spot.',
            requestId,
          },
        },
        409,
        headers,
      );

    case 'cells_contended':
      // Two overlapping requests interleaved. Genuinely worth retrying.
      return c.json(
        {
          error: {
            code: 'conflict',
            message: 'That area is busy right now. Try again in a moment.',
            requestId,
            retryAfter: 2,
          },
        },
        409,
        headers,
      );

    case 'quote_changed':
      return c.json(
        {
          error: {
            code: 'quote_changed',
            message: 'The price for that selection changed. Review the new total.',
            requestId,
          },
          quote,
          totalCents: result.totalCents,
        },
        409,
        headers,
      );

    case 'too_many_open_reservations':
      return c.json(
        {
          error: {
            code: 'conflict',
            message:
              'You already have the maximum number of unpaid holds. Complete or cancel one before claiming more space.',
            requestId,
          },
        },
        409,
        headers,
      );

    case 'held_cell_limit_exceeded':
      return c.json(
        {
          error: {
            code: 'conflict',
            message:
              'That would exceed the amount of space one buyer can hold at once. Complete a purchase first.',
            requestId,
          },
        },
        409,
        headers,
      );

    case 'email_unverified':
      return c.json(
        {
          error: {
            code: 'email_unverified',
            message: 'Confirm your email address before claiming space.',
            requestId,
          },
        },
        403,
        headers,
      );

    case 'pricing_version_inactive':
      return c.json(
        {
          error: {
            code: 'quote_changed',
            message: 'Our pricing changed. Reload to see the current price.',
            requestId,
          },
        },
        409,
        headers,
      );

    case 'invalid_rect':
    case 'selection_too_small':
    case 'selection_too_large':
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'That selection is not a valid size or position.',
            requestId,
          },
        },
        422,
        headers,
      );

    case 'owner_not_found':
      // The session resolved but the profile is gone. Treat as a broken session.
      return c.json(
        {
          error: {
            code: 'unauthenticated',
            message: 'Please sign in again.',
            requestId,
          },
        },
        401,
        headers,
      );

    default:
      c.get('logger').error('reserve_unmapped_failure', { code: result.code, severity: 'high' });
      return c.json(
        {
          error: {
            code: 'internal_error',
            message: 'We could not complete that claim. Nothing has been charged.',
            requestId,
          },
        },
        500,
        headers,
      );
  }
}

// -----------------------------------------------------------------------------
// GET /api/reservations/:reservationId
// -----------------------------------------------------------------------------
reservationRoutes.get('/:reservationId', async (c) => {
  const deps = c.get('deps');
  const user = await requireVerifiedUser(c);

  const parsed = reservationIdParamSchema.safeParse({
    reservationId: c.req.param('reservationId'),
  });
  if (!parsed.success) throw new ApiError('not_found');

  const result = await deps.db.reservationDetail(parsed.data.reservationId, user.id);

  // The RPC filters by owner_id, so "not found" here covers both "does not
  // exist" and "belongs to someone else" — deliberately indistinguishable.
  if (!isOk(result)) {
    if (result.code === 'not_found') {
      auditSecurityEvent(
        c.get('auditContext'),
        'security.idor_attempt',
        { resource: 'reservation', reservationId: parsed.data.reservationId },
        user.id,
      );
    }
    throw new ApiError('not_found');
  }

  const placement = (result as unknown as { placement: Record<string, unknown> }).placement;
  const imagePath = typeof placement.imagePath === 'string' ? placement.imagePath : null;

  return c.json(
    {
      reservation: (result as unknown as { reservation: unknown }).reservation,
      placement: { ...placement, imageUrl: absoluteImageUrl(deps.config, imagePath) },
      checkoutMinRemainingSeconds: CHECKOUT_MIN_REMAINING_SECONDS,
      termsVersion: CURRENT_TERMS_VERSION,
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// PATCH /api/reservations/:reservationId/details
// -----------------------------------------------------------------------------
reservationRoutes.patch('/:reservationId/details', async (c) => {
  const deps = c.get('deps');
  const auditCtx = c.get('auditContext');
  const user = await requireVerifiedUser(c);

  const body = await c.req.json().catch(() => null);
  const parsed = placementDetailsSchema.safeParse({
    ...(typeof body === 'object' && body !== null ? body : {}),
    reservationId: c.req.param('reservationId'),
  });
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }

  const decision = await deps.rateLimiter.consume('placementUpdate', user.id);
  if (!decision.allowed) {
    throw new ApiError('rate_limited', { retryAfter: decision.retryAfter });
  }

  const { reservationId, title, altText, destinationUrl } = parsed.data;

  // `destinationUrl` has already been normalised and validated by the schema
  // transform, so what reaches the database is canonical, not raw input.
  const reviewReasons = urlManualReviewReasons(destinationUrl);

  // Automated checks recorded alongside the decision so a moderator sees why
  // something was queued.
  const checks = [
    {
      check: 'destination_url_syntax',
      result: 'pass',
      detail: `host=${destinationUrl.host} https=${destinationUrl.isHttps}`,
    },
    ...reviewReasons.map((reason) => ({
      check: `destination_${reason}`,
      result: 'flag' as const,
      detail: reason,
    })),
  ];

  const result = await deps.db.setPlacementDetails({
    reservationId,
    ownerId: user.id,
    title,
    altText,
    destinationUrl: destinationUrl.url,
    destinationHost: destinationUrl.host,
    // A flagged URL still requires a human, but never blocks payment: taking the
    // money and reviewing before publishing is the documented flow.
    moderationState: reviewReasons.length > 0 ? 'auto_flag' : 'auto_pass',
    checks,
  });

  if (!isOk(result)) {
    if (result.code === 'not_found') {
      auditSecurityEvent(
        auditCtx,
        'security.idor_attempt',
        { resource: 'reservation_details', reservationId },
        user.id,
      );
      throw new ApiError('not_found');
    }
    if (result.code === 'reservation_expired') throw new ApiError('reservation_expired');
    throw new ApiError('reservation_state_invalid', { logContext: { code: result.code } });
  }

  audit(auditCtx, {
    action: 'reservation.details_set',
    targetType: 'reservation',
    targetId: reservationId,
    actorId: user.id,
    actorLabel: 'buyer',
    detail: {
      host: destinationUrl.host,
      https: destinationUrl.isHttps,
      flags: reviewReasons.join(',') || 'none',
      ready: result.ready,
    },
  });

  return c.json(
    {
      ready: result.ready,
      state: result.state,
      placementId: result.placementId,
      destinationHost: destinationUrl.host,
      manualReviewReasons: reviewReasons,
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// POST /api/reservations/:reservationId/accept-terms
// -----------------------------------------------------------------------------
reservationRoutes.post('/:reservationId/accept-terms', async (c) => {
  const deps = c.get('deps');
  const user = await requireVerifiedUser(c);

  const body = await c.req.json().catch(() => null);
  // Both booleans are `z.literal(true)`, so a missing or falsy value is a
  // validation error. That is what makes a pre-checked box impossible: the
  // server never infers consent, it requires an explicit true.
  const parsed = acceptTermsSchema.safeParse({
    ...(typeof body === 'object' && body !== null ? body : {}),
    reservationId: c.req.param('reservationId'),
  });
  if (!parsed.success) {
    throw validationFailed({
      message: 'You need to accept the terms and content policy to continue.',
      fields: zodFieldErrors(parsed.error.issues),
    });
  }

  if (parsed.data.termsVersion !== CURRENT_TERMS_VERSION) {
    throw validationFailed({
      message: 'Our terms have been updated. Please review the current version.',
      fields: { termsVersion: 'Outdated terms version.' },
    });
  }

  // Argument order is (userId, reservationId, termsVersion) — both are UUIDs, so
  // a swap would type-check and silently look up the wrong row.
  const result = await deps.db.recordTermsAcceptance(
    user.id,
    parsed.data.reservationId,
    parsed.data.termsVersion,
  );

  if (!isOk(result)) {
    if (result.code === 'not_found') throw new ApiError('not_found');
    throw new ApiError('reservation_state_invalid', { logContext: { code: result.code } });
  }

  audit(c.get('auditContext'), {
    action: 'reservation.terms_accepted',
    targetType: 'reservation',
    targetId: parsed.data.reservationId,
    actorId: user.id,
    actorLabel: 'buyer',
    detail: { termsVersion: parsed.data.termsVersion },
  });

  return c.json({ accepted: true, termsVersion: result.termsVersion }, 200, {
    'Cache-Control': NO_STORE,
  });
});

/** Re-exported so the uploads route can share the sniffing helpers. */
export { sniffImage, isPlausibleUploadSize };
