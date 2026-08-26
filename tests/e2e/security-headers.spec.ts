/**
 * Security header verification.
 *
 * These tests verify that the Worker applies all expected security headers to
 * responses. This catches regressions in the hardening configuration.
 */
import { test, expect } from '@playwright/test';

test.describe('Security Headers', () => {
  test('landing page has Content-Security-Policy', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    const csp = response?.headers()['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No unsafe-eval
    expect(csp).not.toContain('unsafe-eval');
  });

  test('has X-Content-Type-Options: nosniff', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('has X-Frame-Options: DENY', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.headers()['x-frame-options']).toBe('DENY');
  });

  test('has strict Referrer-Policy', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('has Cross-Origin-Opener-Policy: same-origin', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  });

  test('has Cross-Origin-Resource-Policy: same-origin', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.headers()['cross-origin-resource-policy']).toBe('same-origin');
  });

  test('has restrictive Permissions-Policy', async ({ page }) => {
    const response = await page.goto('/');
    const permissions = response?.headers()['permissions-policy'];
    expect(permissions).toBeDefined();
    expect(permissions).toContain('camera=()');
    expect(permissions).toContain('microphone=()');
    expect(permissions).toContain('geolocation=()');
  });

  test('API response has restrictive CSP', async ({ page }) => {
    // API endpoints return JSON with a maximally restrictive CSP
    const response = await page.request.get('/api/wall/manifest');
    const csp = response.headers()['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test('CSP allows Stripe.js', async ({ page }) => {
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'];
    expect(csp).toContain('https://js.stripe.com');
  });

  test('CSP allows Turnstile', async ({ page }) => {
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'];
    expect(csp).toContain('https://challenges.cloudflare.com');
  });

  test('style-src allows unsafe-inline for Tailwind/Turnstile', async ({ page }) => {
    // This is a documented exception - inline styles are needed for canvas
    // and Turnstile widget, but inline scripts are still blocked
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'];
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    // Ensure script-src does NOT have unsafe-inline
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});

test.describe('HSTS (production/staging)', () => {
  // HSTS is only enabled in production/staging environments
  // In dev mode, this header may not be present
  test('HSTS header format when present', async ({ page }) => {
    const response = await page.goto('/');
    const hsts = response?.headers()['strict-transport-security'];
    if (hsts) {
      expect(hsts).toContain('max-age=');
      expect(hsts).toContain('includeSubDomains');
      // preload is deliberately omitted until all subdomains confirmed HTTPS
      // This is documented in DEPLOYMENT.md
    }
  });
});
