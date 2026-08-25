/**
 * Wire contracts between the Worker and the browser.
 *
 * Rule for every type in this file: if a field would not be safe on a public
 * CDN edge cache, it does not belong in a public response. The manifest in
 * particular is cached globally, so it carries no buyer identity, no email, no
 * price paid, and no reservation ids.
 */

import type { PlacementStatus, ReservationState, PaymentStatus } from './states';
import type { Quote } from './pricing';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Every failing API response has this shape. `message` is safe to show a user;
 * it never contains a stack trace, SQL text, provider error body, or internal
 * hostname. `requestId` is the correlation id to quote to support — the matching
 * detail lives only in server logs.
 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    /** Field-level messages for form errors, keyed by dotted path. */
    readonly fields?: Readonly<Record<string, string>>;
    readonly requestId: string;
    /** Present on 429 responses. Seconds. */
    readonly retryAfter?: number;
  };
}

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'email_unverified'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'cells_unavailable'
  | 'quote_changed'
  | 'reservation_expired'
  | 'reservation_state_invalid'
  | 'checkout_window_too_short'
  | 'checkout_already_open'
  | 'csrf_failed'
  | 'origin_rejected'
  | 'turnstile_failed'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'upstream_unavailable'
  | 'internal_error'
  | 'maintenance';

// -----------------------------------------------------------------------------
// Wall manifest — the single hot cached read
// -----------------------------------------------------------------------------

/**
 * One active placement, as the wall renderer sees it.
 *
 * Coordinates are in *cell* units (0..99). The renderer multiplies by
 * CELL_LOGICAL_SIZE. Cell units keep the manifest small: a full wall of 10,000
 * single-cell placements stays well under a megabyte before compression.
 */
export interface ManifestPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Plain text. Rendered as a text node, never as HTML. */
  readonly title: string;
  readonly altText: string;
  /** Hostname only — never the full destination, which lives behind /go/:id. */
  readonly host: string;
  /** Safe, re-encoded, metadata-stripped image variant. Absolute URL. */
  readonly image: string;
  /** Public owner label: display name or handle. Never an email. */
  readonly owner: string | null;
  readonly ownerHandle: string | null;
  /** True once the payment has settled and moderation approved it. Always true here. */
  readonly verified: true;
  readonly foundingBuyer: boolean;
  /** ISO-8601. Used for "recently claimed". */
  readonly activatedAt: string;
}

export interface WallManifest {
  /** Monotonic. Bumped whenever any placement becomes active or is disabled. */
  readonly manifestVersion: number;
  readonly generatedAt: string;
  readonly grid: { readonly size: number; readonly cellLogicalSize: number };
  readonly placements: readonly ManifestPlacement[];
  /**
   * Base64 of a 10,000-bit occupancy bitmap (1250 bytes), row-major, bit i =
   * cell (i % 100, floor(i / 100)). Lets the renderer paint availability and
   * lets the selection UI reject taken cells before any network call, without
   * iterating the placement list.
   */
  readonly occupancyBitmap: string;
  readonly counts: {
    readonly activePlacements: number;
    readonly claimedCells: number;
    readonly availableCells: number;
  };
}

// -----------------------------------------------------------------------------
// Public stats — deliberately, verifiably honest
// -----------------------------------------------------------------------------

export interface PublicStats {
  readonly generatedAt: string;
  /**
   * Labelled "Total page views" in the UI. This is a count of successful
   * human-facing page loads after bot filtering. It is NOT unique visitors and
   * is NOT people, and the UI must not say otherwise.
   */
  readonly totalPageViews: number;
  /** How far behind the counter may be, in seconds. Shown to the user. */
  readonly countersLagSeconds: number;
  readonly inventory: {
    readonly totalCells: number;
    readonly claimedCells: number;
    readonly availableCells: number;
    /** Integer basis points (0..10000) so the client does no float math. */
    readonly percentSoldBp: number;
    readonly totalLogicalPixels: number;
    readonly claimedLogicalPixels: number;
  };
  readonly pricing: {
    readonly version: number;
    readonly currency: 'USD';
    readonly centsPerLogicalPixel: number;
    readonly minimumPurchaseCents: number;
  };
  /** Settled, non-refunded, non-disputed purchases only. */
  readonly activity: {
    readonly settledPurchases: number;
    readonly distinctOwners: number;
    readonly outboundClicks30d: number;
    readonly foundingBuyersRemaining: number;
  };
  readonly recentlyClaimed: readonly {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly title: string;
    readonly activatedAt: string;
  }[];
}

// -----------------------------------------------------------------------------
// Rankings — four separate boards, no opaque composite score
// -----------------------------------------------------------------------------

export type LeaderboardKind = 'largest_owners' | 'top_supporters' | 'most_visited' | 'rising';

export interface LeaderboardEntry {
  readonly rank: number;
  readonly label: string;
  readonly handle: string | null;
  readonly placementId: string | null;
  /** The single number this board ranks by. Unit is board-specific. */
  readonly value: number;
  readonly valueUnit: 'logical_pixels' | 'cents' | 'clicks';
  readonly foundingBuyer: boolean;
}

export interface Leaderboard {
  readonly kind: LeaderboardKind;
  readonly title: string;
  /** Plain-English definition of exactly what is measured. Rendered in the UI. */
  readonly methodology: string;
  readonly windowDescription: string;
  readonly computedAt: string;
  readonly entries: readonly LeaderboardEntry[];
}

export interface PublicRankings {
  readonly generatedAt: string;
  readonly boards: readonly Leaderboard[];
}

// -----------------------------------------------------------------------------
// Reservation / claim flow
// -----------------------------------------------------------------------------

export interface QuoteResponse {
  readonly quote: Quote;
  /** Cells inside the rectangle that are already taken. Empty means claimable. */
  readonly unavailableCells: readonly { readonly x: number; readonly y: number }[];
  readonly available: boolean;
  readonly reservationTtlSeconds: number;
}

export interface ReservationResponse {
  readonly reservation: {
    readonly id: string;
    readonly state: ReservationState;
    readonly rect: {
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    };
    readonly cells: number;
    readonly logicalPixels: number;
    readonly totalCents: number;
    readonly currency: 'USD';
    readonly pricingVersion: number;
    readonly expiresAt: string;
    readonly createdAt: string;
  };
  readonly quote: Quote;
  readonly placement: {
    readonly id: string;
    readonly status: PlacementStatus;
    readonly title: string;
    readonly altText: string;
    readonly destinationHost: string | null;
    readonly imageUrl: string | null;
  };
}

export interface UploadTicketResponse {
  /** One-time, user-scoped, short-lived upload endpoint from the image provider. */
  readonly uploadUrl: string;
  readonly imageAssetId: string;
  readonly expiresAt: string;
  readonly maxBytes: number;
  readonly allowedTypes: readonly string[];
}

export interface CheckoutSessionResponse {
  /** Stripe-hosted Checkout URL. The browser is redirected here. */
  readonly url: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/** What the success page may learn. Note it cannot *cause* anything. */
export interface CheckoutStatusResponse {
  readonly reservationId: string;
  readonly reservationState: ReservationState;
  readonly paymentStatus: PaymentStatus;
  readonly placementStatus: PlacementStatus;
  readonly amountCents: number;
  readonly currency: 'USD';
  /** True once the webhook has fulfilled. The page polls; it never fulfils. */
  readonly fulfilled: boolean;
  readonly shareUrl: string | null;
}

// -----------------------------------------------------------------------------
// Buyer dashboard
// -----------------------------------------------------------------------------

export interface DashboardPlacement {
  readonly placementId: string;
  readonly reservationId: string;
  readonly state: ReservationState;
  readonly placementStatus: PlacementStatus;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly logicalPixels: number;
  readonly title: string;
  readonly altText: string;
  readonly destinationUrl: string | null;
  readonly destinationHost: string | null;
  readonly imageUrl: string | null;
  readonly amountPaidCents: number;
  readonly currency: 'USD';
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly activatedAt: string | null;
  /** Aggregated, fraud-filtered. Documented as eventually consistent. */
  readonly metrics: {
    readonly impressions: number;
    readonly clicks: number;
    readonly clicks7d: number;
    readonly lastClickAt: string | null;
  };
  readonly shareUrl: string | null;
  readonly moderationNote: string | null;
}

export interface DashboardResponse {
  readonly profile: {
    readonly id: string;
    readonly displayName: string | null;
    readonly handle: string | null;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly foundingBuyer: boolean;
    readonly isAdmin: boolean;
  };
  readonly totals: {
    readonly activePlacements: number;
    readonly logicalPixelsOwned: number;
    readonly lifetimeSpendCents: number;
    readonly impressions: number;
    readonly clicks: number;
  };
  readonly placements: readonly DashboardPlacement[];
}

// -----------------------------------------------------------------------------
// Admin
// -----------------------------------------------------------------------------

export interface AdminModerationItem {
  readonly placementId: string;
  readonly reservationId: string;
  readonly placementStatus: PlacementStatus;
  readonly reservationState: ReservationState;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly title: string;
  readonly altText: string;
  readonly destinationUrl: string | null;
  readonly destinationHost: string | null;
  /** Private quarantine variant — admin-only signed URL. */
  readonly imageReviewUrl: string | null;
  readonly buyer: { readonly id: string; readonly email: string; readonly handle: string | null };
  readonly payment: {
    readonly status: PaymentStatus;
    readonly amountCents: number;
    readonly stripeCheckoutSessionId: string | null;
    readonly stripePaymentIntentId: string | null;
    readonly paidAt: string | null;
  };
  readonly automatedChecks: readonly {
    readonly check: string;
    readonly result: 'pass' | 'flag' | 'fail';
    readonly detail: string;
  }[];
  readonly createdAt: string;
}

export interface AdminHealthResponse {
  readonly manifestVersion: number;
  readonly manifestAgeSeconds: number;
  readonly pendingReview: number;
  readonly openCheckouts: number;
  readonly expiredAwaitingRelease: number;
  readonly unprocessedStripeEvents: number;
  readonly analyticsBacklog: number;
  readonly lastReconcilerRunAt: string | null;
  readonly lastLeaderboardRunAt: string | null;
  readonly linkChecksFailing: number;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly at: string;
  readonly actorId: string | null;
  readonly actorLabel: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  /** Non-sensitive structured detail. Redacted before storage. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}
