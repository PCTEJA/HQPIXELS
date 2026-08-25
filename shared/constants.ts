/**
 * Wall geometry and hard limits.
 *
 * These are the single source of truth for the client, the Worker and the SQL
 * migrations. If you change one, change the matching CHECK constraint in
 * `supabase/migrations/*_core_tables.sql` and re-run the DB tests — the
 * database is the authority, this file only mirrors it.
 */

/** The wall is 1000 x 1000 *logical* pixels. This is the coordinate space quoted to buyers. */
export const WALL_LOGICAL_SIZE = 1000;

/** One purchasable unit ("cell") is 10 x 10 logical pixels. */
export const CELL_LOGICAL_SIZE = 10;

/** 100 x 100 cells. Cell coordinates are 0-indexed: 0..99 on both axes. */
export const GRID_SIZE = WALL_LOGICAL_SIZE / CELL_LOGICAL_SIZE;

/** 10,000 purchasable units. */
export const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;

/** 100 logical pixels per unit. The minimum purchase. */
export const LOGICAL_PIXELS_PER_CELL = CELL_LOGICAL_SIZE * CELL_LOGICAL_SIZE;

/** 1,000,000 logical pixels total. */
export const TOTAL_LOGICAL_PIXELS = TOTAL_CELLS * LOGICAL_PIXELS_PER_CELL;

/**
 * Largest single reservation, in cells (50 x 50 = 2500 cells = 250,000 logical
 * pixels = 25% of the wall). Bounds the RPC's per-transaction work and stops a
 * single actor from locking the whole wall in one request.
 */
export const MAX_SELECTION_CELLS = 2500;

/** Smallest purchase: one cell. */
export const MIN_SELECTION_CELLS = 1;

/** Longest side of a single reservation rectangle, in cells. */
export const MAX_SELECTION_SIDE = 100;

// -----------------------------------------------------------------------------
// Reservation / checkout timing
// -----------------------------------------------------------------------------

/**
 * How long a reservation holds its cells. 45 minutes.
 *
 * Stripe requires a Checkout Session `expires_at` at least 30 minutes in the
 * future, so a 45 minute hold leaves a 15 minute window during which checkout
 * can be created with an expiry that lands *before* the reservation lapses.
 * The invariant we maintain everywhere: checkoutExpiry <= reservationExpiry.
 */
export const RESERVATION_TTL_SECONDS = 45 * 60;

/** Stripe's minimum Checkout Session lifetime. Do not lower. */
export const STRIPE_CHECKOUT_MIN_TTL_SECONDS = 30 * 60;

/**
 * A reservation with less than this much time left cannot start checkout,
 * because we could not give Stripe a legal `expires_at` that still precedes the
 * reservation expiry. The UI surfaces "re-reserve to continue".
 */
export const CHECKOUT_MIN_REMAINING_SECONDS = STRIPE_CHECKOUT_MIN_TTL_SECONDS;

/** Grace period after expiry before the reconciler releases cells, to absorb clock skew. */
export const RESERVATION_EXPIRY_GRACE_SECONDS = 60;

// -----------------------------------------------------------------------------
// Media
// -----------------------------------------------------------------------------

/** 2 MB. Enforced client-side (UX), at the upload URL request, and by the image provider. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Only raster web formats. No SVG (script carrier), no GIF, no PDF, no HTML. */
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

/** Longest side of an uploaded image, in real pixels. */
export const MAX_IMAGE_DIMENSION = 4000;

/** Decoded pixel budget — the real defence against decompression bombs. */
export const MAX_IMAGE_PIXEL_COUNT = 4_000_000;

/** Smallest useful upload: must at least cover one cell at 1x. */
export const MIN_IMAGE_DIMENSION = 10;

// -----------------------------------------------------------------------------
// Text limits (also enforced as CHECK constraints)
// -----------------------------------------------------------------------------

export const MAX_TITLE_LENGTH = 60;
export const MAX_ALT_TEXT_LENGTH = 140;
export const MAX_DESTINATION_URL_LENGTH = 512;
export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_HANDLE_LENGTH = 30;
export const MAX_ADMIN_NOTE_LENGTH = 2000;
export const MAX_ABUSE_REPORT_LENGTH = 1000;

// -----------------------------------------------------------------------------
// Caching
// -----------------------------------------------------------------------------

/**
 * Wall manifest freshness. Short fresh window plus a long stale-while-revalidate
 * so a viewer spike is absorbed by the edge: at most one origin revalidation per
 * colo per 30s, and stale content is served instantly meanwhile.
 */
export const MANIFEST_MAX_AGE_SECONDS = 30;
export const MANIFEST_SWR_SECONDS = 300;

export const STATS_MAX_AGE_SECONDS = 60;
export const STATS_SWR_SECONDS = 600;

export const RANKINGS_MAX_AGE_SECONDS = 300;
export const RANKINGS_SWR_SECONDS = 1800;

/** How often a *visible* tab revalidates the manifest with an If-None-Match. */
export const CLIENT_MANIFEST_POLL_MS = 60_000;

/** KV keys. Versioned so a schema change cannot serve a stale shape. */
export const KV_KEY_MANIFEST = 'manifest:v1';
export const KV_KEY_MANIFEST_VERSION = 'manifest:v1:version';
export const KV_KEY_STATS = 'stats:v1';
export const KV_KEY_RANKINGS = 'rankings:v1';
export const KV_KEY_MANIFEST_DIRTY = 'manifest:v1:dirty';

// -----------------------------------------------------------------------------
// Analytics
// -----------------------------------------------------------------------------

/** Aggregation bucket for views and clicks: 5 minutes. */
export const ANALYTICS_BUCKET_SECONDS = 300;

/** Durable Object flush cadence. Bounds "how stale can the public counter be". */
export const ANALYTICS_FLUSH_INTERVAL_MS = 60_000;

/** Documented public claim: counters can lag by up to this long. */
export const ANALYTICS_MAX_LAG_SECONDS = 180;

// -----------------------------------------------------------------------------
// Cookie names (all Worker-managed)
// -----------------------------------------------------------------------------

/** Supabase access/refresh tokens, HttpOnly. Chunked if over the 4KB cookie limit. */
export const COOKIE_SESSION_PREFIX = 'hq-auth';
/** OAuth PKCE verifier + state, HttpOnly, short-lived. */
export const COOKIE_OAUTH_FLOW = 'hq-oauth';
/** Double-submit CSRF token. Readable by JS *by design* — the secret is the HMAC key. */
export const COOKIE_CSRF = 'hq-csrf';
/** Opaque, rotating id used for click de-duplication. Not linked to identity. */
export const COOKIE_VISITOR = 'hq-v';

export const CSRF_HEADER = 'x-hq-csrf';
export const CORRELATION_HEADER = 'x-hq-request-id';

/** CSRF token lifetime. */
export const CSRF_TTL_SECONDS = 12 * 60 * 60;

/** Visitor cookie lifetime — short by design; this is abuse control, not analytics identity. */
export const VISITOR_COOKIE_TTL_SECONDS = 24 * 60 * 60;

// -----------------------------------------------------------------------------
// Rate limits — starting values, tuned with load testing. See SECURITY.md.
// -----------------------------------------------------------------------------

export const RATE_LIMITS = {
  /** Magic link / OAuth start: 5 per 10 min per IP and per email. */
  authStart: { limit: 5, windowSeconds: 600 },
  /** Reservation creation. Two windows, both enforced. */
  reserveBurst: { limit: 10, windowSeconds: 60 },
  reserveHourly: { limit: 20, windowSeconds: 3600 },
  /** One-time upload URL issuance. */
  uploadUrl: { limit: 5, windowSeconds: 600 },
  /** Checkout Session creation, per user and per reservation. */
  checkout: { limit: 3, windowSeconds: 600 },
  /** Outbound click redirects, per visitor cookie. */
  clickRedirect: { limit: 60, windowSeconds: 60 },
  /** Placement metadata edits. */
  placementUpdate: { limit: 20, windowSeconds: 600 },
  /** Abuse reports from anonymous visitors. */
  abuseReport: { limit: 5, windowSeconds: 3600 },
  /** Global circuit breaker on all mutating API traffic, per IP. */
  mutationGlobal: { limit: 120, windowSeconds: 60 },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

// -----------------------------------------------------------------------------
// Misc
// -----------------------------------------------------------------------------

export const CURRENCY = 'USD' as const;

/** Number of entries in each public leaderboard. */
export const LEADERBOARD_SIZE = 25;

/** "Rising" leaderboard window. */
export const RISING_WINDOW_HOURS = 48;

/** A placement needs at least this many fraud-filtered clicks to appear in "Rising". */
export const RISING_MIN_CLICKS = 25;

/** The first N settled buyers get the founding-buyer badge. Truthful and fixed. */
export const FOUNDING_BUYER_LIMIT = 100;

/** Outbound link relationship. `sponsored` is required: these are paid placements. */
export const OUTBOUND_LINK_REL = 'sponsored nofollow noopener noreferrer';
