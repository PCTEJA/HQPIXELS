/**
 * HTTP-level hardening: security headers, CSP, origin validation, CORS.
 *
 * All of it is applied centrally in `worker/app.ts` so a new route cannot forget
 * it. `tests/e2e/security-headers.spec.ts` asserts the delivered headers, so a
 * regression here fails CI rather than being discovered by a scanner later.
 */

import { randomToken } from './crypto';
import type { AppConfig } from '../env';

/**
 * Third-party origins the browser is allowed to talk to. Every entry has a
 * reason; nothing is here "just in case", because each one widens the CSP.
 *
 *   js.stripe.com          — Stripe.js, required to redirect to hosted Checkout
 *   checkout.stripe.com    — the hosted Checkout page (form-action target)
 *   api.stripe.com         — Stripe.js telemetry/tokenisation endpoint
 *   challenges.cloudflare.com — Turnstile widget
 *   imagedelivery.net      — Cloudflare Images delivery
 *   fonts.googleapis.com / fonts.gstatic.com — webfont CSS + files
 */
const STRIPE_SCRIPT = 'https://js.stripe.com';
const STRIPE_FRAME = 'https://js.stripe.com https://hooks.stripe.com';
const STRIPE_CONNECT = 'https://api.stripe.com https://maps.googleapis.com';
const STRIPE_CHECKOUT = 'https://checkout.stripe.com';
const TURNSTILE = 'https://challenges.cloudflare.com';
const FONTS_CSS = 'https://fonts.googleapis.com';
const FONTS_FILES = 'https://fonts.gstatic.com';

export interface CspOptions {
  readonly config: AppConfig;
  /**
   * Retained for a future server-rendered surface that could carry a per-request
   * nonce. The current static build has no inline scripts, so the policy does
   * not reference it.
   */
  readonly nonce?: string;
  /** Report-only mode is used in staging to find breakage without breaking. */
  readonly reportOnly?: boolean;
}

/**
 * Build the Content-Security-Policy.
 *
 * Notes on the choices that usually get watered down:
 *
 *  - `script-src` is `'self'` plus two named third-party hosts. No
 *    'unsafe-inline', no 'unsafe-eval', and deliberately NO 'strict-dynamic'.
 *
 *    'strict-dynamic' would be stronger, but it makes the browser ignore host
 *    allowlists and trust only scripts loaded by a nonce'd or hashed script.
 *    Our index.html is a static file served from the asset layer, so it cannot
 *    carry a per-request nonce — with 'strict-dynamic' the app's own entry
 *    script would be blocked. `scripts/assert-no-inline-scripts.mjs` runs in CI
 *    to guarantee the build emits no inline script, which is what makes the
 *    plain 'self' policy safe.
 *
 *  - `style-src` DOES allow 'unsafe-inline'. This is a deliberate, documented
 *    exception: Tailwind is compiled to a static stylesheet, but the canvas
 *    layer and the Turnstile widget both set inline styles, and a style nonce
 *    cannot be threaded through third-party widget DOM. Inline style is a far
 *    weaker primitive than inline script; the residual risk is CSS-based data
 *    exfiltration, recorded in SECURITY.md.
 *  - `img-src` includes data: for the canvas-generated occupancy texture, and
 *    blob: for the client-side upload preview.
 *  - `frame-ancestors 'none'` — HQPixels is never embedded, which kills
 *    clickjacking outright.
 *  - `form-action` is limited to self plus Stripe Checkout.
 */
export function buildCsp(options: CspOptions): string {
  const { config } = options;
  const imageHost = config.images.deliveryBase !== '' ? config.images.deliveryBase : '';

  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'base-uri': ["'self'"],
    'script-src': ["'self'", STRIPE_SCRIPT, TURNSTILE],
    // See the note above: this exception is intentional and documented.
    'style-src': ["'self'", "'unsafe-inline'", FONTS_CSS],
    'style-src-elem': ["'self'", "'unsafe-inline'", FONTS_CSS],
    'font-src': ["'self'", FONTS_FILES, 'data:'],
    'img-src': ["'self'", 'data:', 'blob:', imageHost].filter((v) => v !== ''),
    'connect-src': [
      "'self'",
      ...STRIPE_CONNECT.split(' '),
      TURNSTILE,
      'https://upload.imagedelivery.net',
    ],
    'frame-src': [...STRIPE_FRAME.split(' '), TURNSTILE],
    'form-action': ["'self'", STRIPE_CHECKOUT],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'media-src': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };

  const parts = Object.entries(directives).map(([key, values]) => `${key} ${values.join(' ')}`);

  // Block mixed content and force HTTPS subresources once we are on a real
  // domain. Locally this would break http://localhost.
  if (config.isProduction || config.environment === 'staging') {
    parts.push('upgrade-insecure-requests');
  }

  return parts.join('; ');
}

export function newCspNonce(): string {
  return randomToken(16);
}

export interface SecurityHeaderOptions {
  readonly config: AppConfig;
  /** Unused by the current policy; see CspOptions.nonce. */
  readonly nonce?: string;
  /** True for API/JSON responses: a maximally restrictive CSP is used instead. */
  readonly isApi: boolean;
  /** True once the domain and certificate are confirmed working. */
  readonly enableHsts: boolean;
}

/**
 * The response headers applied to everything the Worker serves.
 *
 * `Server` and `X-Powered-By` are deliberately absent — we never set them, and
 * Cloudflare's own `Server: cloudflare` is not something we can or need to
 * remove. There is no framework-identifying header.
 */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    // Send the origin (not the path) cross-site, and nothing at all on a
    // downgrade. Keeps referrers useful for our own analytics without leaking
    // which placement a visitor was looking at to the destination site.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Deny every powerful feature. HQPixels needs none of them.
    'Permissions-Policy': [
      'accelerometer=()',
      'autoplay=()',
      'camera=()',
      'display-capture=()',
      'encrypted-media=()',
      'geolocation=()',
      'gyroscope=()',
      'idle-detection=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=(self "https://checkout.stripe.com")',
      'publickey-credentials-get=()',
      'screen-wake-lock=()',
      'serial=()',
      'usb=()',
      'xr-spatial-tracking=()',
    ].join(', '),
  };

  if (
    options.enableHsts &&
    (options.config.isProduction || options.config.environment === 'staging')
  ) {
    // 1 year, subdomains included. `preload` is deliberately omitted until the
    // operator has confirmed every subdomain is HTTPS — see DEPLOYMENT.md.
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  if (!options.isApi) {
    headers['Content-Security-Policy'] = buildCsp({ config: options.config });
  } else {
    // A JSON response should never be able to execute anything if a browser is
    // tricked into rendering it directly.
    headers['Content-Security-Policy'] =
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  }

  return headers;
}

// -----------------------------------------------------------------------------
// Origin validation
// -----------------------------------------------------------------------------

export type OriginCheck =
  | { readonly ok: true; readonly origin: string | null }
  | { readonly ok: false; readonly reason: 'missing' | 'mismatch' | 'malformed' };

/**
 * Same-origin enforcement for state-changing requests.
 *
 * This is the second half of CSRF defence (the first is the signed double-submit
 * token). Origin is preferred over Referer because it is sent on more request
 * types and carries no path.
 *
 * A MISSING Origin on a state-changing request is rejected. Browsers always send
 * it for CORS-relevant methods; the requests that legitimately lack it are
 * non-browser clients, which have no business calling our mutating endpoints.
 */
export function checkOrigin(request: Request, allowedOrigins: readonly string[]): OriginCheck {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');

  if (origin !== null) {
    if (allowedOrigins.includes(origin)) return { ok: true, origin };
    return { ok: false, reason: 'mismatch' };
  }

  // Fall back to Referer's origin. Some privacy tooling strips Origin on
  // same-origin POSTs, and rejecting those would break real buyers.
  if (referer !== null) {
    try {
      const refOrigin = new URL(referer).origin;
      if (allowedOrigins.includes(refOrigin)) return { ok: true, origin: refOrigin };
      return { ok: false, reason: 'mismatch' };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }

  return { ok: false, reason: 'missing' };
}

/** Origins that count as "us". Includes the www variant, which redirects. */
export function allowedOrigins(config: AppConfig): string[] {
  const origins = new Set<string>([config.siteOrigin]);

  try {
    const url = new URL(config.siteOrigin);
    if (url.hostname.startsWith('www.')) {
      origins.add(`${url.protocol}//${url.hostname.slice(4)}`);
    } else {
      origins.add(`${url.protocol}//www.${url.hostname}`);
    }
  } catch {
    // siteOrigin is validated in loadConfig; nothing to do.
  }

  if (!config.isProduction) {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }

  return [...origins];
}

/**
 * CORS. The answer is "same origin only".
 *
 * There is no cross-origin API consumer in the MVP, so we never emit
 * Access-Control-Allow-Origin for a foreign origin and never emit a wildcard
 * alongside credentials (which browsers reject anyway, but which people write).
 */
export function corsHeaders(request: Request, config: AppConfig): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (origin === null) return {};
  if (!allowedOrigins(config).includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Hq-Csrf',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
