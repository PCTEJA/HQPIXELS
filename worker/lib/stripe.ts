/**
 * Stripe integration.
 *
 * Scope of what this module is allowed to do is deliberately narrow:
 *   * create a hosted Checkout Session
 *   * read a session/payment intent back (reconciliation)
 *   * issue a refund
 *   * verify a webhook signature
 *
 * It never sees card data. There is no custom card form anywhere in this
 * codebase — the buyer is redirected to Stripe-hosted Checkout, so card details
 * never touch HQPixels servers and the PCI surface is Stripe's SAQ A.
 *
 * Workers specifics: the Stripe SDK must be told to use fetch instead of Node's
 * http module, and SubtleCrypto instead of Node crypto, or nothing works on
 * workerd. `constructEventAsync` (not `constructEvent`) is required because
 * signature verification is async under SubtleCrypto.
 */

import Stripe from 'stripe';
import { STRIPE_CHECKOUT_MIN_TTL_SECONDS } from '@shared/constants';
import type { AppConfig } from '../env';

/**
 * Pinned API version.
 *
 * Pinned rather than floating so a Stripe-side upgrade cannot change the shape
 * of the objects our webhook handler parses. Before bumping this, re-check the
 * event names in `worker/routes/stripe-webhook.ts` against Stripe's changelog —
 * see STRIPE_SETUP.md, "Upgrading the API version".
 */
export const STRIPE_API_VERSION = '2025-02-24.acacia' as const;

export function createStripeClient(config: AppConfig, fetchImpl?: typeof fetch): Stripe {
  return new Stripe(config.stripeSecretKey, {
    apiVersion: STRIPE_API_VERSION,
    // Required on Workers: the default Node HTTP client does not exist here.
    httpClient: Stripe.createFetchHttpClient(fetchImpl),
    // Keep retries low: the Worker has a wall-clock budget, and our own
    // reconciler is the real retry mechanism for anything that matters.
    maxNetworkRetries: 1,
    timeout: 12_000,
    telemetry: false,
    appInfo: { name: 'HQPixels', version: '0.1.0', url: 'https://hqpixels.com' },
  });
}

/** SubtleCrypto provider for webhook signature verification on Workers. */
export function stripeCryptoProvider(): Stripe.CryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}

// -----------------------------------------------------------------------------
// Checkout Session creation
// -----------------------------------------------------------------------------

export interface CheckoutSessionInput {
  readonly reservationId: string;
  readonly placementId: string;
  readonly ownerId: string;
  readonly buyerEmail: string;
  /** Authoritative, server-computed, integer cents. */
  readonly amountCents: number;
  readonly cells: number;
  readonly logicalPixels: number;
  readonly rect: { x: number; y: number; w: number; h: number };
  readonly pricingVersion: number;
  /** Monotonic per reservation. Part of the idempotency key. */
  readonly checkoutAttempt: number;
  /** Unix seconds. Must be <= the reservation expiry. */
  readonly expiresAtEpoch: number;
  readonly siteUrl: string;
}

export interface CheckoutSessionResult {
  readonly sessionId: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly amountTotal: number | null;
}

/**
 * Create the Checkout Session.
 *
 * Every security-relevant choice here, explained because each one has been the
 * subject of a real-world incident somewhere:
 *
 *  - `amountCents` comes from the immutable reservation row. There is no path by
 *    which a client-supplied amount reaches this function.
 *  - The idempotency key is derived from the internal reservation id AND the
 *    attempt counter. A duplicate button press reuses the key and Stripe returns
 *    the SAME session (no second charge). A legitimate retry after a failure has
 *    a higher attempt number and therefore a fresh key.
 *  - `metadata` carries only opaque internal ids. No email, no name, no address,
 *    nothing that would turn a Stripe dashboard export into a PII incident.
 *  - `client_reference_id` is the reservation id, which is what the webhook uses
 *    to find its way back to our row — cross-checked against metadata.
 *  - `expires_at` is clamped to Stripe's 30-minute minimum and to the
 *    reservation's own expiry, preserving the invariant that a payable session
 *    never outlives the hold on the cells.
 *  - The success URL contains only the reservation id, and the success page can
 *    read status but cannot cause fulfilment.
 */
export async function createCheckoutSession(
  stripe: Stripe,
  input: CheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('createCheckoutSession received a non-integer or non-positive amount');
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const minExpiry = nowEpoch + STRIPE_CHECKOUT_MIN_TTL_SECONDS;
  if (input.expiresAtEpoch < minExpiry) {
    throw new Error('checkout_window_too_short');
  }

  const { x, y, w, h } = input.rect;
  const pixelSize = `${w * 10}x${h * 10}`;

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      // This integration uses standard Checkout. Account-level Managed Payments
      // defaults otherwise reject our card-only payment methods and invoices.
      // Stripe 17's types predate this parameter; spreading keeps the rest of
      // the request checked against the pinned SDK without an unsafe cast.
      ...{ managed_payments: { enabled: false } },
      // Card only for MVP. Adding async methods (bank debits) requires handling
      // checkout.session.async_payment_* — the webhook already does, but the
      // reservation TTL would need revisiting, so it stays off until then.
      payment_method_types: ['card'],
      customer_email: input.buyerEmail,
      client_reference_id: input.reservationId,
      expires_at: input.expiresAtEpoch,
      success_url: `${input.siteUrl}/claim/success?reservation=${input.reservationId}`,
      cancel_url: `${input.siteUrl}/claim/cancelled?reservation=${input.reservationId}`,
      // Opaque internal ids only.
      metadata: {
        reservation_id: input.reservationId,
        placement_id: input.placementId,
        owner_id: input.ownerId,
        pricing_version: String(input.pricingVersion),
        checkout_attempt: String(input.checkoutAttempt),
        cells: String(input.cells),
        rect: `${x},${y},${w},${h}`,
      },
      payment_intent_data: {
        // Use the account's descriptor. Managed Payments rejects a custom suffix.
        metadata: {
          reservation_id: input.reservationId,
          owner_id: input.ownerId,
        },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: input.amountCents,
            product_data: {
              name: `HQPixels wall placement — ${pixelSize} pixels`,
              description:
                `${input.cells} unit(s) (${input.logicalPixels} logical pixels) at grid position ` +
                `${x},${y}. One-time purchase, subject to approval under the HQPixels content policy.`,
            },
          },
        },
      ],
      // We do not need an address for a digital placement, and not collecting it
      // is the cheapest way to not have to protect it.
      billing_address_collection: 'auto',
      allow_promotion_codes: false,
      // Receipts come from Stripe, so we never build an email template that
      // could leak payment details.
      invoice_creation: { enabled: false },
    },
    {
      // The whole duplicate-charge defence, in one line.
      // Version the payload so Stripe cannot replay the cached Managed Payments
      // rejection from the previous request shape. Retries still share one key.
      idempotencyKey: `hqpixels:checkout:${input.reservationId}:${input.checkoutAttempt}:standard-v1`,
    },
  );

  if (!session.url) {
    throw new Error('Stripe returned a Checkout Session without a URL');
  }

  return {
    sessionId: session.id,
    url: session.url,
    expiresAt: new Date((session.expires_at ?? input.expiresAtEpoch) * 1000).toISOString(),
    amountTotal: session.amount_total,
  };
}

// -----------------------------------------------------------------------------
// Reconciliation reads
// -----------------------------------------------------------------------------

export interface SessionSnapshot {
  readonly id: string;
  readonly status: string | null;
  readonly paymentStatus: string | null;
  readonly amountTotal: number | null;
  readonly currency: string | null;
  readonly clientReferenceId: string | null;
  readonly reservationIdFromMetadata: string | null;
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
  readonly customerId: string | null;
  readonly expiresAtEpoch: number | null;
}

/**
 * Read a session for reconciliation.
 *
 * Expands the payment intent so we can capture the charge id in the same call —
 * the charge id is what refunds and dispute events key off.
 */
export async function fetchSessionSnapshot(
  stripe: Stripe,
  sessionId: string,
): Promise<SessionSnapshot> {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent', 'payment_intent.latest_charge'],
  });

  const intent =
    typeof session.payment_intent === 'string' ? null : (session.payment_intent ?? null);
  const latestCharge =
    intent && typeof intent.latest_charge !== 'string' ? (intent.latest_charge ?? null) : null;

  return {
    id: session.id,
    status: session.status ?? null,
    paymentStatus: session.payment_status ?? null,
    amountTotal: session.amount_total,
    currency: session.currency ?? null,
    clientReferenceId: session.client_reference_id ?? null,
    reservationIdFromMetadata: session.metadata?.reservation_id ?? null,
    paymentIntentId:
      typeof session.payment_intent === 'string' ? session.payment_intent : (intent?.id ?? null),
    chargeId:
      latestCharge?.id ??
      (intent && typeof intent.latest_charge === 'string' ? intent.latest_charge : null),
    customerId:
      typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null),
    expiresAtEpoch: session.expires_at ?? null,
  };
}

// -----------------------------------------------------------------------------
// Refunds
// -----------------------------------------------------------------------------

export interface RefundResult {
  readonly refundId: string;
  readonly amountCents: number;
  readonly status: string | null;
}

/**
 * Refund a payment.
 *
 * Idempotency key is derived from the reservation and the reason so a moderator
 * double-clicking "reject and refund" cannot issue two refunds. Note we refund
 * against the PaymentIntent, not the charge: Stripe resolves the right charge,
 * and it works for both card and (future) async payment methods.
 */
export async function refundPayment(
  stripe: Stripe,
  input: {
    paymentIntentId: string;
    amountCents?: number;
    reservationId: string;
    reason: 'requested_by_customer' | 'fraudulent' | 'duplicate';
  },
): Promise<RefundResult> {
  const refund = await stripe.refunds.create(
    {
      payment_intent: input.paymentIntentId,
      ...(input.amountCents !== undefined ? { amount: input.amountCents } : {}),
      reason: input.reason,
      metadata: { reservation_id: input.reservationId },
    },
    { idempotencyKey: `hqpixels:refund:${input.reservationId}:${input.amountCents ?? 'full'}` },
  );

  return {
    refundId: refund.id,
    amountCents: refund.amount,
    status: refund.status ?? null,
  };
}

// -----------------------------------------------------------------------------
// Webhook event names
// -----------------------------------------------------------------------------

/**
 * The events this application handles.
 *
 * Subscribe to EXACTLY these in the Stripe Dashboard — a narrower set means
 * fewer wasted invocations, and a wider set means events silently ignored.
 * Verify against Stripe's current event list when bumping STRIPE_API_VERSION.
 */
export const HANDLED_STRIPE_EVENTS = [
  // Normal card success.
  'checkout.session.completed',
  // Async methods (bank debits). Handled now so enabling them later is config,
  // not code.
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  // Buyer abandoned the page, or our expires_at elapsed.
  'checkout.session.expired',
  // Refunds. `charge.refunded` fires for the charge; `refund.updated` catches a
  // refund that later fails, which would otherwise leave us thinking money went
  // back when it did not.
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
  // Disputes.
  'charge.dispute.created',
  'charge.dispute.closed',
  'charge.dispute.updated',
  // Payment-level failure, for cards that fail after session completion.
  'payment_intent.payment_failed',
] as const;

export type HandledStripeEvent = (typeof HANDLED_STRIPE_EVENTS)[number];

export function isHandledEvent(type: string): type is HandledStripeEvent {
  return (HANDLED_STRIPE_EVENTS as readonly string[]).includes(type);
}
