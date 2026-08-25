import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit + integration tests run in plain Node.
 *
 * The Worker is written as `createApp(deps)` returning a Hono app, so route
 * tests drive it with `app.request(...)` and inject fake Supabase/Stripe/KV
 * implementations. That gives real request/response coverage (headers, CSRF,
 * status codes, idempotency) without needing workerd in CI.
 *
 * Anything that genuinely needs the browser — canvas rendering, keyboard flow,
 * accessibility, CSP — is covered by Playwright in tests/e2e.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['shared/**/*.ts', 'worker/**/*.ts'],
      exclude: ['worker/worker-env.d.ts', '**/*.d.ts'],
      thresholds: {
        // Deliberately focused on the money/auth/validation paths rather than
        // a vanity global number.
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
  },
});
