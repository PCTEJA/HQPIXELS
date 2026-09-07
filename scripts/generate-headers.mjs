/**
 * Generates `public/_headers`, the header rules Cloudflare's asset layer applies
 * to statically served files.
 *
 * WHY THIS EXISTS
 *   The HTML document is served directly by Cloudflare's asset layer so that a
 *   page view costs no Worker invocation and can be edge-cached. That means the
 *   Worker's response middleware never runs for it, so the document's security
 *   headers have to be declared here instead.
 *
 * WHY IT IS GENERATED RATHER THAN HAND-WRITTEN
 *   Two copies of a CSP drift, and a drifted CSP is either broken or insecure.
 *   `tests/unit/security-headers.test.ts` asserts that the policy emitted here is
 *   byte-identical to what `worker/lib/http-security.ts` produces, so CI fails if
 *   they diverge.
 *
 * Usage:  node scripts/generate-headers.mjs [--check]
 *   --check  exits non-zero if the file on disk is out of date (used in CI)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(repoRoot, 'public', '_headers');

// ---------------------------------------------------------------------------
// Policy source of truth for STATIC responses.
//
// Kept in sync with worker/lib/http-security.ts by a unit test. If you change
// one, change both and let the test confirm it.
// ---------------------------------------------------------------------------

const STRIPE_SCRIPT = 'https://js.stripe.com';
const STRIPE_FRAME = 'https://js.stripe.com https://hooks.stripe.com';
const STRIPE_CONNECT = 'https://api.stripe.com https://maps.googleapis.com';
const STRIPE_CHECKOUT = 'https://checkout.stripe.com';
const TURNSTILE = 'https://challenges.cloudflare.com';
const FONTS_CSS = 'https://fonts.googleapis.com';
const FONTS_FILES = 'https://fonts.gstatic.com';

/**
 * The image delivery host. Read from the environment at build time so a
 * different Cloudflare Images account does not require editing this file.
 * Falls back to the generic imagedelivery.net host, which is correct for every
 * Cloudflare Images account.
 */
const IMAGE_HOST = process.env.VITE_IMAGE_DELIVERY_BASE ?? 'https://imagedelivery.net';

/** Set VITE_ENVIRONMENT=production to include upgrade-insecure-requests + HSTS. */
const ENVIRONMENT = process.env.VITE_ENVIRONMENT ?? 'development';
const isDeployed = ENVIRONMENT === 'production' || ENVIRONMENT === 'staging';

export function buildStaticCsp({ imageHost = IMAGE_HOST, deployed = isDeployed } = {}) {
  const directives = {
    'default-src': ["'none'"],
    'base-uri': ["'self'"],
    'script-src': ["'self'", STRIPE_SCRIPT, TURNSTILE],
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
  if (deployed) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

const PERMISSIONS_POLICY = [
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
].join(', ');

function render() {
  const lines = [
    '# GENERATED FILE - do not edit by hand.',
    '# Produced by scripts/generate-headers.mjs; run `pnpm run headers` to refresh.',
    '# Cloudflare applies these to statically served assets, which the Worker never sees.',
    '',
    '/*',
    `  Content-Security-Policy: ${buildStaticCsp()}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Frame-Options: DENY',
    '  Cross-Origin-Opener-Policy: same-origin',
    `  Permissions-Policy: ${PERMISSIONS_POLICY}`,
  ];

  if (isDeployed) {
    // Only on a real domain with a working certificate. Enabling HSTS against a
    // hostname you cannot serve over HTTPS locks users out.
    lines.push('  Strict-Transport-Security: max-age=31536000; includeSubDomains');
  }

  lines.push(
    '',
    '# Content-hashed bundles never change under the same name.',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '# The SPA shell must be revalidated so a deploy takes effect immediately,',
    '# but may be held briefly at the edge to absorb a traffic spike.',
    '/',
    '  Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    '',
    '/index.html',
    '  Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    '',
    '# Dashboards and admin must never be indexed or cached by a shared cache.',
    '/dashboard/*',
    '  X-Robots-Tag: noindex, nofollow',
    '  Cache-Control: no-store',
    '',
    '/admin/*',
    '  X-Robots-Tag: noindex, nofollow, noarchive',
    '  Cache-Control: no-store',
    '',
  );

  return lines.join('\n');
}

const rendered = render();

if (process.argv.includes('--check')) {
  if (!existsSync(outputPath)) {
    console.error('public/_headers is missing. Run: pnpm run headers');
    process.exit(1);
  }
  const current = readFileSync(outputPath, 'utf8');
  if (current !== rendered) {
    console.error('public/_headers is out of date. Run: pnpm run headers');
    process.exit(1);
  }
  console.log('public/_headers is up to date.');
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered, 'utf8');
  console.log(`Wrote ${outputPath}`);
}
