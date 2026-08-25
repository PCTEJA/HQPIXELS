/**
 * Stripe webhook — the ONLY path from "money moved" to "placement publishable".
 *
 * The order of operations is the security design, so it is worth stating
 * explicitly:
 *
 *   1. Read the RAW body as text. Not `c.req.json()` — parsing first would
 *      destroy the exact bytes the signature covers, and the signature is the
 *      only thing authenticating this request.
 *   2. Verify the Stripe-Signature header against the endpoint secret BEFORE
 *      parsing or acting on anything. An invalid signature is a 400 and nothing
 *      else happens.
 *   3. Record the event id under a unique constraint. A duplicate delivery
 *      returns 200 immediately and does no work.
 *   4. Dispatch. Every handler is idempotent and tolerates out-of-order
 *      delivery, because Stripe delivers duplicates, late, and out of order.
 *   5. Acknowledge fast. Slow work (manifest rebuild) goes to waitUntil.
 *
 * We always return 200 for an event we have accepted responsibility for, even if
 * our own processing failed, EXCEPT where a retry could help — in which case we
 * return 500 so Stripe retries with backoff. Returning 200 on a real failure
 * would silently drop the event; returning 500 on an unparseable one would make
 * Stripe retry forever.
 */

import { Hono } from 'hono';
import type Stripe from 'stripe';
import type { AppContext, AppEnv } from '../context';
import { ApiError } from '../lib/errors';
import { NO_STORE } from '../lib/cache';
import { audit, auditSecurityEvent } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { isHandledEvent, stripeCryptoProvider } from '../lib/stripe';
import { isOk } from '../lib/supabase';
import { invalidateManifest } from '../jobs/manifest';

export const stripeWebhookRoutes = new Hono<AppEnv>();

/** Stripe's documented maximum acceptable clock skew for signatures, in seconds. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

stripeWebhookRoutes.post('/', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');

  // --- 1. raw body ------------------------------------------------------------
  const signature = c.req.header('Stripe-Signature');
  if (signature === undefined || signature === '') {
    auditSecurityEvent(auditCtx, 'security.webhook_signature_invalid', {
      reason: 'missing_header',
    });
    return c.json({ error: 'missing signature' }, 400, { 'Cache-Control': NO_STORE });
  }

  const rawBody = await c.req.text();
  if (rawBody.length === 0) {
    return c.json({ error: 'empty body' }, 400, { 'Cache-Control': NO_STORE });
  }

  // --- 2. verify BEFORE parsing ----------------------------------------------
  let event: Stripe.Event;
  try {
    event = await deps
      .stripe()
      .webhooks.constructEventAsync(
        rawBody,
        signature,
        deps.config.stripeWebhookSecret,
        SIGNATURE_TOLERANCE_SECONDS,
        stripeCryptoProvider(),
      );
  } catch (error) {
    // Includes both a forged signature and a replay outside the tolerance
    // window. Both are security events.
    auditSecurityEvent(auditCtx, 'security.webhook_signature_invalid', {
      reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      bodyBytes: rawBody.length,
      severity: 'high',
    });
    return c.json({ error: 'invalid signature' }, 400, { 'Cache-Control': NO_STORE });
  }

  const logCtx = { stripeEventId: event.id, eventType: event.type };

  // A live-mode event arriving at a test deployment (or vice versa) means the
  // wrong endpoint is configured somewhere. Refuse rather than act on it.
  if (deps.config.isProduction && event.livemode !== true) {
    logger.warn('webhook_livemode_mismatch', { ...logCtx, livemode: event.livemode });
    return c.json({ received: true, ignored: 'livemode_mismatch' }, 200, {
      'Cache-Control': NO_STORE,
    });
  }

  // --- 3. idempotency --------------------------------------------------------
  const payloadDigest = await sha256Hex(rawBody);

  let ledger;
  try {
    ledger = await deps.db.recordStripeEvent({
      eventId: event.id,
      type: event.type,
      apiVersion: event.api_version ?? null,
      stripeCreated: new Date(event.created * 1000).toISOString(),
      payloadSha256: payloadDigest,
      livemode: event.livemode === true,
    });
  } catch (error) {
    // We could not even record the event. Ask Stripe to retry — dropping it
    // would risk an unfulfilled payment.
    logger.error('webhook_ledger_write_failed', {
      ...logCtx,
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      severity: 'critical',
    });
    return c.json({ error: 'ledger unavailable' }, 500, { 'Cache-Control': NO_STORE });
  }

  if (!ledger.isNew) {
    // The gate that makes duplicate delivery a no-op.
    logger.info('webhook_duplicate', {
      ...logCtx,
      attempts: ledger.attempts,
      alreadyProcessed: ledger.alreadyProcessed,
    });
    return c.json(
      { received: true, duplicate: true, alreadyProcessed: ledger.alreadyProcessed },
      200,
      { 'Cache-Control': NO_STORE },
    );
  }

  if (!isHandledEvent(event.type)) {
    // Subscribed to something we do not handle. Record and move on so the
    // Dashboard subscription can be tightened.
    await deps.db.finishStripeEvent(event.id, 'ignored:unhandled_type').catch(() => undefined);
    logger.info('webhook_unhandled_type', logCtx);
    return c.json({ received: true, handled: false }, 200, { 'Cache-Control': NO_STORE });
  }

  // --- 4. dispatch -----------------------------------------------------------
  try {
    const outcome = await handleEvent(c, event);

    await deps.db
      .finishStripeEvent(event.id, outcome.outcome, outcome.reservationId ?? null, null)
      .catch((error: unknown) => {
        logger.warn('webhook_finish_failed', { ...logCtx, error: String(error) });
      });

    if (outcome.invalidateManifest) {
      // 5. Slow work off the acknowledgement path. Stripe expects a fast 200 and
      // will retry if we dawdle.
      auditCtx.waitUntil(
        invalidateManifest(deps, logger).catch((error: unknown) => {
          logger.error('manifest_invalidate_failed', {
            ...logCtx,
            error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }),
      );
    }

    logger.info('webhook_processed', { ...logCtx, outcome: outcome.outcome });
    return c.json({ received: true, outcome: outcome.outcome }, 200, {
      'Cache-Control': NO_STORE,
    });
  } catch (error) {
    // Mark the ledger row so the reconciler knows to look at it, then ask Stripe
    // to retry.
    await deps.db
      .finishStripeEvent(
        event.id,
        `error:${error instanceof Error ? error.name : 'unknown'}`,
        null,
        null,
      )
      .catch(() => undefined);

    logger.error('webhook_handler_failed', {
      ...logCtx,
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      severity: 'critical',
    });

    return c.json({ error: 'processing failed' }, 500, { 'Cache-Control': NO_STORE });
  }
});

interface HandlerOutcome {
  readonly outcome: string;
  readonly reservationId?: string;
  readonly invalidateManifest?: boolean;
}

/**
 * Event dispatch.
 *
 * Every branch is idempotent at the database level, so re-entering any of them
 * (a Stripe retry after our 500, or the reconciler racing a late webhook) is
 * safe.
 */
async function handleEvent(c: AppContext, event: Stripe.Event): Promise<HandlerOutcome> {
  const deps = c.get('deps');
  const logger = c.get('logger');
  const auditCtx = c.get('auditContext');

  switch (event.type) {
    // -------------------------------------------------------------------------
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;

      // For an async payment method, `completed` fires before the money arrives.
      // Publishing then would mean giving away inventory on an unpaid promise.
      if (event.type === 'checkout.session.completed' && session.payment_status !== 'paid') {
        logger.info('checkout_completed_unpaid', {
          sessionId: session.id,
          paymentStatus: session.payment_status,
        });
        await deps.db.failPayment(session.id, `awaiting_${session.payment_status}`, false);
        return { outcome: 'ok:awaiting_async_payment' };
      }

      // The reservation id must agree between client_reference_id and metadata.
      // Requiring both to match closes off a session crafted with one but not the
      // other.
      const fromReference = session.client_reference_id;
      const fromMetadata = session.metadata?.reservation_id;

      if (!fromReference || !fromMetadata || fromReference !== fromMetadata) {
        logger.error('checkout_reservation_id_mismatch', {
          sessionId: session.id,
          hasReference: Boolean(fromReference),
          hasMetadata: Boolean(fromMetadata),
          severity: 'critical',
        });
        return { outcome: 'error:reservation_id_mismatch' };
      }

      const reservationId = fromReference;

      const intentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent?.id ?? null);
      const chargeId =
        typeof session.payment_intent === 'string'
          ? null
          : typeof session.payment_intent?.latest_charge === 'string'
            ? session.payment_intent.latest_charge
            : (session.payment_intent?.latest_charge?.id ?? null);

      // settle_payment re-verifies amount, currency, ownership and session
      // linkage against our own rows. It is the authority, not this handler.
      const result = await deps.db.settlePayment({
        reservationId,
        sessionId: session.id,
        amountTotalCents: session.amount_total ?? -1,
        currency: session.currency ?? '',
        paymentIntentId: intentId,
        chargeId,
        customerId: typeof session.customer === 'string' ? session.customer : null,
        requireManualApproval: deps.config.requireManualApproval,
      });

      if (!isOk(result)) {
        // A mismatch here is either an attack or a serious bug. Do NOT retry:
        // the same mismatch will recur. Surface it for a human.
        logger.error('settle_payment_refused', {
          sessionId: session.id,
          reservationId,
          code: result.code,
          severity: 'critical',
        });
        audit(auditCtx, {
          action: 'payment.failed',
          targetType: 'reservation',
          targetId: reservationId,
          actorLabel: 'stripe',
          detail: { sessionId: session.id, refusalCode: result.code, eventId: event.id },
        });
        return { outcome: `error:${result.code}`, reservationId };
      }

      if (result.alreadySettled) {
        return { outcome: 'ok:already_settled', reservationId };
      }

      audit(auditCtx, {
        action: 'payment.settled',
        targetType: 'reservation',
        targetId: reservationId,
        actorLabel: 'stripe',
        detail: {
          sessionId: session.id,
          amountCents: session.amount_total ?? 0,
          placementId: result.placementId,
          foundingBuyer: result.foundingBuyer,
          buyerOrdinal: result.buyerOrdinal,
          eventId: event.id,
        },
      });

      // Note: NOT invalidating the manifest here. The placement is
      // pending_review, not active, so the public wall has not changed. It is
      // invalidated on approval.
      return { outcome: 'ok:settled', reservationId };
    }

    // -------------------------------------------------------------------------
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object;
      await deps.db.failPayment(session.id, 'async_payment_failed', true);
      audit(auditCtx, {
        action: 'payment.failed',
        targetType: 'payment',
        targetId: session.id,
        actorLabel: 'stripe',
        detail: { reason: 'async_payment_failed', eventId: event.id },
      });
      return { outcome: 'ok:async_failed' };
    }

    // -------------------------------------------------------------------------
    case 'checkout.session.expired': {
      const session = event.data.object;
      const result = await deps.db.expireCheckout(session.id);
      // Cells are NOT released here. The reservation may still have time left,
      // in which case the buyer can start a new session; the expiry sweeper
      // releases them only when the hold itself lapses.
      return {
        outcome: isOk(result) ? 'ok:checkout_expired' : `ignored:${String(result.code)}`,
      };
    }

    // -------------------------------------------------------------------------
    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      const sessionId = intent.metadata?.checkout_session_id;
      if (typeof sessionId === 'string' && sessionId !== '') {
        await deps.db.failPayment(
          sessionId,
          intent.last_payment_error?.code ?? 'payment_intent_failed',
          true,
        );
        return { outcome: 'ok:intent_failed' };
      }
      // Without a session link there is nothing to reconcile against; the
      // reconciler will pick the payment up by age.
      logger.info('payment_intent_failed_unlinked', { intentId: intent.id });
      return { outcome: 'ignored:no_session_link' };
    }

    // -------------------------------------------------------------------------
    case 'charge.refunded': {
      const charge = event.data.object;
      // Stripe reports the CUMULATIVE refunded amount, which is what makes this
      // safe to replay: record_refund ignores a non-increasing value.
      const result = await deps.db.recordRefund(
        charge.id,
        charge.amount_refunded,
        'stripe:charge.refunded',
      );

      audit(auditCtx, {
        action: 'payment.refunded',
        targetType: 'charge',
        targetId: charge.id,
        actorLabel: 'stripe',
        detail: {
          amountRefunded: charge.amount_refunded,
          amount: charge.amount,
          full: charge.amount_refunded >= charge.amount,
          eventId: event.id,
        },
      });

      return {
        outcome: isOk(result) ? 'ok:refund_recorded' : `ignored:${String(result.code)}`,
        // A full refund takes the placement off the wall.
        invalidateManifest: charge.amount_refunded >= charge.amount,
      };
    }

    // -------------------------------------------------------------------------
    case 'refund.created':
    case 'refund.updated': {
      const refund = event.data.object;
      const target =
        typeof refund.charge === 'string'
          ? refund.charge
          : typeof refund.payment_intent === 'string'
            ? refund.payment_intent
            : null;

      if (target === null) return { outcome: 'ignored:no_charge_link' };

      // A refund that has failed must NOT be treated as money returned.
      if (refund.status !== 'succeeded') {
        logger.info('refund_not_succeeded', { refundId: refund.id, status: refund.status });
        return { outcome: `ignored:refund_${refund.status ?? 'unknown'}` };
      }

      const result = await deps.db.recordRefund(target, refund.amount, `stripe:${event.type}`);
      return {
        outcome: isOk(result) ? 'ok:refund_recorded' : `ignored:${String(result.code)}`,
        invalidateManifest: true,
      };
    }

    // -------------------------------------------------------------------------
    case 'refund.failed': {
      const refund = event.data.object;
      // Important: a failed refund means the buyer has NOT been repaid. Someone
      // has to act on it, so it is logged at error and audited.
      logger.error('refund_failed', {
        refundId: refund.id,
        amount: refund.amount,
        severity: 'high',
      });
      audit(auditCtx, {
        action: 'payment.refunded',
        targetType: 'refund',
        targetId: refund.id,
        actorLabel: 'stripe',
        detail: { status: 'failed', amount: refund.amount, eventId: event.id },
      });
      return { outcome: 'ok:refund_failure_recorded' };
    }

    // -------------------------------------------------------------------------
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      const dispute = event.data.object;
      const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;

      const wonByUs = event.type === 'charge.dispute.closed' && dispute.status === 'won';

      const result = await deps.db.recordDispute(chargeId, dispute.status ?? 'unknown', wonByUs);

      audit(auditCtx, {
        action: 'payment.disputed',
        targetType: 'charge',
        targetId: chargeId,
        actorLabel: 'stripe',
        detail: {
          disputeId: dispute.id,
          status: dispute.status ?? 'unknown',
          reason: dispute.reason ?? 'unknown',
          amount: dispute.amount,
          wonByUs,
          eventId: event.id,
        },
      });

      logger.warn('dispute_event', {
        chargeId,
        status: dispute.status,
        reason: dispute.reason,
        amount: dispute.amount,
      });

      return {
        outcome: isOk(result) ? 'ok:dispute_recorded' : `ignored:${String(result.code)}`,
        // A new dispute removes the placement; a win does not automatically
        // restore it (an admin re-enables deliberately).
        invalidateManifest: !wonByUs,
      };
    }

    default: {
      // isHandledEvent already filtered, so this is unreachable unless the two
      // lists drift. Fail visibly rather than silently.
      throw new ApiError('internal_error', {
        logContext: { reason: 'handled_event_without_branch', eventType: event.type },
      });
    }
  }
}
