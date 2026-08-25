/**
 * The reservation lifecycle, as an explicit machine.
 *
 * This exists in three places and all three must agree:
 *   1. here (client display + Worker guard),
 *   2. `public.reservation_state` enum + the `reservation_transitions` table in
 *      SQL, which a trigger enforces on every UPDATE, and
 *   3. `docs/state-machine.md` (the diagram).
 *
 * The database is the authority. This file lets the Worker fail fast with a
 * good error message instead of relying on a constraint violation, and lets the
 * UI show honest status text.
 */

export const RESERVATION_STATES = [
  /** Created but cells not yet held. Only used transiently inside the RPC. */
  'draft',
  /** Cells are held. Buyer is uploading artwork and entering details. */
  'reserved',
  /** Artwork + metadata pass automated checks. Checkout may be created. */
  'ready_for_checkout',
  /** A Stripe Checkout Session exists and has not expired. */
  'checkout_created',
  /** Payment settled. Awaiting moderation before it appears on the wall. */
  'paid_pending_review',
  /** Approved and live on the wall. */
  'active',

  // ---- terminal / exception paths -----------------------------------------
  /** Hold lapsed before payment. Cells released. */
  'expired',
  /** Stripe reported a failed or canceled payment. Cells released. */
  'payment_failed',
  /** Rejected by moderation and refunded. Cells released. */
  'rejected_refunded',
  /** Taken down (dead link, policy breach, buyer request). Cells stay held. */
  'disabled',
  /** Chargeback received. Placement removed, cells released. */
  'chargeback_disabled',
] as const;

export type ReservationState = (typeof RESERVATION_STATES)[number];

/**
 * Allowed transitions. Anything not listed here is rejected by both the Worker
 * and the database trigger.
 *
 * Notable deliberate omissions:
 *   - nothing returns to `reserved` from `checkout_created`; a cancelled
 *     checkout goes back to `ready_for_checkout` so the checkout attempt
 *     counter (and therefore the Stripe idempotency key) always moves forward.
 *   - `active -> paid_pending_review` does not exist; a live placement that
 *     needs re-review is `disabled` first.
 *   - `paid_pending_review` cannot reach `expired`. Once money has settled,
 *     time alone never releases cells.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ReservationState, readonly ReservationState[]>> =
  {
    draft: ['reserved', 'expired'],
    reserved: ['ready_for_checkout', 'expired'],
    ready_for_checkout: ['checkout_created', 'reserved', 'expired'],
    checkout_created: [
      'paid_pending_review',
      'ready_for_checkout', // buyer cancelled or the session expired
      'payment_failed',
      'expired',
    ],
    paid_pending_review: ['active', 'rejected_refunded', 'chargeback_disabled', 'disabled'],
    active: ['disabled', 'chargeback_disabled', 'rejected_refunded'],
    expired: [],
    payment_failed: ['ready_for_checkout'], // buyer may retry with a fresh session
    rejected_refunded: [],
    disabled: ['active', 'chargeback_disabled', 'rejected_refunded'],
    chargeback_disabled: [],
  };

export function canTransition(from: ReservationState, to: ReservationState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** States in which the reservation still holds its cells. */
export const STATES_HOLDING_CELLS: readonly ReservationState[] = [
  'draft',
  'reserved',
  'ready_for_checkout',
  'checkout_created',
  'paid_pending_review',
  'active',
  'disabled',
];

/** States where the hold can lapse from the passage of time. Money never lapses. */
export const STATES_ELIGIBLE_FOR_EXPIRY: readonly ReservationState[] = [
  'draft',
  'reserved',
  'ready_for_checkout',
  'checkout_created',
];

/** States where the buyer has paid something. Used by the reconciler and refunds. */
export const STATES_AFTER_PAYMENT: readonly ReservationState[] = [
  'paid_pending_review',
  'active',
  'disabled',
  'rejected_refunded',
  'chargeback_disabled',
];

export function isTerminal(state: ReservationState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

// -----------------------------------------------------------------------------
// Placement status — what the public wall cares about
// -----------------------------------------------------------------------------

export const PLACEMENT_STATUSES = [
  /** Buyer is still filling it in. Never public. */
  'draft',
  /** Paid, awaiting moderation. Never public. */
  'pending_review',
  /** Public on the wall. */
  'active',
  /** Moderation said no. Never public. */
  'rejected',
  /** Was public, taken down. */
  'disabled',
  /** Removed after a chargeback. */
  'chargeback_disabled',
] as const;

export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];

/** The single definition of "should this be visible to the public". */
export function isPubliclyVisible(status: PlacementStatus): boolean {
  return status === 'active';
}

export const PAYMENT_STATUSES = [
  'requires_payment',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'refunded',
  'partially_refunded',
  'disputed',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Payment states that block a second Checkout Session for the same reservation. */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = ['requires_payment', 'processing'];

// -----------------------------------------------------------------------------
// Buyer-facing labels
// -----------------------------------------------------------------------------

/**
 * Honest status copy. No state is described more optimistically than it is —
 * "Live on the wall" is only ever used for `active`.
 */
export const RESERVATION_STATE_LABELS: Readonly<Record<ReservationState, string>> = {
  draft: 'Draft',
  reserved: 'Space held — add your artwork',
  ready_for_checkout: 'Ready to pay',
  checkout_created: 'Waiting for payment',
  paid_pending_review: 'Paid — in review',
  active: 'Live on the wall',
  expired: 'Hold expired',
  payment_failed: 'Payment failed',
  rejected_refunded: 'Rejected and refunded',
  disabled: 'Temporarily disabled',
  chargeback_disabled: 'Removed after payment dispute',
};

export const RESERVATION_STATE_HELP: Readonly<Record<ReservationState, string>> = {
  draft: 'Nothing is held yet.',
  reserved:
    'Your units are held for the rest of the countdown. Upload artwork and add your details to continue.',
  ready_for_checkout: 'Your details passed our automated checks. Pay to complete the claim.',
  checkout_created:
    'We are waiting for Stripe to confirm your payment. This page updates automatically.',
  paid_pending_review:
    'Payment received. A human reviews every placement before it goes on the wall — usually within one business day.',
  active: 'Your placement is live and counting impressions and clicks.',
  expired: 'The hold lapsed and the units returned to the wall. You can select again.',
  payment_failed: 'Stripe could not complete the payment. You can start a new checkout.',
  rejected_refunded:
    'This placement did not meet our content policy and has been refunded in full.',
  disabled:
    'This placement is hidden from the wall. Check your email or contact support for details.',
  chargeback_disabled:
    'A payment dispute was filed for this placement, so it has been removed from the wall.',
};
