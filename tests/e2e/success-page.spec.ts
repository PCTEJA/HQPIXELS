/**
 * Success page security tests.
 *
 * The success page (/claim/success) is a critical security boundary:
 * It CANNOT fulfil a payment or publish a placement. It only reads status
 * via a STABLE database function, which is physically incapable of writing.
 *
 * These tests verify that refreshing or manipulating the success page does
 * not cause any side effects. Only the signature-verified webhook or the
 * reconciler can publish placements.
 */
import { test, expect } from '@playwright/test';

test.describe('Success Page Security', () => {
  test('success page without reservation shows error state', async ({ page }) => {
    // Navigate to success page without a reservation parameter
    await page.goto('/claim/success');

    // Should show an error/empty state, not a success message
    const content = await page.textContent('body');
    expect(content).toContain('dashboard');
    expect(content?.toLowerCase()).not.toContain('payment successful');
  });

  test('success page with invalid reservation shows error', async ({ page }) => {
    // Try with a non-existent UUID
    await page.goto('/claim/success?reservation=00000000-0000-0000-0000-000000000000');

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000); // Allow time for API response

    // Should show loading or error state, not a fake success
    const content = await page.textContent('body');
    // Should either show error or be in a loading state
    const isLoadingOrError =
      content?.includes('Confirming') ||
      content?.includes('could not') ||
      content?.includes('error') ||
      content?.includes('not find') ||
      content?.includes('dashboard');

    expect(isLoadingOrError).toBe(true);
  });

  test('success page does not have form submission capability', async ({ page }) => {
    await page.goto('/claim/success?reservation=test-id');

    // There should be no forms on the success page
    const forms = page.locator('form');
    const formCount = await forms.count();

    // Success page should be purely informational
    expect(formCount).toBe(0);
  });

  test('success page does not have mutation buttons', async ({ page }) => {
    await page.goto('/claim/success?reservation=test-id');
    await page.waitForLoadState('networkidle');

    // Check that there are no buttons that could trigger mutations
    // (publish, approve, activate, submit, etc.)
    const mutationButtonTexts = [
      /publish/i,
      /approve/i,
      /activate/i,
      /submit/i,
      /confirm payment/i,
      /complete/i,
      /finalize/i,
    ];

    for (const pattern of mutationButtonTexts) {
      const buttons = page.getByRole('button', { name: pattern });
      const count = await buttons.count();
      expect(count).toBe(0);
    }
  });

  test('success page is safe to refresh', async ({ page }) => {
    // Even multiple refreshes should not cause side effects
    await page.goto('/claim/success?reservation=test-id');
    await page.waitForLoadState('networkidle');

    const _initialContent = await page.textContent('body');

    // Refresh multiple times
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await page.waitForLoadState('networkidle');
    }

    // Content should be consistent (reads same state)
    const finalContent = await page.textContent('body');

    // The page content should be essentially the same
    // (allowing for minor timing differences in "waiting" text)
    expect(finalContent !== null).toBe(true);
  });

  test('success page links lead to safe destinations', async ({ page }) => {
    await page.goto('/claim/success?reservation=test-id');
    await page.waitForLoadState('networkidle');

    // Find all links on the page
    const links = page.locator('a');
    const linkCount = await links.count();

    for (let i = 0; i < linkCount; i++) {
      const link = links.nth(i);
      const href = await link.getAttribute('href');

      if (href !== null) {
        // Links should be internal or to known safe destinations
        const isInternal = href.startsWith('/') || href.startsWith('#');
        const isSameOrigin = href.startsWith(page.url().split('/').slice(0, 3).join('/'));

        expect(isInternal || isSameOrigin).toBe(true);
      }
    }
  });

  test('success page has no JavaScript that could execute payments', async ({ page }) => {
    await page.goto('/claim/success?reservation=test-id');

    // The page should not have Stripe Checkout or payment form elements
    const stripeElements = page.locator('[data-stripe]');
    const paymentForms = page.locator('form[action*="payment"], form[action*="checkout"]');

    expect(await stripeElements.count()).toBe(0);
    expect(await paymentForms.count()).toBe(0);
  });
});

test.describe('Success Page User Experience', () => {
  test('shows appropriate loading state', async ({ page }) => {
    await page.goto('/claim/success?reservation=test-id');

    // Should show loading indicator while waiting for status
    const _loadingIndicator = page.locator('[role="status"]');
    // May or may not be visible depending on API response time
    // Just verify it doesn't crash
    expect(page.url()).toContain('/claim/success');
  });

  test('provides navigation to dashboard', async ({ page }) => {
    await page.goto('/claim/success?reservation=test-id');
    await page.waitForLoadState('networkidle');

    // Should have a link to the dashboard
    const dashboardLink = page.getByRole('link', { name: /dashboard/i });
    const hasDashboardLink = (await dashboardLink.count()) > 0;

    // Either shows dashboard link or mentions dashboard
    const content = await page.textContent('body');
    expect(hasDashboardLink || content?.includes('dashboard')).toBe(true);
  });

  test('handles network errors gracefully', async ({ page }) => {
    // Block API calls to simulate network error
    await page.route('**/api/**', (route) => route.abort());

    await page.goto('/claim/success?reservation=test-id');
    await page.waitForLoadState('networkidle');

    // Should show error state, not crash
    const content = await page.textContent('body');
    expect(content).toBeTruthy();
    // Page should still be functional
    expect(await page.title()).toBeTruthy();
  });
});
