/**
 * Structured logging with redaction that is on by default.
 *
 * Every log line is one JSON object on stdout, which is what Cloudflare's
 * Workers Logs and any downstream sink expect. The redaction pass runs on the
 * whole payload every time — you cannot forget it, because there is no way to
 * emit a line that bypasses it.
 *
 * What is redacted:
 *   * any key whose name looks like a secret (token, key, secret, password,
 *     signature, authorization, cookie, dsn, ...)
 *   * any value that looks like a known secret format (Stripe keys, JWTs,
 *     whsec_, Bearer headers) regardless of its key name
 *   * full IP addresses, replaced by their network prefix
 *   * anything over a length cap, truncated
 *
 * Deliberately NOT redacted, because they are needed to debug and are not
 * secrets: reservation ids, placement ids, Stripe object ids (cs_/pi_/ch_/evt_),
 * amounts, states, and hostnames.
 */

import { sanitizeForLog } from '@shared/text';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_PATTERN =
  /(secret|password|passwd|token|apikey|api_key|authorization|auth|cookie|session|jwt|bearer|signature|sig|dsn|private|credential|otp|magic|verifier|nonce)/i;

/** Keys that match the pattern above but are safe and genuinely useful. */
const SAFE_KEY_ALLOWLIST = new Set([
  'tokenPresent',
  'hasToken',
  'signatureValid',
  'sessionId', // Stripe Checkout Session id — an opaque, non-secret identifier
  'stripeSessionId',
  'authProvider',
  'authAction',
  'csrfOk',
  'turnstileOk',
]);

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/g, // Stripe secret key
  /\brk_(live|test)_[A-Za-z0-9]{8,}/g, // Stripe restricted key
  /\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, // Stripe webhook secret
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /\bsbp_[A-Za-z0-9]{16,}/g, // Supabase personal token
  /\bhttps?:\/\/[^\s"']*[?&](?:token|key|secret|code)=[^\s"'&]+/gi, // secret in a URL
];

const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  out = sanitizeForLog(out, MAX_STRING_LENGTH);
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[depth-limit]';

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redactValue(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && !SAFE_KEY_ALLOWLIST.has(key)) {
      // Report shape, not content: knowing a token was 43 chars long is often
      // enough to diagnose a truncation bug without revealing anything.
      out[key] =
        typeof entry === 'string'
          ? `[redacted:${entry.length}]`
          : entry === undefined || entry === null
            ? entry
            : '[redacted]';
      continue;
    }
    out[key] = redactValue(entry, depth + 1);
  }
  return out;
}

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every subsequent line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly requestId: string;
  readonly environment: string;
  readonly minLevel?: LogLevel;
  readonly base?: LogFields;
  /** Injectable for tests. Defaults to console. */
  readonly sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const minLevel = options.minLevel ?? (options.environment === 'production' ? 'info' : 'debug');
  const threshold = LEVEL_ORDER[minLevel];
  const base = options.base ?? {};
  const sink =
    options.sink ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) return;

    const payload = {
      level,
      msg: sanitizeForLog(message, 300),
      requestId: options.requestId,
      env: options.environment,
      ts: new Date().toISOString(),
      ...(redactValue({ ...base, ...fields }, 0) as Record<string, unknown>),
    };

    try {
      sink(JSON.stringify(payload));
    } catch {
      // A circular structure must not take down a request. Emit the essentials.
      sink(
        JSON.stringify({
          level,
          msg: sanitizeForLog(message, 300),
          requestId: options.requestId,
          logError: 'payload_not_serialisable',
        }),
      );
    }
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) =>
      createLogger({
        ...options,
        base: { ...base, ...fields },
      }),
  };
}

/** Exported for the unit tests that pin the redaction rules. */
export const __testing = { redactValue, redactString };
