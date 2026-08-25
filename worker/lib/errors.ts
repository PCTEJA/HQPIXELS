/**
 * Error handling.
 *
 * Two rules, and everything else follows from them:
 *
 *   1. A client receives a stable machine code, a short human sentence, and a
 *      correlation id. Never a stack trace, SQL text, provider response body,
 *      internal hostname, or the value of anything it sent.
 *   2. The server log receives enough non-secret context to diagnose the same
 *      failure, keyed by that correlation id.
 *
 * That split is what lets support say "quote me your request id" without the
 * error itself becoming a reconnaissance tool.
 */

import type { ApiErrorBody, ApiErrorCode } from '@shared/api-types';

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  email_unverified: 403,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  cells_unavailable: 409,
  quote_changed: 409,
  reservation_expired: 410,
  reservation_state_invalid: 409,
  checkout_window_too_short: 409,
  checkout_already_open: 409,
  csrf_failed: 403,
  origin_rejected: 403,
  turnstile_failed: 403,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  upstream_unavailable: 502,
  internal_error: 500,
  maintenance: 503,
};

/**
 * Default user-facing copy. Deliberately plain and non-technical: the person
 * reading it is usually a buyer mid-purchase, not an engineer.
 */
const DEFAULT_MESSAGE: Readonly<Record<ApiErrorCode, string>> = {
  bad_request: 'That request was not something we could process.',
  validation_failed: 'Some details need fixing before we can continue.',
  unauthenticated: 'Please sign in to continue.',
  email_unverified: 'Confirm your email address before buying space.',
  forbidden: 'You do not have access to that.',
  not_found: 'We could not find that.',
  conflict: 'That conflicts with something that changed. Please try again.',
  cells_unavailable: 'Someone claimed part of that area first. Pick another spot.',
  quote_changed: 'The price for that selection changed. Review the new total before paying.',
  reservation_expired: 'Your hold expired and the units returned to the wall.',
  reservation_state_invalid: 'This claim is not at a stage where that is possible.',
  checkout_window_too_short:
    'Your hold is too close to expiring to start payment. Re-select to get a fresh hold.',
  checkout_already_open: 'A payment page is already open for this claim.',
  csrf_failed: 'Your session looks stale. Reload the page and try again.',
  origin_rejected: 'That request did not come from hqpixels.com.',
  turnstile_failed: 'We could not verify that you are human. Please try again.',
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
  payload_too_large: 'That upload is too large.',
  unsupported_media_type: 'We accept JPEG, PNG and WebP images only.',
  upstream_unavailable: 'A service we depend on is not responding. Please try again shortly.',
  internal_error: 'Something went wrong on our side.',
  maintenance: 'HQPixels is briefly unavailable. Please try again in a few minutes.',
};

export interface ApiErrorOptions {
  /** Overrides the default user-facing sentence. Must contain no internal detail. */
  readonly message?: string;
  /** Field-level messages for form errors, keyed by dotted path. */
  readonly fields?: Readonly<Record<string, string>>;
  /** Seconds, for 429 responses. */
  readonly retryAfter?: number;
  /**
   * Context for the LOG ONLY. Never serialised to the client. Put the SQL error
   * code, the provider reason, the reservation id, etc. here.
   */
  readonly logContext?: Readonly<Record<string, unknown>>;
  /** Original error, for the log. Never reaches the client. */
  readonly cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly fields?: Readonly<Record<string, string>>;
  readonly retryAfter?: number;
  readonly logContext: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(code: ApiErrorCode, options: ApiErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.logContext = options.logContext ?? {};
    if (options.fields !== undefined) this.fields = options.fields;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
      },
    };
  }
}

// -----------------------------------------------------------------------------
// Convenience constructors — used so the call sites stay readable
// -----------------------------------------------------------------------------

export const badRequest = (o?: ApiErrorOptions) => new ApiError('bad_request', o);
export const validationFailed = (o?: ApiErrorOptions) => new ApiError('validation_failed', o);
export const unauthenticated = (o?: ApiErrorOptions) => new ApiError('unauthenticated', o);
export const forbidden = (o?: ApiErrorOptions) => new ApiError('forbidden', o);
export const notFound = (o?: ApiErrorOptions) => new ApiError('not_found', o);
export const conflict = (o?: ApiErrorOptions) => new ApiError('conflict', o);
export const rateLimited = (retryAfter: number, o?: ApiErrorOptions) =>
  new ApiError('rate_limited', { ...o, retryAfter });
export const internalError = (o?: ApiErrorOptions) => new ApiError('internal_error', o);
export const upstreamUnavailable = (o?: ApiErrorOptions) => new ApiError('upstream_unavailable', o);

/**
 * Map a Zod error to a field-keyed message record.
 *
 * Only the *message* is exposed, never the received value — a validation error
 * that echoes input back is a reflected-XSS and information-disclosure vector in
 * one. Messages come from our own schemas, so they are safe strings.
 */
export function zodFieldErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    // First error per field wins; a field with four complaints is noise.
    if (fields[key] === undefined) fields[key] = issue.message;
  }
  return fields;
}

/**
 * Turn an unknown thrown value into something safe to log.
 *
 * Returns a plain object with a bounded message and no `cause` chain, because a
 * cause chain from a fetch failure can contain a full request URL including
 * query parameters.
 */
export function describeUnknownError(error: unknown): {
  name: string;
  message: string;
  stackHead?: string;
} {
  if (error instanceof Error) {
    const stackLine = error.stack?.split('\n')[1]?.trim();
    return {
      name: error.name,
      message: error.message.slice(0, 500),
      ...(stackLine ? { stackHead: stackLine.slice(0, 300) } : {}),
    };
  }
  if (typeof error === 'string') return { name: 'ThrownString', message: error.slice(0, 500) };
  return { name: typeof error, message: 'Non-Error value thrown' };
}

/**
 * Map a PostgreSQL/Supabase RPC failure onto an ApiError.
 *
 * The database raises named exceptions (see the migrations) for conditions that
 * indicate either an attack or a bug. Anything unrecognised becomes a generic
 * 500 with the detail logged — never surfaced.
 */
export function mapDatabaseError(
  error: unknown,
  requestContext: Record<string, unknown> = {},
): ApiError {
  const raw = error instanceof Error ? error.message : String(error);
  const context = { ...requestContext, dbError: raw.slice(0, 300) };

  // These indicate the application and the database disagree, which must never
  // be papered over with a friendly retry message.
  if (raw.includes('quote_engine_disagreement')) {
    return internalError({
      message: 'We could not confirm the price for that selection. Nothing has been charged.',
      logContext: { ...context, severity: 'critical', reason: 'pricing_engine_mismatch' },
    });
  }
  if (
    raw.includes('checkout_amount_mismatch') ||
    raw.includes('checkout_expiry_after_reservation')
  ) {
    return internalError({
      message: 'We could not start payment for that claim. Nothing has been charged.',
      logContext: { ...context, severity: 'critical', reason: 'checkout_invariant_violated' },
    });
  }
  if (raw.includes('admin_required')) {
    return forbidden({ logContext: context });
  }
  if (
    raw.includes('illegal_reservation_transition') ||
    raw.includes('illegal_placement_activation')
  ) {
    return new ApiError('reservation_state_invalid', { logContext: context });
  }
  if (raw.includes('immutable_field_changed') || raw.includes('privilege_change_not_allowed')) {
    return forbidden({ logContext: { ...context, severity: 'high' } });
  }
  if (raw.includes('append-only')) {
    return forbidden({ logContext: { ...context, severity: 'high' } });
  }

  return internalError({ logContext: context, cause: error });
}
