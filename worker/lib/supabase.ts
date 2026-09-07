/**
 * Typed access to the database.
 *
 * Every call is a POST to a PostgREST RPC endpoint, invoking one of the
 * SECURITY DEFINER functions in supabase/migrations. There is no table-level
 * read or write from the Worker and no query string built from user input, which
 * is what makes SQL injection structurally impossible here: the only thing
 * crossing the boundary is a JSON object of named, typed parameters.
 *
 * Deliberately hand-rolled fetch rather than @supabase/supabase-js for the data
 * path:
 *   * the SDK's query builder would let a future contributor write a
 *     table-level query and bypass the RPC contract,
 *   * it is a large dependency for what is a single POST, and
 *   * an injectable `rpc` function makes every route unit-testable with no
 *     database and no network.
 *
 * The auth flows DO use @supabase/ssr — see worker/lib/auth.ts — because
 * reimplementing PKCE and token refresh would be a genuinely bad idea.
 */

import type { ReservationState } from '@shared/states';

export interface RpcOptions {
  /** Abort long calls so a slow database cannot hold a Worker request open. */
  readonly timeoutMs?: number;
}

export class RpcError extends Error {
  constructor(
    readonly fn: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`RPC ${fn} failed (${status}): ${detail}`);
    this.name = 'RpcError';
  }
}

/** The single primitive. Everything below is a typed wrapper over it. */
export type RpcCaller = <T>(
  fn: string,
  args: Record<string, unknown>,
  options?: RpcOptions,
) => Promise<T>;

export interface SupabaseRpcConfig {
  readonly url: string;
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly defaultTimeoutMs?: number;
}

export function createRpcCaller(config: SupabaseRpcConfig): RpcCaller {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.url.replace(/\/+$/, '');
  const defaultTimeout = config.defaultTimeoutMs ?? 8000;

  return async function rpc<T>(
    fn: string,
    args: Record<string, unknown>,
    options?: RpcOptions,
  ): Promise<T> {
    // Function names are compile-time constants from this module. Validate anyway
    // so a future dynamic caller cannot build a path traversal.
    if (!/^[a-z_][a-z0-9_]*$/.test(fn)) {
      throw new RpcError(fn, 400, 'illegal function name');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? defaultTimeout);

    try {
      const response = await doFetch(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: config.serviceKey,
          Authorization: `Bearer ${config.serviceKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Ask PostgREST for the scalar/object directly rather than an array.
          'Accept-Profile': 'public',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Read the body for the LOG, never for the client. PostgREST includes the
        // PostgreSQL message here, which is exactly what must not be echoed.
        const text = await response.text().catch(() => '');
        throw new RpcError(fn, response.status, text.slice(0, 800));
      }

      if (response.status === 204) return null as T;

      const text = await response.text();
      if (text === '') return null as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RpcError(fn, 504, 'database call timed out');
      }
      throw new RpcError(fn, 502, error instanceof Error ? error.message.slice(0, 300) : 'unknown');
    } finally {
      clearTimeout(timeout);
    }
  };
}

// -----------------------------------------------------------------------------
// Result shapes
// -----------------------------------------------------------------------------

/** Every business RPC returns this discriminated shape. */
export type RpcResult<T> = ({ ok: true } & T) | { ok: false; code: string; [key: string]: unknown };

export function isOk<T>(result: RpcResult<T>): result is { ok: true } & T {
  return result.ok === true;
}

export interface PricingVersionRow {
  readonly id: string;
  readonly version: number;
  readonly currency: 'USD';
  readonly cents_per_logical_pixel: number;
  readonly zone_multipliers: ReadonlyArray<{
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    multiplierBp: number;
  }>;
  readonly min_cells: number;
  readonly max_cells: number;
  readonly reservation_ttl_seconds: number;
  readonly is_active: boolean;
}

export interface ReserveCellsSuccess {
  readonly reservation: {
    readonly id: string;
    readonly state: ReservationState;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly cells: number;
    readonly logicalPixels: number;
    readonly totalCents: number;
    readonly currency: 'USD';
    readonly pricingVersion: number;
    readonly expiresAt: string;
    readonly createdAt: string;
  };
  readonly placementId: string;
}

export interface OpenCheckoutSuccess {
  readonly paymentId: string;
  readonly checkoutAttempt: number;
  readonly amountCents: number;
}

export interface SettlePaymentSuccess {
  readonly alreadySettled: boolean;
  readonly paymentId: string;
  readonly placementId: string;
  readonly reservationState: string;
  readonly buyerOrdinal: number;
  readonly foundingBuyer: boolean;
}

export interface RejectPlacementSuccess {
  readonly reservationId: string;
  readonly paymentId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly stripeChargeId: string | null;
  readonly refundAmountCents: number;
  readonly refundRequired: boolean;
}

export interface StripeEventLedgerResult {
  readonly ok: true;
  readonly isNew: boolean;
  readonly alreadyProcessed: boolean;
  readonly outcome?: string | null;
  readonly attempts?: number;
}

// -----------------------------------------------------------------------------
// The data-access surface
// -----------------------------------------------------------------------------

/**
 * All database operations the application can perform, as one interface.
 *
 * Routes depend on this type, never on the RPC caller, so tests inject a plain
 * object. It also serves as the audit list: if an operation is not here, the
 * Worker cannot do it.
 */
export interface SessionProfile {
  readonly ok: true;
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly isAdmin: boolean;
  readonly foundingBuyer: boolean;
  readonly displayName: string | null;
  readonly handle: string | null;
  readonly buyerOrdinal: number | null;
  readonly acceptedTermsVersion: string | null;
}

export interface Db {
  // --- identity --------------------------------------------------------------
  sessionProfile(userId: string): Promise<RpcResult<Omit<SessionProfile, 'ok'>>>;
  updateProfile(
    userId: string,
    displayName: string | null,
    handle: string | null,
  ): Promise<RpcResult<{ displayName: string | null; handle: string | null }>>;
  recordTermsAcceptance(
    userId: string,
    reservationId: string,
    termsVersion: string,
  ): Promise<RpcResult<{ termsVersion: string }>>;

  // --- pricing / quoting -----------------------------------------------------
  activePricingVersion(): Promise<PricingVersionRow | null>;
  quoteTotalCents(
    pricingVersionId: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<number>;
  unavailableCells(
    x: number,
    y: number,
    w: number,
    h: number,
    limit?: number,
  ): Promise<Array<{ cell_x: number; cell_y: number }>>;

  // --- reservations ----------------------------------------------------------
  reserveCells(input: {
    ownerId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    pricingVersion: number;
    expectedTotalCents: number;
    workerTotalCents: number;
    quoteBreakdown: unknown;
    termsVersion: string;
    ipPrefix: string | null;
  }): Promise<RpcResult<ReserveCellsSuccess>>;

  setPlacementDetails(input: {
    reservationId: string;
    ownerId: string;
    title: string | null;
    altText: string | null;
    destinationUrl: string | null;
    destinationHost: string | null;
    imageAssetId?: string | null;
    imagePublicPath?: string | null;
    imageWidth?: number | null;
    imageHeight?: number | null;
    imageBytes?: number | null;
    imageMime?: string | null;
    moderationState: 'auto_pass' | 'auto_flag' | 'auto_reject';
    checks: unknown;
  }): Promise<RpcResult<{ ready: boolean; placementId: string; state: ReservationState }>>;

  reservationDetail(
    reservationId: string,
    ownerId: string,
  ): Promise<RpcResult<Record<string, unknown>>>;
  reservationStatus(
    reservationId: string,
    ownerId: string,
  ): Promise<RpcResult<Record<string, unknown>>>;
  expireReservations(
    graceSeconds: number,
    limit: number,
  ): Promise<{ ok: boolean; reservationsExpired: number; cellsReleased: number }>;
  cancelReservation(
    reservationId: string,
    ownerId: string,
  ): Promise<RpcResult<{ cellsReleased: number }>>;
  releaseReservation(
    reservationId: string,
    newState: ReservationState,
    reason: string,
  ): Promise<RpcResult<{ cellsReleased: number }>>;

  // --- payments --------------------------------------------------------------
  openCheckout(input: {
    reservationId: string;
    ownerId: string;
    sessionId: string;
    amountCents: number;
    expiresAt: string;
  }): Promise<RpcResult<OpenCheckoutSuccess>>;

  settlePayment(input: {
    reservationId: string;
    sessionId: string;
    amountTotalCents: number;
    currency: string;
    paymentIntentId: string | null;
    chargeId: string | null;
    customerId: string | null;
    requireManualApproval: boolean;
  }): Promise<RpcResult<SettlePaymentSuccess>>;

  failPayment(
    sessionId: string,
    errorCode: string,
    final: boolean,
  ): Promise<RpcResult<Record<string, unknown>>>;
  expireCheckout(sessionId: string): Promise<RpcResult<Record<string, unknown>>>;
  recordRefund(
    chargeOrIntentId: string,
    amountRefundedCents: number,
    reason: string | null,
  ): Promise<RpcResult<Record<string, unknown>>>;
  recordDispute(
    chargeId: string,
    disputeStatus: string,
    closedInOurFavour: boolean,
  ): Promise<RpcResult<Record<string, unknown>>>;
  openPaymentsForReconciliation(limit: number): Promise<
    Array<{
      paymentId: string;
      reservationId: string;
      sessionId: string;
      amountCents: number;
      status: string;
      createdAt: string;
      checkoutExpiresAt: string | null;
    }>
  >;

  // --- stripe event ledger ---------------------------------------------------
  recordStripeEvent(input: {
    eventId: string;
    type: string;
    apiVersion: string | null;
    stripeCreated: string | null;
    payloadSha256: string;
    livemode: boolean;
  }): Promise<StripeEventLedgerResult>;
  finishStripeEvent(
    eventId: string,
    outcome: string,
    reservationId?: string | null,
    paymentId?: string | null,
  ): Promise<void>;

  // --- moderation ------------------------------------------------------------
  approvePlacement(
    placementId: string,
    adminId: string,
    note: string | null,
    requestId: string,
  ): Promise<RpcResult<{ manifestVersion: number }>>;
  rejectPlacement(
    placementId: string,
    adminId: string,
    reason: string,
    requestId: string,
  ): Promise<RpcResult<RejectPlacementSuccess>>;
  disablePlacement(
    placementId: string,
    actorId: string | null,
    reason: string,
    actorKind: 'admin' | 'system' | 'reporter',
    requestId: string,
  ): Promise<RpcResult<Record<string, unknown>>>;
  reenablePlacement(
    placementId: string,
    adminId: string,
    note: string | null,
    requestId: string,
  ): Promise<RpcResult<Record<string, unknown>>>;
  disablePlacementsByHost(
    host: string,
    adminId: string,
    reason: string,
    requestId: string,
  ): Promise<RpcResult<{ disabled: number }>>;
  fileAbuseReport(input: {
    placementId: string;
    category: string;
    details: string;
    ipPrefix: string | null;
    reporterId: string | null;
  }): Promise<RpcResult<{ received: boolean; autoDisabled?: boolean }>>;
  recordLinkCheck(
    placementId: string,
    statusCode: number,
    ok: boolean,
  ): Promise<RpcResult<Record<string, unknown>>>;
  linksDueForCheck(
    limit: number,
  ): Promise<Array<{ placementId: string; url: string; host: string }>>;

  // --- public read paths -----------------------------------------------------
  buildWallManifest(): Promise<Record<string, unknown>>;
  buildRedirectMap(): Promise<Record<string, { url: string; host: string }>>;
  resolveDestination(placementId: string): Promise<RpcResult<{ url: string; host: string }>>;
  manifestVersion(): Promise<number>;
  publicStats(): Promise<Record<string, unknown>>;
  latestLeaderboards(): Promise<Record<string, unknown>>;
  rebuildLeaderboards(): Promise<{ ok: boolean; boards: number }>;

  // --- dashboards ------------------------------------------------------------
  buyerDashboard(ownerId: string): Promise<RpcResult<Record<string, unknown>>>;
  adminModerationQueue(
    adminId: string,
    status: string,
    limit: number,
    cursor: string | null,
  ): Promise<RpcResult<{ items: unknown[]; nextCursor: string | null }>>;
  adminHealth(adminId: string): Promise<RpcResult<Record<string, unknown>>>;
  adminAuditPage(
    adminId: string,
    limit: number,
    before: string | null,
  ): Promise<RpcResult<{ items: unknown[] }>>;

  // --- analytics / jobs ------------------------------------------------------
  ingestViews(batch: unknown[]): Promise<{ ok: boolean }>;
  ingestClicks(batch: unknown[]): Promise<{ ok: boolean }>;
  ingestImpressions(batch: unknown[]): Promise<{ ok: boolean }>;
  purgePrivacyData(): Promise<Record<string, unknown>>;
  recordJobRun(job: string, ok: boolean, items: number, note: string | null): Promise<void>;

  // --- audit -----------------------------------------------------------------
  writeAudit(input: {
    actorId: string | null;
    actorLabel: string;
    action: string;
    targetType: string;
    targetId: string | null;
    detail: Record<string, unknown>;
    requestId: string | null;
    ipPrefix: string | null;
    userAgentFamily: string | null;
  }): Promise<void>;
}

/**
 * Bind the RPC caller into the `Db` surface.
 *
 * Parameter names must match the PL/pgSQL signatures exactly — PostgREST maps
 * JSON keys to named arguments, so a typo here surfaces as "function not found"
 * rather than a silent wrong-argument call.
 */
export function createDb(rpc: RpcCaller): Db {
  return {
    sessionProfile: (userId) => rpc('session_profile', { p_user_id: userId }),

    updateProfile: (userId, displayName, handle) =>
      rpc('update_profile', {
        p_user_id: userId,
        p_display_name: displayName,
        p_handle: handle,
      }),

    recordTermsAcceptance: (userId, reservationId, termsVersion) =>
      rpc('record_terms_acceptance', {
        p_user_id: userId,
        p_reservation_id: reservationId,
        p_terms_version: termsVersion,
      }),

    activePricingVersion: () => rpc('active_pricing_version', {}),

    quoteTotalCents: (pricingVersionId, x, y, w, h) =>
      rpc('quote_total_cents', {
        p_pricing_version_id: pricingVersionId,
        p_x: x,
        p_y: y,
        p_w: w,
        p_h: h,
      }),

    unavailableCells: (x, y, w, h, limit = 50) =>
      rpc('rect_unavailable_cells', { p_x: x, p_y: y, p_w: w, p_h: h, p_limit: limit }),

    reserveCells: (input) =>
      rpc('reserve_cells', {
        p_owner_id: input.ownerId,
        p_x: input.x,
        p_y: input.y,
        p_w: input.w,
        p_h: input.h,
        p_pricing_version: input.pricingVersion,
        p_expected_total_cents: input.expectedTotalCents,
        p_worker_total_cents: input.workerTotalCents,
        p_quote_breakdown: input.quoteBreakdown,
        p_terms_version: input.termsVersion,
        p_ip_prefix: input.ipPrefix,
      }),

    setPlacementDetails: (input) =>
      rpc('set_placement_details', {
        p_reservation_id: input.reservationId,
        p_owner_id: input.ownerId,
        p_title: input.title,
        p_alt_text: input.altText,
        p_destination_url: input.destinationUrl,
        p_destination_host: input.destinationHost,
        p_image_asset_id: input.imageAssetId ?? null,
        p_image_public_path: input.imagePublicPath ?? null,
        p_image_width: input.imageWidth ?? null,
        p_image_height: input.imageHeight ?? null,
        p_image_bytes: input.imageBytes ?? null,
        p_image_mime: input.imageMime ?? null,
        p_moderation_state: input.moderationState,
        p_checks: input.checks,
      }),

    reservationDetail: (reservationId, ownerId) =>
      rpc('reservation_detail', { p_reservation_id: reservationId, p_owner_id: ownerId }),

    reservationStatus: (reservationId, ownerId) =>
      rpc('reservation_status', { p_reservation_id: reservationId, p_owner_id: ownerId }),

    expireReservations: (graceSeconds, limit) =>
      rpc('expire_reservations', { p_grace_seconds: graceSeconds, p_limit: limit }),

    cancelReservation: (reservationId, ownerId) =>
      rpc('cancel_reservation', { p_reservation_id: reservationId, p_owner_id: ownerId }),
    releaseReservation: (reservationId, newState, reason) =>
      rpc('release_reservation', {
        p_reservation_id: reservationId,
        p_new_state: newState,
        p_reason: reason,
      }),

    openCheckout: (input) =>
      rpc('open_checkout', {
        p_reservation_id: input.reservationId,
        p_owner_id: input.ownerId,
        p_session_id: input.sessionId,
        p_amount_cents: input.amountCents,
        p_expires_at: input.expiresAt,
      }),

    settlePayment: (input) =>
      rpc(
        'settle_payment',
        {
          p_reservation_id: input.reservationId,
          p_session_id: input.sessionId,
          p_amount_total_cents: input.amountTotalCents,
          p_currency: input.currency,
          p_payment_intent_id: input.paymentIntentId,
          p_charge_id: input.chargeId,
          p_customer_id: input.customerId,
          p_require_manual_approval: input.requireManualApproval,
        },
        // Fulfilment takes row locks; give it more room than a read.
        { timeoutMs: 15_000 },
      ),

    failPayment: (sessionId, errorCode, final) =>
      rpc('fail_payment', { p_session_id: sessionId, p_error_code: errorCode, p_final: final }),

    expireCheckout: (sessionId) => rpc('expire_checkout', { p_session_id: sessionId }),

    recordRefund: (chargeOrIntentId, amountRefundedCents, reason) =>
      rpc('record_refund', {
        p_charge_or_intent_id: chargeOrIntentId,
        p_amount_refunded_cents: amountRefundedCents,
        p_reason: reason,
      }),

    recordDispute: (chargeId, disputeStatus, closedInOurFavour) =>
      rpc('record_dispute', {
        p_charge_id: chargeId,
        p_dispute_status: disputeStatus,
        p_is_closed_in_our_favour: closedInOurFavour,
      }),

    openPaymentsForReconciliation: (limit) =>
      rpc('open_payments_for_reconciliation', { p_limit: limit }),

    recordStripeEvent: (input) =>
      rpc('record_stripe_event', {
        p_event_id: input.eventId,
        p_type: input.type,
        p_api_version: input.apiVersion,
        p_stripe_created: input.stripeCreated,
        p_payload_sha256: input.payloadSha256,
        p_livemode: input.livemode,
      }),

    finishStripeEvent: (eventId, outcome, reservationId = null, paymentId = null) =>
      rpc('finish_stripe_event', {
        p_event_id: eventId,
        p_outcome: outcome,
        p_reservation_id: reservationId,
        p_payment_id: paymentId,
      }),

    approvePlacement: (placementId, adminId, note, requestId) =>
      rpc('approve_placement', {
        p_placement_id: placementId,
        p_admin_id: adminId,
        p_note: note,
        p_request_id: requestId,
      }),

    rejectPlacement: (placementId, adminId, reason, requestId) =>
      rpc('reject_placement', {
        p_placement_id: placementId,
        p_admin_id: adminId,
        p_reason: reason,
        p_request_id: requestId,
      }),

    disablePlacement: (placementId, actorId, reason, actorKind, requestId) =>
      rpc('disable_placement', {
        p_placement_id: placementId,
        p_actor_id: actorId,
        p_reason: reason,
        p_actor_kind: actorKind,
        p_request_id: requestId,
      }),

    reenablePlacement: (placementId, adminId, note, requestId) =>
      rpc('reenable_placement', {
        p_placement_id: placementId,
        p_admin_id: adminId,
        p_note: note,
        p_request_id: requestId,
      }),

    disablePlacementsByHost: (host, adminId, reason, requestId) =>
      rpc('disable_placements_by_host', {
        p_host: host,
        p_admin_id: adminId,
        p_reason: reason,
        p_request_id: requestId,
      }),

    fileAbuseReport: (input) =>
      rpc('file_abuse_report', {
        p_placement_id: input.placementId,
        p_category: input.category,
        p_details: input.details,
        p_ip_prefix: input.ipPrefix,
        p_reporter_id: input.reporterId,
      }),

    recordLinkCheck: (placementId, statusCode, ok) =>
      rpc('record_link_check', {
        p_placement_id: placementId,
        p_status_code: statusCode,
        p_ok: ok,
      }),

    linksDueForCheck: (limit) => rpc('links_due_for_check', { p_limit: limit }),

    buildWallManifest: () => rpc('build_wall_manifest', {}, { timeoutMs: 20_000 }),
    buildRedirectMap: () => rpc('build_redirect_map', {}, { timeoutMs: 20_000 }),
    resolveDestination: (placementId) =>
      rpc('resolve_destination', { p_placement_id: placementId }),
    manifestVersion: () => rpc('manifest_version', {}),
    publicStats: () => rpc('public_stats_payload', {}, { timeoutMs: 15_000 }),
    latestLeaderboards: () => rpc('latest_leaderboards', {}),
    rebuildLeaderboards: () => rpc('rebuild_leaderboards', {}, { timeoutMs: 25_000 }),

    buyerDashboard: (ownerId) =>
      rpc('buyer_dashboard', { p_owner_id: ownerId }, { timeoutMs: 12_000 }),

    adminModerationQueue: (adminId, status, limit, cursor) =>
      rpc('admin_moderation_queue', {
        p_admin_id: adminId,
        p_status: status,
        p_limit: limit,
        p_cursor: cursor,
      }),

    adminHealth: (adminId) => rpc('admin_health', { p_admin_id: adminId }, { timeoutMs: 15_000 }),

    adminAuditPage: (adminId, limit, before) =>
      rpc('admin_audit_page', { p_admin_id: adminId, p_limit: limit, p_before: before }),

    ingestViews: (batch) => rpc('ingest_view_aggregates', { p_batch: batch }),
    ingestClicks: (batch) => rpc('ingest_click_aggregates', { p_batch: batch }),
    ingestImpressions: (batch) => rpc('ingest_impression_aggregates', { p_batch: batch }),
    purgePrivacyData: () => rpc('purge_expired_privacy_data', {}, { timeoutMs: 30_000 }),

    recordJobRun: (job, ok, items, note) =>
      rpc('record_job_run', { p_job: job, p_ok: ok, p_items: items, p_note: note }),

    writeAudit: (input) =>
      rpc('write_audit', {
        p_actor_id: input.actorId,
        p_actor_label: input.actorLabel,
        p_action: input.action,
        p_target_type: input.targetType,
        p_target_id: input.targetId,
        p_detail: input.detail,
        p_request_id: input.requestId,
        p_ip_prefix: input.ipPrefix,
        p_user_agent_family: input.userAgentFamily,
      }),
  };
}
