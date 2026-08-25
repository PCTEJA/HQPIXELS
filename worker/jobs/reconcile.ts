/**
 * Payment reconciliation.
 *
 * Webhooks get lost. Not often, but often enough that a marketplace which only
 * fulfils on a webhook will eventually take someone's money and give them
 * nothing. This job is the answer: it asks Stripe directly about every local
 * payment that never reached a terminal state.
 *
 * Cases it resolves:
 *   * paid at Stripe, no webhook received  -> settle (the missed-webhook case)
 *   * session expired at Stripe            -> mark expired, free the hold to retry
 *   * payment failed at Stripe             -> mark failed
 *   * still genuinely open                 -> leave alone
 *   * refunded/disputed since              -> handled by their own webhooks; the
 *                                             reconciler does not duplicate that
 *
 * Double-fulfilment safety: it calls the SAME `settle_payment` RPC as the
 * webhook, which is idempotent and returns `alreadySettled` if a webhook won the
 * race. There is no second fulfilment path to keep in sync.
 */

import { fetchSessionSnapshot } from '../lib/stripe';
import type { Logger } from '../lib/logger';
import type { Deps } from '../context';
import { isOk } from '../lib/supabase';
import { invalidateManifest } from './manifest';

export interface ReconcileResult {
  readonly examined: number;
  readonly settled: number;
  readonly expired: number;
  readonly failed: number;
  readonly stillOpen: number;
  readonly errors: number;
}

/** Bounded per run so one cron invocation cannot exceed its CPU/time budget. */
const BATCH_SIZE = 25;

export async function reconcilePayments(deps: Deps, logger: Logger): Promise<ReconcileResult> {
  const result = { examined: 0, settled: 0, expired: 0, failed: 0, stillOpen: 0, errors: 0 };

  let candidates: Awaited<ReturnType<Deps['db']['openPaymentsForReconciliation']>>;
  try {
    candidates = await deps.db.openPaymentsForReconciliation(BATCH_SIZE);
  } catch (error) {
    logger.error('reconcile_candidate_query_failed', {
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      severity: 'high',
    });
    return { ...result, errors: 1 };
  }

  if (candidates.length === 0) return result;

  const stripe = deps.stripe();

  // Note: nothing this job does changes the PUBLIC wall. A recovered payment
  // lands in paid_pending_review, and an expired or failed one never had a
  // placement on the wall, so there is no manifest to invalidate here. Expiry
  // (which does free cells) is a separate function below and rebuilds there.
  for (const candidate of candidates) {
    result.examined += 1;

    try {
      const snapshot = await fetchSessionSnapshot(stripe, candidate.sessionId);

      // Cross-check that Stripe's idea of the reservation matches ours before
      // acting. A mismatch means the session id in our row is wrong, which is a
      // serious enough condition to stop and alert rather than "fix".
      const stripeReservation =
        snapshot.reservationIdFromMetadata ?? snapshot.clientReferenceId ?? null;

      if (stripeReservation !== null && stripeReservation !== candidate.reservationId) {
        logger.error('reconcile_reservation_mismatch', {
          paymentId: candidate.paymentId,
          localReservationId: candidate.reservationId,
          stripeReservationId: stripeReservation,
          severity: 'critical',
        });
        result.errors += 1;
        continue;
      }

      // --- paid at Stripe ---------------------------------------------------
      if (snapshot.paymentStatus === 'paid') {
        const settled = await deps.db.settlePayment({
          reservationId: candidate.reservationId,
          sessionId: candidate.sessionId,
          amountTotalCents: snapshot.amountTotal ?? -1,
          currency: snapshot.currency ?? '',
          paymentIntentId: snapshot.paymentIntentId,
          chargeId: snapshot.chargeId,
          customerId: snapshot.customerId,
          requireManualApproval: deps.config.requireManualApproval,
        });

        if (isOk(settled)) {
          if (!settled.alreadySettled) {
            result.settled += 1;
            // The whole reason this job exists.
            logger.warn('reconciler_recovered_missed_webhook', {
              reservationId: candidate.reservationId,
              sessionId: candidate.sessionId,
              amountCents: snapshot.amountTotal,
              severity: 'high',
            });
            await deps.db
              .writeAudit({
                actorId: null,
                actorLabel: 'reconciler',
                action: 'payment.reconciled',
                targetType: 'reservation',
                targetId: candidate.reservationId,
                detail: {
                  sessionId: candidate.sessionId,
                  amountCents: snapshot.amountTotal ?? 0,
                  reason: 'webhook_missed',
                },
                requestId: null,
                ipPrefix: null,
                userAgentFamily: null,
              })
              .catch(() => undefined);
          }
        } else {
          result.errors += 1;
          logger.error('reconcile_settle_refused', {
            reservationId: candidate.reservationId,
            code: settled.code,
            severity: 'critical',
          });
        }
        continue;
      }

      // --- expired ----------------------------------------------------------
      if (snapshot.status === 'expired') {
        const expired = await deps.db.expireCheckout(candidate.sessionId);
        if (isOk(expired)) result.expired += 1;
        else result.stillOpen += 1;
        continue;
      }

      // --- failed / unpaid and complete -------------------------------------
      if (snapshot.status === 'complete' && snapshot.paymentStatus === 'unpaid') {
        await deps.db.failPayment(candidate.sessionId, 'stripe_reports_unpaid', true);
        result.failed += 1;
        continue;
      }

      // --- still open -------------------------------------------------------
      result.stillOpen += 1;
    } catch (error) {
      result.errors += 1;
      logger.error('reconcile_candidate_failed', {
        paymentId: candidate.paymentId,
        sessionId: candidate.sessionId,
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
    }
  }

  logger.info('reconcile_complete', { ...result });

  await deps.db
    .recordJobRun(
      'reconcile_payments',
      result.errors === 0,
      result.examined,
      `settled=${result.settled} expired=${result.expired} failed=${result.failed} open=${result.stillOpen} errors=${result.errors}`,
    )
    .catch(() => undefined);

  return result;
}

/**
 * Release expired holds.
 *
 * Delegates entirely to `expire_reservations`, which refuses to touch anything
 * with settled or in-flight money against it. That guarantee lives in SQL rather
 * than here on purpose: it must hold even if this job is invoked wrongly.
 */
export async function expireReservations(
  deps: Deps,
  logger: Logger,
): Promise<{ expired: number; cellsReleased: number }> {
  try {
    const result = await deps.db.expireReservations(60, 200);

    if (result.reservationsExpired > 0) {
      logger.info('reservations_expired', {
        count: result.reservationsExpired,
        cellsReleased: result.cellsReleased,
      });
      // Expiry frees cells, which changes the occupancy bitmap the wall renders.
      await invalidateManifest(deps, logger).catch((error: unknown) => {
        logger.warn('manifest_rebuild_after_expiry_failed', { error: String(error) });
      });
    }

    await deps.db
      .recordJobRun(
        'expire_reservations',
        true,
        result.reservationsExpired,
        `cells=${result.cellsReleased}`,
      )
      .catch(() => undefined);

    return { expired: result.reservationsExpired, cellsReleased: result.cellsReleased };
  } catch (error) {
    logger.error('expire_reservations_failed', {
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      severity: 'high',
    });
    await deps.db
      .recordJobRun('expire_reservations', false, 0, 'job failed')
      .catch(() => undefined);
    return { expired: 0, cellsReleased: 0 };
  }
}
