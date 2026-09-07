/**
 * The single HTTP client.
 *
 * Nothing in the app calls `fetch` directly. Routing every request through here
 * means these properties hold everywhere, not just where someone remembered:
 *
 *   * `credentials: 'same-origin'` so the HttpOnly session cookie is sent, and
 *     is never sent anywhere else.
 *   * The CSRF token is attached to every mutating request automatically.
 *   * A `csrf_failed` response triggers exactly one token refresh and one retry,
 *     which is what stops a long-open tab from failing a purchase.
 *   * Errors arrive as a typed `ApiRequestError` carrying the server's stable
 *     code and correlation id, so the UI can react to `cells_unavailable`
 *     differently from `rate_limited` without string matching.
 *
 * There is deliberately no token in localStorage or sessionStorage. The session
 * lives in a cookie the browser cannot read.
 */

import type { ApiErrorBody, ApiErrorCode } from '@shared/api-types';
import { CSRF_HEADER } from '@shared/constants';

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'network_error' | 'unknown',
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly fields: Readonly<Record<string, string>> | undefined,
    readonly retryAfter: number | undefined,
    /** The parsed body, for endpoints that return extra context (e.g. a new quote). */
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** True for conditions a retry might actually fix. */
  get isRetryable(): boolean {
    return (
      this.code === 'network_error' ||
      this.code === 'upstream_unavailable' ||
      this.code === 'conflict' ||
      this.status >= 500
    );
  }

  get isAuthError(): boolean {
    return this.code === 'unauthenticated' || this.status === 401;
  }
}

// -----------------------------------------------------------------------------
// CSRF token handling
// -----------------------------------------------------------------------------

/**
 * Held in a module-scope variable, not in storage.
 *
 * The cookie is readable by JavaScript by design (it is the double-submit half),
 * but reading it from `document.cookie` on every request is both slower and
 * easier to get wrong than caching what the session endpoint told us.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** Fallback: read the double-submit cookie directly if we have no cached token. */
function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = /(?:^|;\s*)hq-csrf=([^;]*)/.exec(document.cookie);
  return match?.[1] ?? null;
}

/**
 * Re-establish the session and CSRF token.
 *
 * Called on boot and after a `csrf_failed`. Returns the token so a retry can use
 * it immediately rather than racing the module variable.
 */
export async function refreshSession(): Promise<SessionResponse> {
  const response = await fetch('/api/auth/session', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new ApiRequestError(
      'unknown',
      'We could not reach HQPixels. Check your connection and reload.',
      response.status,
      response.headers.get('x-hq-request-id'),
      undefined,
      undefined,
      null,
    );
  }

  const body = (await response.json()) as SessionResponse;
  setCsrfToken(body.csrfToken);
  return body;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly handle: string | null;
  readonly foundingBuyer: boolean;
  readonly isAdmin: boolean;
}

export interface SessionResponse {
  readonly authenticated: boolean;
  readonly user: SessionUser | null;
  readonly csrfToken: string;
  readonly csrfExpiresInSeconds: number;
}

// -----------------------------------------------------------------------------
// The request function
// -----------------------------------------------------------------------------

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Allow analytics requests to finish when the page unloads. */
  readonly keepalive?: boolean;
  /** Sends If-None-Match, and resolves to `notModified` on a 304. */
  readonly ifNoneMatch?: string | null;
  /** Internal: prevents an infinite refresh/retry loop. */
  readonly isRetry?: boolean;
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly etag: string | null;
  readonly notModified: boolean;
  readonly requestId: string | null;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResponse<T>> {
  const method = options.method ?? 'GET';

  // Only ever same-origin, relative paths. An absolute URL here would send the
  // session cookie somewhere it does not belong.
  if (!path.startsWith('/')) {
    throw new Error(`apiRequest expects a same-origin path, got: ${path}`);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;

  if (MUTATING_METHODS.has(method)) {
    const token = csrfToken ?? readCsrfCookie();
    if (token !== null) headers[CSRF_HEADER] = token;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // Sends cookies to our own origin, and only our own origin.
      credentials: 'same-origin',
      headers,
      ...(options.keepalive ? { keepalive: true } : {}),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      // Never let a browser cache a mutation or an authenticated read.
      cache: MUTATING_METHODS.has(method) ? 'no-store' : 'default',
      // A redirect on an API call is never expected and would be suspicious.
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(
      'network_error',
      'We could not reach HQPixels. Check your connection and try again.',
      0,
      null,
      undefined,
      undefined,
      null,
    );
  }

  const requestId = response.headers.get('x-hq-request-id');
  const etag = response.headers.get('etag');

  if (response.status === 304) {
    return { data: undefined as T, etag, notModified: true, requestId };
  }

  if (response.status === 204) {
    return { data: undefined as T, etag, notModified: false, requestId };
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (response.ok) {
    return { data: parsed as T, etag, notModified: false, requestId };
  }

  // --- error path -------------------------------------------------------------
  const errorBody = parsed as ApiErrorBody | null;
  const code = errorBody?.error?.code ?? 'unknown';
  const message =
    errorBody?.error?.message ?? 'Something went wrong. Please try again in a moment.';

  // A stale CSRF token is the one failure worth transparently recovering from:
  // it happens to anyone who leaves a tab open, and failing their purchase over
  // it would be indefensible.
  if (code === 'csrf_failed' && options.isRetry !== true) {
    await refreshSession();
    return apiRequest<T>(path, { ...options, isRetry: true });
  }

  throw new ApiRequestError(
    code,
    message,
    response.status,
    errorBody?.error?.requestId ?? requestId,
    errorBody?.error?.fields,
    errorBody?.error?.retryAfter,
    parsed,
  );
}

/** Convenience wrappers. */
export const api = {
  get: <T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', ...(body !== undefined ? { body } : {}) }),

  patch: <T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', ...(body !== undefined ? { body } : {}) }),
};

/**
 * Fire-and-forget beacon.
 *
 * Used for page views and impressions. `keepalive` lets the request survive the
 * page unloading, and every failure is swallowed — analytics must never surface
 * an error to a visitor.
 */
export function beacon(path: string, body: unknown): void {
  if (typeof fetch === 'undefined') return;

  const send = async (): Promise<void> => {
    // The first page view can precede session bootstrap. Obtain the token
    // before posting, then use the same stale-token recovery as other mutations.
    if ((csrfToken ?? readCsrfCookie()) === null) await refreshSession();
    await apiRequest(path, { method: 'POST', body, keepalive: true });
  };
  void send().catch(() => undefined);
}
