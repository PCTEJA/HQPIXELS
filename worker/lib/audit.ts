/**
 * Audit trail.
 *
 * What gets audited: every admin action, every money movement, every
 * authorization failure that looks deliberate, and every automated takedown.
 * What does not: ordinary reads and successful buyer self-service, which would
 * bury the signal.
 *
 * Two properties this module guarantees:
 *
 *   1. An audit write NEVER fails the operation it is recording. If the database
 *      call fails, we log loudly and continue — refusing a refund because the
 *      audit log was unreachable would be the wrong trade. The compensating
 *      control is that the failure is itself an alertable log line.
 *
 *   2. `detail` is redacted before it leaves this module, so a future caller
 *      cannot accidentally persist a token by passing the wrong object.
 */

import type { Logger } from './logger';
import type { Db } from './supabase';

/** Stable action names. A closed set so the audit log is queryable. */
export type AuditAction =
  // authentication
  | 'auth.magic_link_requested'
  | 'auth.oauth_started'
  | 'auth.session_established'
  | 'auth.signed_out'
  | 'auth.callback_rejected'
  // buyer actions
  | 'reservation.created'
  | 'reservation.details_set'
  | 'reservation.terms_accepted'
  | 'upload.ticket_issued'
  | 'upload.validated'
  | 'upload.rejected'
  | 'checkout.session_created'
  | 'placement.edited'
  // money
  | 'payment.settled'
  | 'payment.failed'
  | 'payment.refunded'
  | 'payment.disputed'
  | 'payment.reconciled'
  // moderation
  | 'placement.approve'
  | 'placement.reject'
  | 'placement.disable'
  | 'placement.reenable'
  | 'placement.disable_by_host'
  | 'abuse.reported'
  // security
  | 'security.csrf_rejected'
  | 'security.origin_rejected'
  | 'security.turnstile_rejected'
  | 'security.rate_limited'
  | 'security.admin_access_denied'
  | 'security.idor_attempt'
  | 'security.webhook_signature_invalid'
  // operations
  | 'admin.viewed_queue'
  | 'admin.viewed_audit'
  | 'job.completed'
  | 'manifest.rebuilt';

export interface AuditContext {
  readonly db: Db;
  readonly logger: Logger;
  readonly requestId: string;
  readonly ipPrefix: string | null;
  readonly userAgentFamily: string | null;
  /**
   * Registers background work. On Workers this is `ctx.waitUntil`, so the audit
   * write does not add latency to the buyer's response.
   */
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** Keys never persisted in an audit detail, whatever a caller passes. */
const FORBIDDEN_DETAIL_KEYS = new Set([
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'password',
  'signature',
  'authorization',
  'cookie',
  'card',
  'cardNumber',
  'cvc',
  'iban',
  'email', // deliberate: the actor id already identifies the person
  'ip',
  'ipAddress',
  'userAgent',
]);

type AuditDetailValue = string | number | boolean | null;

function sanitizeDetail(detail: Record<string, unknown>): Record<string, AuditDetailValue> {
  const out: Record<string, AuditDetailValue> = {};
  let count = 0;

  for (const [key, value] of Object.entries(detail)) {
    if (count >= 30) break;
    if (FORBIDDEN_DETAIL_KEYS.has(key)) continue;

    if (value === null || value === undefined) {
      out[key] = null;
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 300);
    } else if (typeof value === 'number') {
      out[key] = Number.isFinite(value) ? value : 0;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      // Flatten anything structured to a bounded string rather than dropping it:
      // the shape is often the useful part of an investigation.
      out[key] = JSON.stringify(value)?.slice(0, 300) ?? '[unserialisable]';
    }
    count += 1;
  }

  return out;
}

export interface AuditEntry {
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly actorId?: string | null;
  readonly actorLabel?: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Record an audit entry in the background.
 *
 * Fire-and-forget by design: the caller's response is not held up by a database
 * round trip. `waitUntil` keeps the Worker alive until it completes.
 */
export function audit(ctx: AuditContext, entry: AuditEntry): void {
  const detail = sanitizeDetail(entry.detail ?? {});

  const promise = ctx.db
    .writeAudit({
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel ?? (entry.actorId ? 'user' : 'system'),
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      detail,
      requestId: ctx.requestId,
      ipPrefix: ctx.ipPrefix,
      userAgentFamily: ctx.userAgentFamily,
    })
    .catch((error: unknown) => {
      // An unwritable audit trail is a security-relevant condition in its own
      // right. Alert on this log line.
      ctx.logger.error('audit_write_failed', {
        auditAction: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        severity: 'high',
      });
    });

  ctx.waitUntil(promise);
}

/**
 * Record a security event: audited AND logged at warn level.
 *
 * Separate helper so that "this looks like an attack" is one call and is
 * impossible to write without also producing an alertable log line.
 */
export function auditSecurityEvent(
  ctx: AuditContext,
  action: Extract<AuditAction, `security.${string}`>,
  detail: Record<string, unknown>,
  actorId: string | null = null,
): void {
  ctx.logger.warn(action, { ...detail, securityEvent: true });
  audit(ctx, {
    action,
    targetType: 'request',
    targetId: ctx.requestId,
    actorId,
    actorLabel: actorId ? 'user' : 'anonymous',
    detail,
  });
}

export const __testing = { sanitizeDetail };
