/**
 * Admin / moderation surface.
 *
 * Authorization is `requireAdmin`, which needs THREE things to line up: a valid
 * session, `profiles.is_admin` in the database, and the account's email in the
 * `ADMIN_EMAIL_ALLOWLIST` Worker secret. A guessed URL grants nothing, and a
 * database compromise alone does not grant admin either.
 *
 * Denials return 404, not 403, so this surface does not confirm its own
 * existence. Every denial is audited.
 *
 * Every action here is recorded in the append-only audit log by the database
 * function that performs it, so the trail cannot be edited even by the service
 * role.
 */

import { Hono } from 'hono';
import { adminListQuerySchema, moderationDecisionSchema } from '@shared/schemas';
import type { AppEnv } from '../context';
import { requireAdmin } from '../context';
import { ApiError, validationFailed, zodFieldErrors } from '../lib/errors';
import { NO_STORE } from '../lib/cache';
import { audit } from '../lib/audit';
import { absoluteImageUrl } from '../lib/images';
import { refundPayment } from '../lib/stripe';
import { isOk } from '../lib/supabase';
import { invalidateManifest } from '../jobs/manifest';

export const adminRoutes = new Hono<AppEnv>();

// -----------------------------------------------------------------------------
// GET /api/admin/queue
// -----------------------------------------------------------------------------
adminRoutes.get('/queue', async (c) => {
  const deps = c.get('deps');
  const admin = await requireAdmin(c);

  const parsed = adminListQuerySchema.safeParse({
    status: c.req.query('status') ?? undefined,
    cursor: c.req.query('cursor') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
  });
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }

  const result = await deps.db.adminModerationQueue(
    admin.id,
    parsed.data.status,
    parsed.data.limit,
    parsed.data.cursor ?? null,
  );
  if (!isOk(result)) throw new ApiError('forbidden');

  const items = (result.items as Array<Record<string, unknown>>).map((item) => {
    const imagePath = typeof item.imagePath === 'string' ? item.imagePath : null;
    const { imagePath: _drop, ...rest } = item;
    return {
      ...rest,
      // The quarantine variant. Still unpublished, so this only renders for a
      // signed-in admin through the image provider's signed-URL mechanism.
      imageReviewUrl: absoluteImageUrl(deps.config, imagePath),
    };
  });

  // Reading the queue is itself audited: who looked at buyer data, and when.
  audit(c.get('auditContext'), {
    action: 'admin.viewed_queue',
    targetType: 'queue',
    targetId: parsed.data.status,
    actorId: admin.id,
    actorLabel: 'admin',
    detail: { count: items.length, status: parsed.data.status },
  });

  return c.json({ items, nextCursor: result.nextCursor, status: parsed.data.status }, 200, {
    'Cache-Control': NO_STORE,
    'X-Robots-Tag': 'noindex, nofollow',
  });
});

// -----------------------------------------------------------------------------
// POST /api/admin/moderate
// -----------------------------------------------------------------------------
adminRoutes.post('/moderate', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');
  const admin = await requireAdmin(c);

  const body = await c.req.json().catch(() => null);
  const parsed = moderationDecisionSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }
  const { placementId, decision, reason, refund } = parsed.data;
  const requestId = c.get('requestId');

  switch (decision) {
    // -------------------------------------------------------------------------
    case 'approve': {
      const result = await deps.db.approvePlacement(
        placementId,
        admin.id,
        reason ?? null,
        requestId,
      );

      if (!isOk(result)) {
        if (result.code === 'payment_not_settled') {
          // The guard that makes "only paid placements are published" hold even
          // against a mis-click.
          throw new ApiError('conflict', {
            message: 'That placement has no settled payment, so it cannot be published.',
            logContext: { placementId, code: result.code },
          });
        }
        if (result.code === 'cells_no_longer_held') {
          throw new ApiError('conflict', {
            message: 'Those units are no longer held by this buyer, so it cannot be published.',
            logContext: { placementId },
          });
        }
        if (result.code === 'not_found') throw new ApiError('not_found');
        throw new ApiError('conflict', { logContext: { code: result.code } });
      }

      // The wall changed. Rebuild synchronously so the moderator sees the effect
      // of their own action immediately.
      await invalidateManifest(deps, logger).catch((error: unknown) => {
        logger.error('manifest_rebuild_after_approve_failed', {
          placementId,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          severity: 'high',
        });
      });

      return c.json(
        { decision: 'approve', placementId, manifestVersion: result.manifestVersion },
        200,
        { 'Cache-Control': NO_STORE },
      );
    }

    // -------------------------------------------------------------------------
    case 'reject': {
      if (reason === undefined) {
        throw validationFailed({ fields: { reason: 'A reason is required.' } });
      }

      // Two phases on purpose: the database records the decision and hands back
      // the Stripe identifiers, then we call Stripe, then we record the result.
      // A Stripe outage therefore cannot leave the decision half-applied.
      const result = await deps.db.rejectPlacement(placementId, admin.id, reason, requestId);
      if (!isOk(result)) {
        if (result.code === 'not_found') throw new ApiError('not_found');
        if (result.code === 'reason_required') {
          throw validationFailed({ fields: { reason: 'A reason is required.' } });
        }
        throw new ApiError('conflict', { logContext: { code: result.code } });
      }

      await invalidateManifest(deps, logger).catch(() => undefined);

      let refundResult: { refundId: string; amountCents: number; status: string | null } | null =
        null;
      let refundError: string | null = null;

      const shouldRefund = refund !== false && result.refundRequired;

      if (shouldRefund && result.stripePaymentIntentId !== null) {
        try {
          refundResult = await refundPayment(deps.stripe(), {
            paymentIntentId: result.stripePaymentIntentId,
            reservationId: result.reservationId,
            reason: 'requested_by_customer',
          });

          // Record Stripe's answer. `charge.refunded` will also arrive by
          // webhook; record_refund is idempotent on the cumulative amount, so
          // whichever lands first wins and the other is a no-op.
          await deps.db.recordRefund(
            result.stripeChargeId ?? result.stripePaymentIntentId,
            refundResult.amountCents,
            `rejected by moderation: ${reason}`,
          );
        } catch (error) {
          // The placement is already down, which is the urgent half. The refund
          // is retried by hand from the runbook.
          refundError = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
          logger.error('moderation_refund_failed', {
            placementId,
            reservationId: result.reservationId,
            paymentIntentId: result.stripePaymentIntentId,
            error: refundError,
            severity: 'critical',
          });
        }
      }

      audit(auditCtx, {
        action: 'payment.refunded',
        targetType: 'placement',
        targetId: placementId,
        actorId: admin.id,
        actorLabel: 'admin',
        detail: {
          reason,
          refundAttempted: shouldRefund,
          refundSucceeded: refundResult !== null,
          refundId: refundResult?.refundId ?? null,
          amountCents: refundResult?.amountCents ?? 0,
          refundError,
        },
      });

      return c.json(
        {
          decision: 'reject',
          placementId,
          takenDown: true,
          refund: {
            attempted: shouldRefund,
            succeeded: refundResult !== null,
            amountCents: refundResult?.amountCents ?? null,
            // Surfaced to the admin so they know to follow the runbook, without
            // exposing the provider error text.
            needsManualAction: shouldRefund && refundResult === null,
          },
        },
        200,
        { 'Cache-Control': NO_STORE },
      );
    }

    // -------------------------------------------------------------------------
    case 'disable': {
      if (reason === undefined) {
        throw validationFailed({ fields: { reason: 'A reason is required.' } });
      }

      const result = await deps.db.disablePlacement(
        placementId,
        admin.id,
        reason,
        'admin',
        requestId,
      );
      if (!isOk(result)) {
        if (result.code === 'not_found') throw new ApiError('not_found');
        throw new ApiError('conflict', { logContext: { code: result.code } });
      }

      await invalidateManifest(deps, logger).catch(() => undefined);

      return c.json({ decision: 'disable', placementId }, 200, { 'Cache-Control': NO_STORE });
    }

    // -------------------------------------------------------------------------
    case 'reenable': {
      const result = await deps.db.reenablePlacement(
        placementId,
        admin.id,
        reason ?? null,
        requestId,
      );
      if (!isOk(result)) {
        if (result.code === 'not_found') throw new ApiError('not_found');
        if (result.code === 'payment_not_settled') {
          throw new ApiError('conflict', {
            message: 'That placement has no settled payment, so it cannot be restored.',
          });
        }
        throw new ApiError('conflict', { logContext: { code: result.code } });
      }

      await invalidateManifest(deps, logger).catch(() => undefined);

      return c.json({ decision: 'reenable', placementId }, 200, { 'Cache-Control': NO_STORE });
    }

    default: {
      // The Zod enum makes this unreachable; kept so a widened enum fails to
      // compile rather than falling through silently.
      throw validationFailed({ message: 'Unknown moderation decision.' });
    }
  }
});

// -----------------------------------------------------------------------------
// POST /api/admin/disable-host
// -----------------------------------------------------------------------------
// Bulk takedown when a destination domain turns out to be malicious. One action,
// because doing it placement-by-placement during an incident is how things get
// missed.
adminRoutes.post('/disable-host', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const admin = await requireAdmin(c);

  const body: { host?: unknown; reason?: unknown } = await c.req
    .json<{ host?: unknown; reason?: unknown }>()
    .catch(() => ({}));
  const host = typeof body.host === 'string' ? body.host.trim().toLowerCase() : '';
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';

  if (host.length < 3 || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) {
    throw validationFailed({ fields: { host: 'Enter a valid hostname.' } });
  }
  if (reason.length < 3) {
    throw validationFailed({ fields: { reason: 'A reason is required.' } });
  }

  const result = await deps.db.disablePlacementsByHost(host, admin.id, reason, c.get('requestId'));
  if (!isOk(result)) throw new ApiError('conflict', { logContext: { code: result.code } });

  await invalidateManifest(deps, logger).catch(() => undefined);

  logger.warn('bulk_host_disable', { host, disabled: result.disabled, adminId: admin.id });

  return c.json({ host, disabled: result.disabled }, 200, { 'Cache-Control': NO_STORE });
});

// -----------------------------------------------------------------------------
// GET /api/admin/health
// -----------------------------------------------------------------------------
adminRoutes.get('/health', async (c) => {
  const deps = c.get('deps');
  const admin = await requireAdmin(c);

  const result = await deps.db.adminHealth(admin.id);
  if (!isOk(result)) throw new ApiError('forbidden');

  // Analytics backlog comes from the Durable Objects, not the database.
  const analyticsBacklog = await deps.analytics.backlog().catch(() => -1);

  return c.json(
    {
      ...result,
      analyticsBacklog,
      environment: deps.config.environment,
      imagePipelineConfigured: deps.config.images.configured,
      manualApprovalRequired: deps.config.requireManualApproval,
      adminAllowlistSize: deps.config.adminEmailAllowlist.length,
    },
    200,
    { 'Cache-Control': NO_STORE, 'X-Robots-Tag': 'noindex, nofollow' },
  );
});

// -----------------------------------------------------------------------------
// GET /api/admin/audit
// -----------------------------------------------------------------------------
adminRoutes.get('/audit', async (c) => {
  const deps = c.get('deps');
  const admin = await requireAdmin(c);

  const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isSafeInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const before = c.req.query('before') ?? null;

  const result = await deps.db.adminAuditPage(admin.id, limit, before);
  if (!isOk(result)) throw new ApiError('forbidden');

  // Reading the audit log is itself audited. Anything else would leave a gap
  // exactly where an insider-risk investigation needs coverage.
  audit(c.get('auditContext'), {
    action: 'admin.viewed_audit',
    targetType: 'audit_log',
    targetId: null,
    actorId: admin.id,
    actorLabel: 'admin',
    detail: { limit, before: before ?? 'latest' },
  });

  return c.json({ items: result.items }, 200, {
    'Cache-Control': NO_STORE,
    'X-Robots-Tag': 'noindex, nofollow',
  });
});

// -----------------------------------------------------------------------------
// POST /api/admin/manifest/rebuild
// -----------------------------------------------------------------------------
// Manual cache invalidation. Present because "the wall looks stale" is a real
// incident and the runbook needs a button for it.
adminRoutes.post('/manifest/rebuild', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const admin = await requireAdmin(c);

  const { rebuildManifest } = await import('../jobs/manifest');
  const result = await rebuildManifest(deps, logger);

  audit(c.get('auditContext'), {
    action: 'manifest.rebuilt',
    targetType: 'manifest',
    targetId: String(result.version),
    actorId: admin.id,
    actorLabel: 'admin',
    detail: { ...result },
  });

  return c.json(result, 200, { 'Cache-Control': NO_STORE });
});
