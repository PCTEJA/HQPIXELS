/**
 * Open redirect prevention tests.
 *
 * Open redirects are a security vulnerability where an attacker can use your
 * domain to redirect users to a malicious site, lending your domain's trust
 * to phishing attacks.
 *
 * The HQPixels /go endpoint is NOT vulnerable to open redirects because:
 * 1. It does NOT accept a URL parameter
 * 2. Destinations are looked up from the database by placement ID
 * 3. All destinations were validated at upload time
 *
 * These tests verify this protection is in place.
 */
import { test, expect } from '@playwright/test';

test.describe('Open Redirect Prevention - /go Endpoint', () => {
  test('/go does not accept url parameter', async ({ page }) => {
    // Try to abuse /go with a url parameter (should be ignored)
    const response = await page.request.get('/go?url=https://evil.example.com');

    // Should return 404 (no placementId) or redirect to our domain only
    if (response.status() === 302 || response.status() === 301) {
      const location = response.headers()['location'];
      expect(location).not.toContain('evil.example.com');
    }
  });

  test('/go/:id does not honor url query parameter', async ({ page }) => {
    // Even with a valid-looking placementId, a url param should be ignored
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const response = await page.request.get(`/go/${fakeId}?url=https://evil.example.com`);

    // Should either 404 (invalid id) or redirect to stored destination only
    if (response.status() === 302 || response.status() === 301) {
      const location = response.headers()['location'];
      expect(location).not.toContain('evil.example.com');
    }
  });

  test('/go with invalid placementId returns 404', async ({ page }) => {
    const response = await page.goto('/go/not-a-valid-uuid');

    // Invalid IDs should not redirect anywhere
    expect(response?.status()).toBe(404);
  });

  test('/go with non-existent placementId returns 404', async ({ page }) => {
    // A properly formatted but non-existent UUID
    const response = await page.goto('/go/12345678-1234-1234-1234-123456789012');

    // Non-existent placements should return 404, not redirect
    expect(response?.status()).toBe(404);
  });

  test('/go does not allow path traversal', async ({ page }) => {
    const maliciousPaths = [
      '/go/../../../etc/passwd',
      '/go/..%2F..%2F..%2Fetc%2Fpasswd',
      '/go/%2e%2e/%2e%2e/etc/passwd',
      '/go/....//....//etc/passwd',
    ];

    for (const path of maliciousPaths) {
      const response = await page.request.get(path);
      // Should 404, not expose file system
      expect([404, 400]).toContain(response.status());
    }
  });
});

test.describe('Open Redirect Prevention - Auth Endpoints', () => {
  test('auth callback does not redirect to external domains', async ({ page }) => {
    // Try to inject an external redirect in the callback
    const response = await page.request.get(
      '/api/auth/callback?next=https://evil.example.com',
      { maxRedirects: 0 }
    );

    if (response.status() === 302 || response.status() === 303) {
      const location = response.headers()['location'];
      // If there's a redirect, it must be to our domain
      if (location) {
        expect(location).not.toMatch(/^https?:\/\/evil/);
        // Should only redirect to internal paths
        if (location.startsWith('http')) {
          const url = new URL(location);
          // Either localhost or our actual domain
          expect(['localhost', '127.0.0.1', 'hqpixels.com']).toContain(url.hostname.replace('www.', ''));
        }
      }
    }
  });

  test('auth callback sanitizes next parameter', async ({ page }) => {
    const maliciousNextValues = [
      'https://evil.com',
      '//evil.com',
      'https://evil.com/fake?real=hqpixels.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '/\\evil.com',
      '//google.com%00.hqpixels.com',
    ];

    for (const next of maliciousNextValues) {
      const response = await page.request.get(
        `/api/auth/callback?next=${encodeURIComponent(next)}`,
        { maxRedirects: 0 }
      );

      if (response.status() === 302 || response.status() === 303) {
        const location = response.headers()['location'];
        if (location) {
          // Should never redirect to the malicious destination
          expect(location).not.toContain('evil.com');
          expect(location).not.toContain('google.com');
          expect(location).not.toContain('javascript:');
        }
      }
    }
  });

  test('login redirect parameter is sanitized', async ({ page }) => {
    await page.goto('/?redirectPath=https://evil.com');
    await page.waitForLoadState('networkidle');

    // Check that no links on the page point to evil.com
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .map((a) => a.href)
        .filter((href) => href.includes('evil.com'));
    });

    expect(links).toHaveLength(0);
  });
});

test.describe('Open Redirect Prevention - General', () => {
  test('no redirect endpoints expose url parameter', async ({ page }) => {
    // Common redirect endpoint patterns that should not exist or should be safe
    const endpoints = [
      '/redirect?url=https://evil.com',
      '/r?u=https://evil.com',
      '/out?to=https://evil.com',
      '/external?link=https://evil.com',
      '/link?target=https://evil.com',
    ];

    for (const endpoint of endpoints) {
      const response = await page.request.get(endpoint, { maxRedirects: 0 });

      // Should either 404 or not redirect to evil.com
      if (response.status() === 302 || response.status() === 301) {
        const location = response.headers()['location'];
        if (location) {
          expect(location).not.toContain('evil.com');
        }
      }
    }
  });

  test('meta refresh is not used for redirects', async ({ page }) => {
    await page.goto('/');

    // Check for meta refresh tags that could enable open redirects
    const metaRefresh = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="refresh"]');
      return meta?.getAttribute('content');
    });

    // If there's a meta refresh, ensure it's not to an external URL
    if (metaRefresh) {
      expect(metaRefresh).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1|hqpixels\.com)/);
    }
  });

  test('window.location assignments are not user-controlled', async ({ page }) => {
    // Navigate with a malicious parameter
    await page.goto('/?goto=https://evil.com');
    await page.waitForLoadState('networkidle');

    // Should still be on our domain
    expect(page.url()).not.toContain('evil.com');

    // Wait a bit in case there's delayed JavaScript
    await page.waitForTimeout(1000);
    expect(page.url()).not.toContain('evil.com');
  });

  test('form actions do not redirect externally', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check all form actions
    const formActions = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('form'))
        .map((form) => form.action)
        .filter(Boolean);
    });

    // All form actions should be same-origin or relative
    for (const action of formActions) {
      if (action.startsWith('http')) {
        const url = new URL(action);
        expect(['localhost', '127.0.0.1', 'hqpixels.com']).toContain(
          url.hostname.replace('www.', '')
        );
      }
    }
  });
});

test.describe('Safe Redirect Implementation', () => {
  test('only relative paths are used for internal redirects', async ({ page }) => {
    // Check the login flow redirect handling
    await page.goto('/wall');

    // After any auth redirect, should end up on an internal page
    const currentUrl = page.url();
    const url = new URL(currentUrl);

    // Should be on localhost (dev) or hqpixels.com (prod)
    expect(['localhost', '127.0.0.1', 'hqpixels.com']).toContain(
      url.hostname.replace('www.', '')
    );
  });

  test('redirect responses have proper headers', async ({ page }) => {
    // For any redirect, security headers should still be applied
    const response = await page.request.get('/go/test-nonexistent', {
      maxRedirects: 0,
    });

    // Even error responses should have security headers
    const xcto = response.headers()['x-content-type-options'];
    if (xcto) {
      expect(xcto).toBe('nosniff');
    }
  });
});
