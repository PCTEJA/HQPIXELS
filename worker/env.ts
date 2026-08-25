/**
 * Worker bindings and configuration.
 *
 * `Env` is the raw shape Cloudflare hands us. `AppConfig` is the validated,
 * narrowed shape the rest of the code uses — built once per request by
 * `loadConfig`, which fails closed if a required secret is missing rather than
 * discovering it halfway through a payment.
 */

import type {
  DurableObjectNamespace,
  Fetcher,
  KVNamespace,
} from '@cloudflare/workers-types/2023-07-01';

export interface Env {
  // --- Bindings ---------------------------------------------------------------
  /** Static assets (the built React app). Bound by the Cloudflare Vite plugin. */
  readonly ASSETS: Fetcher;
  /** Manifest, stats, rankings and the private redirect map. */
  readonly CACHE_KV: KVNamespace;
  /** Rate-limit counters. Separate namespace so a cache purge cannot reset limits. */
  readonly RATE_KV: KVNamespace;
  readonly RATE_LIMITER: DurableObjectNamespace;
  readonly ANALYTICS_BUFFER: DurableObjectNamespace;

  // --- Vars (public, from wrangler.jsonc) -------------------------------------
  readonly ENVIRONMENT?: string;
  readonly PUBLIC_SITE_URL?: string;
  readonly REQUIRE_MANUAL_APPROVAL?: string;
  readonly ADMIN_SURFACE_DISABLED?: string;

  // --- Secrets (wrangler secret put / .dev.vars) ------------------------------
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_ANON_KEY?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
  readonly STRIPE_SECRET_KEY?: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly CF_IMAGES_ACCOUNT_ID?: string;
  readonly CF_IMAGES_API_TOKEN?: string;
  readonly CF_IMAGES_DELIVERY_BASE?: string;
  readonly CF_IMAGES_PUBLIC_VARIANT?: string;
  readonly CF_IMAGES_THUMB_VARIANT?: string;
  readonly APP_SIGNING_SECRET?: string;
  readonly ADMIN_EMAIL_ALLOWLIST?: string;
  readonly SENTRY_DSN?: string;
}

export type Environment = 'development' | 'staging' | 'production';

export interface AppConfig {
  readonly environment: Environment;
  readonly isProduction: boolean;
  /** Canonical origin, no trailing slash. All redirects are built from this. */
  readonly siteUrl: string;
  readonly siteOrigin: string;
  readonly siteHost: string;

  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly supabaseServiceKey: string;

  readonly stripeSecretKey: string;
  readonly stripeWebhookSecret: string;

  readonly turnstileSecretKey: string;

  readonly images: {
    readonly accountId: string;
    readonly apiToken: string;
    readonly deliveryBase: string;
    readonly publicVariant: string;
    readonly thumbVariant: string;
    /** False when Images is not configured; uploads are then refused cleanly. */
    readonly configured: boolean;
  };

  readonly signingSecret: string;
  readonly adminEmailAllowlist: readonly string[];
  readonly requireManualApproval: boolean;
  readonly adminSurfaceDisabled: boolean;
  readonly sentryDsn: string | null;
}

export class ConfigError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Missing required configuration: ${missing.join(', ')}`);
    this.name = 'ConfigError';
  }
}

function requireVar(env: Env, key: keyof Env, missing: string[]): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    missing.push(key);
    return '';
  }
  return value.trim();
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
}

function normaliseEnvironment(value: string | undefined): Environment {
  switch (value) {
    case 'production':
    case 'staging':
      return value;
    default:
      return 'development';
  }
}

/**
 * Validate configuration once per request.
 *
 * Deliberately strict: a missing Stripe webhook secret or signing key must be a
 * hard startup-style failure, not a silently degraded security control. The
 * caller turns ConfigError into a 503 with a correlation id and logs which keys
 * are absent (names only — never values).
 */
export function loadConfig(env: Env): AppConfig {
  const missing: string[] = [];

  const environment = normaliseEnvironment(env.ENVIRONMENT);
  const rawSiteUrl = requireVar(env, 'PUBLIC_SITE_URL', missing);

  const supabaseUrl = requireVar(env, 'SUPABASE_URL', missing);
  const supabaseAnonKey = requireVar(env, 'SUPABASE_ANON_KEY', missing);
  const supabaseServiceKey = requireVar(env, 'SUPABASE_SERVICE_ROLE_KEY', missing);
  const stripeSecretKey = requireVar(env, 'STRIPE_SECRET_KEY', missing);
  const stripeWebhookSecret = requireVar(env, 'STRIPE_WEBHOOK_SECRET', missing);
  const turnstileSecretKey = requireVar(env, 'TURNSTILE_SECRET_KEY', missing);
  const signingSecret = requireVar(env, 'APP_SIGNING_SECRET', missing);

  if (missing.length > 0) throw new ConfigError(missing);

  // A short signing secret would make CSRF tokens forgeable. Refuse rather than
  // pretend to be protected.
  if (signingSecret.length < 32) {
    throw new ConfigError(['APP_SIGNING_SECRET (must be at least 32 characters)']);
  }

  let siteOrigin: string;
  let siteHost: string;
  try {
    const parsed = new URL(rawSiteUrl);
    if (environment === 'production' && parsed.protocol !== 'https:') {
      throw new ConfigError(['PUBLIC_SITE_URL (must be https in production)']);
    }
    siteOrigin = parsed.origin;
    siteHost = parsed.host;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(['PUBLIC_SITE_URL (must be an absolute URL)']);
  }

  const imagesAccountId = env.CF_IMAGES_ACCOUNT_ID?.trim() ?? '';
  const imagesApiToken = env.CF_IMAGES_API_TOKEN?.trim() ?? '';
  const imagesDeliveryBase = (env.CF_IMAGES_DELIVERY_BASE?.trim() ?? '').replace(/\/+$/, '');
  const imagesConfigured =
    imagesAccountId !== '' &&
    imagesApiToken !== '' &&
    imagesDeliveryBase !== '' &&
    !imagesAccountId.startsWith('REPLACE') &&
    !imagesApiToken.startsWith('REPLACE');

  // In production, an unconfigured image pipeline means nobody can complete a
  // purchase. Fail loudly at config time instead of at the upload step.
  if (environment === 'production' && !imagesConfigured) {
    throw new ConfigError(['CF_IMAGES_ACCOUNT_ID / CF_IMAGES_API_TOKEN / CF_IMAGES_DELIVERY_BASE']);
  }

  const adminEmailAllowlist = (env.ADMIN_EMAIL_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry.includes('@'));

  return {
    environment,
    isProduction: environment === 'production',
    siteUrl: siteOrigin,
    siteOrigin,
    siteHost,
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    supabaseAnonKey,
    supabaseServiceKey,
    stripeSecretKey,
    stripeWebhookSecret,
    turnstileSecretKey,
    images: {
      accountId: imagesAccountId,
      apiToken: imagesApiToken,
      deliveryBase: imagesDeliveryBase,
      publicVariant: env.CF_IMAGES_PUBLIC_VARIANT?.trim() || 'wall',
      thumbVariant: env.CF_IMAGES_THUMB_VARIANT?.trim() || 'thumb',
      configured: imagesConfigured,
    },
    signingSecret,
    adminEmailAllowlist,
    requireManualApproval: parseBool(env.REQUIRE_MANUAL_APPROVAL, true),
    adminSurfaceDisabled: parseBool(env.ADMIN_SURFACE_DISABLED, false),
    sentryDsn: env.SENTRY_DSN?.trim() || null,
  };
}
