/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-misused-promises */
/**
 * Test helpers and fake dependencies for integration tests.
 *
 * These fakes let us drive the real Worker routes with `app.request()` while
 * controlling Supabase, Stripe, Turnstile, and KV responses. No network
 * calls happen in these tests.
 */

import type { KVNamespace } from '@cloudflare/workers-types/2023-07-01';
import type Stripe from 'stripe';
import type { AppConfig } from '../../worker/env';
import type { Deps, TurnstileVerifier } from '../../worker/context';
import type { Db } from '../../worker/lib/supabase';
import type { RateLimiter } from '../../worker/lib/rate-limit';
import type { ImageClient } from '../../worker/lib/images';
import type { AnalyticsClient } from '../../worker/lib/analytics';
import type { TurnstileResult } from '../../worker/lib/turnstile';
import { createApp, type CreateAppOptions } from '../../worker/app';

// -----------------------------------------------------------------------------
// Fake Config
// -----------------------------------------------------------------------------

export function fakeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    environment: 'development',
    isProduction: false,
    siteUrl: 'http://localhost:3000',
    siteOrigin: 'http://localhost:3000',
    siteHost: 'localhost',
    supabaseUrl: 'http://localhost:54321',
    supabaseAnonKey: 'test-anon-key',
    supabaseServiceKey: 'test-service-key',
    stripeSecretKey: 'sk_test_fake',
    stripeWebhookSecret: 'whsec_test_fake_webhook_secret',
    turnstileSecretKey: '1x0000000000000000000000000000000AA', // Always-pass test key
    images: {
      accountId: 'test-account',
      apiToken: 'test-token',
      deliveryBase: 'https://imagedelivery.net',
      publicVariant: 'public',
      thumbVariant: 'thumb',
      configured: true,
    },
    signingSecret: 'test-signing-secret-at-least-32-chars-long!',
    adminEmailAllowlist: ['admin@test.com'],
    requireManualApproval: true,
    adminSurfaceDisabled: false,
    sentryDsn: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Fake Database (Supabase RPC surface)
// -----------------------------------------------------------------------------

export interface FakeDbOptions {
  reservations?: Map<string, unknown>;
  profiles?: Map<string, unknown>;
  stripeEvents?: Set<string>;
}

export function fakeDb(options: FakeDbOptions = {}): Db {
  const _reservations = options.reservations ?? new Map();
  const _profiles = options.profiles ?? new Map();
  const stripeEvents = options.stripeEvents ?? new Set();

  return {
    async rpc(name: string, params?: Record<string, unknown>) {
      // Return appropriate responses based on RPC name
      switch (name) {
        case 'create_reservation':
          return { data: { id: 'res_test_123' }, error: null };
        case 'quote_total_cents':
          return { data: 1000, error: null };
        case 'reservation_status':
          return { data: null, error: null };
        case 'record_stripe_event':
          if (params?.event_id && stripeEvents.has(params.event_id as string)) {
            return { data: false, error: null }; // Duplicate
          }
          if (params?.event_id) stripeEvents.add(params.event_id as string);
          return { data: true, error: null };
        default:
          return { data: null, error: null };
      }
    },
    async from(_table: string) {
      return {
        select: () => ({
          eq: () => ({
            single: () => ({ data: null, error: null }),
            limit: () => ({ data: [], error: null }),
          }),
          order: () => ({
            limit: () => ({ data: [], error: null }),
          }),
        }),
        insert: () => ({ data: null, error: null }),
        update: () => ({
          eq: () => ({ data: null, error: null }),
        }),
      };
    },
  } as unknown as Db;
}

// -----------------------------------------------------------------------------
// Fake Rate Limiter
// -----------------------------------------------------------------------------

export interface FakeRateLimiterOptions {
  allowAll?: boolean;
  blockedPolicies?: Set<string>;
}

export function fakeRateLimiter(options: FakeRateLimiterOptions = {}): RateLimiter {
  const { allowAll = true, blockedPolicies = new Set() } = options;

  return {
    async consume(policy: string, _key: string) {
      if (!allowAll || blockedPolicies.has(policy)) {
        return { allowed: false, limit: 10, remaining: 0, retryAfter: 60 };
      }
      return { allowed: true, limit: 10, remaining: 9, retryAfter: 0 };
    },
  };
}

// -----------------------------------------------------------------------------
// Fake Turnstile Verifier
// -----------------------------------------------------------------------------

export function fakeTurnstile(
  result: TurnstileResult = {
    ok: true,
    hostname: 'localhost',
    challengeTs: new Date().toISOString(),
  },
): TurnstileVerifier {
  return async () => result;
}

// -----------------------------------------------------------------------------
// Fake KV
// -----------------------------------------------------------------------------

export function fakeKv(): KVNamespace {
  const store = new Map<string, string>();

  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cacheStatus: null };
    },
    async getWithMetadata() {
      return { value: null, metadata: null, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

// -----------------------------------------------------------------------------
// Fake Stripe
// -----------------------------------------------------------------------------

export function fakeStripe(): () => Stripe {
  return () =>
    ({
      checkout: {
        sessions: {
          create: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' }),
          retrieve: async () => ({ id: 'cs_test_123', payment_status: 'paid' }),
        },
      },
      webhooks: {
        constructEvent: () => ({ type: 'checkout.session.completed', id: 'evt_test_123' }),
      },
    }) as unknown as Stripe;
}

// -----------------------------------------------------------------------------
// Fake Images
// -----------------------------------------------------------------------------

export function fakeImages(): ImageClient {
  return {
    async requestUploadUrl() {
      return { ok: true, uploadUrl: 'https://upload.imagedelivery.net/test', imageId: 'img_test' };
    },
    async getImageInfo() {
      return { ok: true, width: 100, height: 100 };
    },
  } as unknown as ImageClient;
}

// -----------------------------------------------------------------------------
// Fake Analytics
// -----------------------------------------------------------------------------

export function fakeAnalytics(): AnalyticsClient {
  return {
    recordView: () => {},
    recordClick: () => {},
    recordImpressions: () => {},
    flushAll: async () => {},
    backlog: async () => 0,
  };
}

// -----------------------------------------------------------------------------
// Fake Auth Client
// -----------------------------------------------------------------------------

export function fakeAuthClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  };
}

// -----------------------------------------------------------------------------
// Assemble Deps
// -----------------------------------------------------------------------------

export interface FakeDepsOptions {
  config?: Partial<AppConfig>;
  db?: FakeDbOptions;
  rateLimiter?: FakeRateLimiterOptions;
  turnstileResult?: TurnstileResult;
  now?: number;
}

export function fakeDeps(options: FakeDepsOptions = {}): Deps {
  const config = fakeConfig(options.config);

  return {
    config,
    db: fakeDb(options.db),
    rateLimiter: fakeRateLimiter(options.rateLimiter),
    images: fakeImages(),
    stripe: fakeStripe(),
    verifyTurnstile: fakeTurnstile(options.turnstileResult),
    cacheKv: fakeKv(),
    analytics: fakeAnalytics(),
    now: () => options.now ?? Date.now(),
    authClientFor: () => fakeAuthClient() as unknown as ReturnType<Deps['authClientFor']>,
  };
}

// -----------------------------------------------------------------------------
// Create Test App
// -----------------------------------------------------------------------------

export interface TestAppOptions {
  deps?: FakeDepsOptions;
  enableHsts?: boolean;
}

export function createTestApp(options: TestAppOptions = {}) {
  const deps = fakeDeps(options.deps);
  const waitUntil = () => {};

  const appOptions: CreateAppOptions = {
    deps,
    waitUntil,
    enableHsts: options.enableHsts ?? false,
  };

  return createApp(appOptions);
}

// -----------------------------------------------------------------------------
// Test Request Helpers
// -----------------------------------------------------------------------------

export interface TestRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  csrfToken?: string;
  origin?: string;
}

export function buildRequest(url: string, options: TestRequestOptions = {}): Request {
  const { method = 'GET', body, headers = {}, csrfToken, origin } = options;

  const init: RequestInit = {
    method,
    headers: {
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  if (origin) {
    (init.headers as Record<string, string>)['Origin'] = origin;
  }

  if (csrfToken) {
    (init.headers as Record<string, string>)['X-CSRF-Token'] = csrfToken;
  }

  return new Request(url, init);
}
