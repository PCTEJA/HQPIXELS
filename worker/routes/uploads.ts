/**
 * Image upload endpoints.
 *
 * The flow, and why it has three steps rather than one:
 *
 *   1. POST /api/uploads/ticket
 *      We authenticate, check ownership of the reservation, verify Turnstile and
 *      rate limit, and only THEN ask Cloudflare for a one-time upload URL. The
 *      browser never has a standing upload capability.
 *
 *   2. The browser PUTs the file straight to Cloudflare.
 *      The bytes never pass through the Worker, so a 2 MB upload costs us no CPU
 *      and no bandwidth, and a malicious file never enters our runtime.
 *
 *   3. POST /api/uploads/complete
 *      We fetch the first 64 KB back from the provider and validate it for real:
 *      magic bytes, format, dimensions, pixel budget. Only then is the asset
 *      associated with the placement — and it stays private until moderation
 *      approves it.
 *
 * Step 3 is the important one. Step 1's `contentType` and `byteSize` are claims
 * by the client and are used only for early rejection and quota accounting.
 */

import { Hono } from 'hono';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXEL_COUNT,
  MAX_UPLOAD_BYTES,
} from '@shared/constants';
import { uploadCompleteSchema, uploadUrlRequestSchema } from '@shared/schemas';
import type { AppEnv } from '../context';
import { requireVerifiedUser } from '../context';
import { ApiError, validationFailed, zodFieldErrors } from '../lib/errors';
import { NO_STORE } from '../lib/cache';
import { audit, auditSecurityEvent } from '../lib/audit';
import { isPlausibleUploadSize, sniffImage } from '../lib/images';
import { isOk } from '../lib/supabase';

export const uploadRoutes = new Hono<AppEnv>();

// -----------------------------------------------------------------------------
// POST /api/uploads/ticket
// -----------------------------------------------------------------------------
uploadRoutes.post('/ticket', async (c) => {
  const deps = c.get('deps');
  const auditCtx = c.get('auditContext');
  const user = await requireVerifiedUser(c);

  const body = await c.req.json().catch(() => null);
  const parsed = uploadUrlRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }
  const input = parsed.data;

  if (!isPlausibleUploadSize(input.byteSize)) {
    throw new ApiError('payload_too_large', {
      message: `Images must be ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller.`,
    });
  }

  const turnstile = await deps.verifyTurnstile({
    token: input.turnstileToken,
    action: 'upload',
    remoteIp: c.get('clientIp'),
  });
  if (!turnstile.ok) {
    auditSecurityEvent(
      auditCtx,
      'security.turnstile_rejected',
      { action: 'upload', reason: turnstile.reason },
      user.id,
    );
    throw new ApiError('turnstile_failed');
  }

  const decision = await deps.rateLimiter.consume('uploadUrl', user.id);
  if (!decision.allowed) {
    auditSecurityEvent(auditCtx, 'security.rate_limited', { policy: 'uploadUrl' }, user.id);
    throw new ApiError('rate_limited', { retryAfter: decision.retryAfter });
  }

  // Ownership and state, from the database. An upload ticket is only issued for
  // a reservation this user actually holds and can still edit.
  const detail = await deps.db.reservationDetail(input.reservationId, user.id);
  if (!isOk(detail)) {
    auditSecurityEvent(
      auditCtx,
      'security.idor_attempt',
      { resource: 'upload_ticket', reservationId: input.reservationId },
      user.id,
    );
    throw new ApiError('not_found');
  }

  const reservation = (detail as unknown as { reservation: { state: string; expiresAt: string } })
    .reservation;

  if (!['reserved', 'ready_for_checkout'].includes(reservation.state)) {
    throw new ApiError('reservation_state_invalid', {
      message: 'Artwork can only be changed while your hold is active and unpaid.',
      logContext: { state: reservation.state },
    });
  }
  if (new Date(reservation.expiresAt).getTime() <= deps.now()) {
    throw new ApiError('reservation_expired');
  }

  let ticket;
  try {
    ticket = await deps.images.createDirectUpload({
      ownerId: user.id,
      reservationId: input.reservationId,
      expiryMinutes: 15,
    });
  } catch (error) {
    throw new ApiError('upstream_unavailable', {
      message: 'Our image service is not responding. Please try again in a moment.',
      logContext: { stage: 'direct_upload' },
      cause: error,
    });
  }

  audit(auditCtx, {
    action: 'upload.ticket_issued',
    targetType: 'reservation',
    targetId: input.reservationId,
    actorId: user.id,
    actorLabel: 'buyer',
    detail: {
      imageAssetId: ticket.imageAssetId,
      declaredType: input.contentType,
      declaredBytes: input.byteSize,
    },
  });

  return c.json(
    {
      uploadUrl: ticket.uploadUrl,
      imageAssetId: ticket.imageAssetId,
      expiresAt: ticket.expiresAt,
      maxBytes: MAX_UPLOAD_BYTES,
      allowedTypes: ALLOWED_IMAGE_MIME_TYPES,
    },
    201,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// POST /api/uploads/complete
// -----------------------------------------------------------------------------
uploadRoutes.post('/complete', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');
  const user = await requireVerifiedUser(c);

  const body = await c.req.json().catch(() => null);
  const parsed = uploadCompleteSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }
  const { reservationId, imageAssetId } = parsed.data;

  const detail = await deps.db.reservationDetail(reservationId, user.id);
  if (!isOk(detail)) {
    auditSecurityEvent(
      auditCtx,
      'security.idor_attempt',
      { resource: 'upload_complete', reservationId },
      user.id,
    );
    throw new ApiError('not_found');
  }

  const reservation = (detail as unknown as { reservation: { state: string; expiresAt: string } })
    .reservation;
  if (!['reserved', 'ready_for_checkout'].includes(reservation.state)) {
    throw new ApiError('reservation_state_invalid');
  }

  // --- real validation ---------------------------------------------------------
  let bytes: Uint8Array;
  let totalBytes: number;
  try {
    const fetched = await deps.images.fetchForValidation(imageAssetId);
    bytes = fetched.bytes;
    totalBytes = fetched.totalBytes;
  } catch (error) {
    throw new ApiError('upstream_unavailable', {
      message: 'We could not read that upload. Please try again.',
      logContext: { stage: 'fetch_for_validation', imageAssetId },
      cause: error,
    });
  }

  if (totalBytes > MAX_UPLOAD_BYTES) {
    await discard(deps, imageAssetId, logger);
    auditSecurityEvent(
      auditCtx,
      'security.rate_limited',
      { reason: 'upload_oversize', totalBytes },
      user.id,
    );
    throw new ApiError('payload_too_large', {
      message: `That image is ${Math.round(totalBytes / 1024)} KB. The limit is ${Math.floor(
        MAX_UPLOAD_BYTES / 1024,
      )} KB.`,
    });
  }

  const sniffed = sniffImage(bytes);

  if (!sniffed.ok) {
    await discard(deps, imageAssetId, logger);

    audit(auditCtx, {
      action: 'upload.rejected',
      targetType: 'reservation',
      targetId: reservationId,
      actorId: user.id,
      actorLabel: 'buyer',
      detail: { reason: sniffed.reason, detected: sniffed.detected ?? 'unknown', imageAssetId },
    });

    // A polyglot or an SVG dressed as a PNG is a deliberate probe, not a mistake.
    if (sniffed.reason === 'format_not_allowed' || sniffed.reason === 'pixel_budget_exceeded') {
      logger.warn('upload_rejected_suspicious', {
        reason: sniffed.reason,
        detected: sniffed.detected,
        userId: user.id,
        securityEvent: true,
      });
    }

    throw new ApiError('unsupported_media_type', {
      message: uploadRejectionMessage(sniffed.reason, sniffed.detected),
    });
  }

  // Store the safe, re-encoded variant path. The provider re-encodes on
  // delivery, which strips EXIF/XMP and destroys anything appended after the
  // image data.
  const publicPath = `${imageAssetId}/${deps.config.images.publicVariant}`;

  const result = await deps.db.setPlacementDetails({
    reservationId,
    ownerId: user.id,
    title: null,
    altText: null,
    destinationUrl: null,
    destinationHost: null,
    imageAssetId,
    imagePublicPath: publicPath,
    imageWidth: sniffed.width,
    imageHeight: sniffed.height,
    imageBytes: totalBytes,
    imageMime: sniffed.mime,
    moderationState: 'auto_flag',
    checks: [
      { check: 'magic_bytes', result: 'pass', detail: sniffed.mime },
      {
        check: 'dimensions',
        result: 'pass',
        detail: `${sniffed.width}x${sniffed.height} (${sniffed.width * sniffed.height} px)`,
      },
      { check: 'file_size', result: 'pass', detail: `${totalBytes} bytes` },
    ],
  });

  if (!isOk(result)) {
    throw new ApiError('reservation_state_invalid', { logContext: { code: result.code } });
  }

  audit(auditCtx, {
    action: 'upload.validated',
    targetType: 'reservation',
    targetId: reservationId,
    actorId: user.id,
    actorLabel: 'buyer',
    detail: {
      imageAssetId,
      mime: sniffed.mime,
      width: sniffed.width,
      height: sniffed.height,
      bytes: totalBytes,
    },
  });

  return c.json(
    {
      ready: result.ready,
      state: result.state,
      image: {
        width: sniffed.width,
        height: sniffed.height,
        mime: sniffed.mime,
        bytes: totalBytes,
        // A private preview: the asset is still unpublished, so this URL only
        // works for the owner through the dashboard proxy.
        previewPath: publicPath,
      },
      // Told plainly, because an ad that will be stretched looks like a bug.
      renderNote: renderAdviceFor(sniffed.width, sniffed.height, detail),
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});

/**
 * Delete a rejected asset immediately.
 *
 * Never throws: a failed cleanup must not turn a correct rejection into a 500.
 * The orphan is swept by the daily job.
 */
async function discard(
  deps: { images: { delete(id: string): Promise<void> } },
  imageAssetId: string,
  logger: { warn: (msg: string, fields?: Record<string, unknown>) => void },
): Promise<void> {
  try {
    await deps.images.delete(imageAssetId);
  } catch (error) {
    logger.warn('quarantine_delete_failed', {
      imageAssetId,
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  }
}

function uploadRejectionMessage(reason: string, detected?: string): string {
  switch (reason) {
    case 'format_not_allowed':
      return detected !== undefined
        ? `We cannot accept ${detected} files. Upload a JPEG, PNG or WebP image.`
        : 'We accept JPEG, PNG and WebP images only.';
    case 'pixel_budget_exceeded':
      return `That image has too many pixels (limit ${MAX_IMAGE_PIXEL_COUNT.toLocaleString('en-US')}). Resize it and try again.`;
    case 'dimensions_out_of_range':
      return `Images must be between 10 and ${MAX_IMAGE_DIMENSION} pixels on each side.`;
    case 'too_small':
      return 'That file is too small to be a valid image.';
    case 'dimensions_unreadable':
      return 'We could not read that image. Try re-exporting it.';
    default:
      return 'We could not recognise that file as a JPEG, PNG or WebP image.';
  }
}

/**
 * Honest advice about how the artwork will look.
 *
 * A buyer who uploads a 16:9 photo for a square plot should be told before they
 * pay, not after they see it letterboxed.
 */
function renderAdviceFor(width: number, height: number, detail: unknown): string | null {
  const reservation = (detail as { reservation?: { w?: number; h?: number } }).reservation;
  const cellW = reservation?.w;
  const cellH = reservation?.h;
  if (typeof cellW !== 'number' || typeof cellH !== 'number') return null;

  const targetW = cellW * 10;
  const targetH = cellH * 10;

  // Integer comparison of aspect ratios: width/height vs targetW/targetH becomes
  // width*targetH vs height*targetW. No float, no rounding surprises.
  const imageRatio = width * targetH;
  const targetRatio = height * targetW;
  const tolerance = targetRatio / 20; // 5%

  if (Math.abs(imageRatio - targetRatio) <= tolerance) {
    return `Your image matches the ${targetW}x${targetH} pixel plot shape and will fill it exactly.`;
  }
  if (imageRatio > targetRatio) {
    return `Your image is wider than the ${targetW}x${targetH} pixel plot, so it will be fitted with space above and below. Crop to ${targetW}x${targetH} for an exact fit.`;
  }
  return `Your image is taller than the ${targetW}x${targetH} pixel plot, so it will be fitted with space either side. Crop to ${targetW}x${targetH} for an exact fit.`;
}
