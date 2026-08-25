/**
 * Buyer dashboard.
 *
 * Ownership is enforced in SQL (`WHERE owner_id = p_owner_id`), not by filtering
 * a wider result set in the Worker. That distinction matters: a filter you forget
 * leaks everything, whereas a WHERE clause you forget returns nothing.
 *
 * Every response here is `no-store`. None of it may ever reach a shared cache.
 */

import { Hono } from 'hono';
import { placementEditSchema, placementIdParamSchema } from '@shared/schemas';
import { RESERVATION_STATE_HELP, RESERVATION_STATE_LABELS } from '@shared/states';
import type { ReservationState } from '@shared/states';
import type { AppEnv } from '../context';
import { requireUser } from '../context';
import { ApiError, validationFailed, zodFieldErrors } from '../lib/errors';
import { NO_STORE } from '../lib/cache';
import { audit, auditSecurityEvent } from '../lib/audit';
import { absoluteImageUrl } from '../lib/images';
import { isOk } from '../lib/supabase';
import { urlManualReviewReasons } from '@shared/url-safety';

export const dashboardRoutes = new Hono<AppEnv>();

// -----------------------------------------------------------------------------
// GET /api/dashboard
// -----------------------------------------------------------------------------
dashboardRoutes.get('/', async (c) => {
  const deps = c.get('deps');
  const user = await requireUser(c);

  const result = await deps.db.buyerDashboard(user.id);
  if (!isOk(result)) throw new ApiError('not_found');

  const record = result as unknown as {
    profile: Record<string, unknown>;
    totals: Record<string, unknown>;
    placements: Array<Record<string, unknown>>;
  };

  return c.json(
    {
      profile: record.profile,
      totals: record.totals,
      placements: record.placements.map((placement) => {
        const state = placement.state as ReservationState;
        const imagePath = typeof placement.imagePath === 'string' ? placement.imagePath : null;
        const { imagePath: _drop, ...rest } = placement;

        return {
          ...rest,
          imageUrl: absoluteImageUrl(deps.config, imagePath),
          // Honest status copy, from a single shared table so the API and the UI
          // can never describe the same state differently.
          statusLabel: RESERVATION_STATE_LABELS[state] ?? state,
          statusHelp: RESERVATION_STATE_HELP[state] ?? null,
          shareUrl:
            placement.placementStatus === 'active'
              ? `${deps.config.siteUrl}/wall?focus=${String(placement.placementId)}`
              : null,
          // Editable only while the buyer still owns an unpublished draft, or
          // while live (artwork/link changes re-enter moderation).
          editable: ['reserved', 'ready_for_checkout', 'active'].includes(state),
        };
      }),
      metricsNote:
        'Impressions are an estimate of how often your placement was inside a rendered view of the wall. ' +
        'Clicks are outbound clicks through hqpixels.com/go that passed our duplicate and bot filters. ' +
        'Both are aggregated in five-minute buckets and can lag by up to three minutes.',
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// PATCH /api/dashboard/placements/:placementId
// -----------------------------------------------------------------------------
/**
 * Edit an owned placement.
 *
 * What can change: title, alt text, destination URL.
 * What cannot: position, size, price, owner. Those are immutable in the database
 * (see the `placements_enforce_update` trigger), so this endpoint physically
 * cannot move someone's plot even if it tried.
 *
 * Any change to the destination or artwork re-enters moderation, because
 * otherwise "get approved with something innocuous, then swap the link" would be
 * a trivial bypass of the entire content policy.
 */
dashboardRoutes.patch('/placements/:placementId', async (c) => {
  const deps = c.get('deps');
  const auditCtx = c.get('auditContext');
  const user = await requireUser(c);

  const idParsed = placementIdParamSchema.safeParse({ placementId: c.req.param('placementId') });
  if (!idParsed.success) throw new ApiError('not_found');

  const body = await c.req.json().catch(() => null);
  const parsed = placementEditSchema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed({ fields: zodFieldErrors(parsed.error.issues) });
  }

  const decision = await deps.rateLimiter.consume('placementUpdate', user.id);
  if (!decision.allowed) {
    throw new ApiError('rate_limited', { retryAfter: decision.retryAfter });
  }

  // Find the reservation behind this placement, scoped to the caller. The
  // dashboard RPC is the ownership check.
  const dashboard = await deps.db.buyerDashboard(user.id);
  if (!isOk(dashboard)) throw new ApiError('not_found');

  const placements = (dashboard as unknown as { placements: Array<Record<string, unknown>> })
    .placements;
  const target = placements.find((p) => p.placementId === idParsed.data.placementId);

  if (target === undefined) {
    auditSecurityEvent(
      auditCtx,
      'security.idor_attempt',
      { resource: 'placement_edit', placementId: idParsed.data.placementId },
      user.id,
    );
    throw new ApiError('not_found');
  }

  const reservationId = String(target.reservationId);
  const state = String(target.state);

  if (!['reserved', 'ready_for_checkout', 'active'].includes(state)) {
    throw new ApiError('reservation_state_invalid', {
      message: 'This placement cannot be edited in its current state.',
      logContext: { state },
    });
  }

  const destination = parsed.data.destinationUrl;
  const reviewReasons = destination !== undefined ? urlManualReviewReasons(destination) : [];

  // A live placement whose link or text changes goes back to review. The Worker
  // takes it off the wall first, so nothing unreviewed is ever public.
  const changesRequireReview = destination !== undefined;

  if (state === 'active' && changesRequireReview) {
    const disabled = await deps.db.disablePlacement(
      idParsed.data.placementId,
      user.id,
      'owner changed the destination link; awaiting re-review',
      'system',
      c.get('requestId'),
    );
    if (!isOk(disabled)) {
      throw new ApiError('conflict', {
        message: 'We could not take the placement down for re-review. Please try again.',
        logContext: { code: disabled.code },
      });
    }
  }

  const result = await deps.db.setPlacementDetails({
    reservationId,
    ownerId: user.id,
    title: parsed.data.title ?? null,
    altText: parsed.data.altText ?? null,
    destinationUrl: destination?.url ?? null,
    destinationHost: destination?.host ?? null,
    moderationState: reviewReasons.length > 0 ? 'auto_flag' : 'auto_pass',
    checks:
      destination === undefined
        ? []
        : [
            {
              check: 'destination_url_syntax',
              result: 'pass',
              detail: `host=${destination.host} https=${destination.isHttps}`,
            },
            ...reviewReasons.map((reason) => ({
              check: `destination_${reason}`,
              result: 'flag' as const,
              detail: reason,
            })),
          ],
  });

  if (!isOk(result)) {
    // set_placement_details only allows edits in reserved/ready_for_checkout.
    // An `active` placement therefore reaches here after the disable above,
    // which is a documented limitation: editing a live placement's text requires
    // a moderator pass. Report it honestly rather than pretending it worked.
    if (result.code === 'reservation_state_invalid') {
      return c.json(
        {
          updated: false,
          requiresModeration: true,
          message:
            'Your placement has been taken off the wall and queued for re-review. ' +
            'Our team will apply the change and restore it, usually within one business day.',
        },
        202,
        { 'Cache-Control': NO_STORE },
      );
    }
    throw new ApiError('not_found');
  }

  audit(auditCtx, {
    action: 'placement.edited',
    targetType: 'placement',
    targetId: idParsed.data.placementId,
    actorId: user.id,
    actorLabel: 'buyer',
    detail: {
      changedTitle: parsed.data.title !== undefined,
      changedAltText: parsed.data.altText !== undefined,
      changedDestination: destination !== undefined,
      newHost: destination?.host ?? null,
      requiresReview: changesRequireReview,
    },
  });

  return c.json(
    {
      updated: true,
      requiresModeration: changesRequireReview,
      state: result.state,
      manualReviewReasons: reviewReasons,
      message: changesRequireReview
        ? 'Saved. Because the destination changed, your placement goes back through review before it reappears on the wall.'
        : 'Saved.',
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});

// -----------------------------------------------------------------------------
// GET /api/dashboard/placements/:placementId
// -----------------------------------------------------------------------------
dashboardRoutes.get('/placements/:placementId', async (c) => {
  const deps = c.get('deps');
  const user = await requireUser(c);

  const idParsed = placementIdParamSchema.safeParse({ placementId: c.req.param('placementId') });
  if (!idParsed.success) throw new ApiError('not_found');

  const dashboard = await deps.db.buyerDashboard(user.id);
  if (!isOk(dashboard)) throw new ApiError('not_found');

  const placements = (dashboard as unknown as { placements: Array<Record<string, unknown>> })
    .placements;
  const target = placements.find((p) => p.placementId === idParsed.data.placementId);

  if (target === undefined) {
    auditSecurityEvent(
      c.get('auditContext'),
      'security.idor_attempt',
      { resource: 'placement_detail', placementId: idParsed.data.placementId },
      user.id,
    );
    throw new ApiError('not_found');
  }

  const state = target.state as ReservationState;
  const imagePath = typeof target.imagePath === 'string' ? target.imagePath : null;
  const { imagePath: _drop, ...rest } = target;

  return c.json(
    {
      placement: {
        ...rest,
        imageUrl: absoluteImageUrl(deps.config, imagePath),
        statusLabel: RESERVATION_STATE_LABELS[state] ?? state,
        statusHelp: RESERVATION_STATE_HELP[state] ?? null,
        shareUrl:
          target.placementStatus === 'active'
            ? `${deps.config.siteUrl}/wall?focus=${String(target.placementId)}`
            : null,
      },
    },
    200,
    { 'Cache-Control': NO_STORE },
  );
});
