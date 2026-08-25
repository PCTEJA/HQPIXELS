/// <reference types="vite/client" />

/**
 * Client-visible environment variables.
 *
 * Everything here is compiled into the browser bundle and is therefore PUBLIC.
 * A secret must never be added to this interface — the Worker holds secrets and
 * the browser never sees them.
 */
interface ImportMetaEnv {
  /** Canonical site origin, no trailing slash. */
  readonly VITE_SITE_URL: string;
  /** Turnstile site key. Public by design. */
  readonly VITE_TURNSTILE_SITE_KEY: string;
  /** Sentry browser DSN, or empty to disable client error reporting. */
  readonly VITE_SENTRY_DSN: string;
  readonly VITE_ENVIRONMENT: 'development' | 'staging' | 'production';
  /** Image delivery base, used only to build the static CSP. */
  readonly VITE_IMAGE_DELIVERY_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
