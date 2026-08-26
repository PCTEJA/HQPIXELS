/**
 * Axe-core accessibility audit.
 *
 * Runs automated accessibility scans on all public pages. WCAG 2.1 AA is the
 * target standard. Violations must be zero or explicitly documented as false
 * positives in SECURITY.md.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Public pages to audit. Authenticated pages (dashboard, admin) require
 * mock auth which is handled in separate auth-specific tests.
 */
const PUBLIC_PAGES = [
  { path: '/', name: 'Landing' },
  { path: '/wall', name: 'Wall' },
  { path: '/pricing', name: 'Pricing' },
  { path: '/faq', name: 'FAQ' },
  { path: '/contact', name: 'Contact' },
  { path: '/rankings', name: 'Rankings' },
  { path: '/stats', name: 'Stats' },
  { path: '/legal/terms', name: 'Terms of Service' },
  { path: '/legal/privacy', name: 'Privacy Policy' },
  { path: '/legal/cookies', name: 'Cookie Policy' },
  { path: '/legal/acceptable-use', name: 'Acceptable Use' },
];

test.describe('Accessibility Audit (WCAG 2.1 AA) @a11y', () => {
  for (const { path, name } of PUBLIC_PAGES) {
    test(`${name} page (${path}) passes axe-core`, async ({ page }) => {
      await page.goto(path);

      // Wait for page to be fully loaded
      await page.waitForLoadState('networkidle');

      // Allow time for any async content to render
      await page.waitForTimeout(500);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        // Exclude third-party widgets that we cannot control
        .exclude('.turnstile-widget')
        .exclude('iframe[src*="turnstile"]')
        .exclude('iframe[src*="stripe"]')
        .analyze();

      // Log violations for debugging
      if (results.violations.length > 0) {
        console.log(`Accessibility violations on ${path}:`);
        for (const violation of results.violations) {
          console.log(`  - ${violation.id}: ${violation.help}`);
          for (const node of violation.nodes) {
            console.log(`    Target: ${node.target.join(' > ')}`);
          }
        }
      }

      expect(results.violations).toEqual([]);
    });
  }

  test('404 page passes axe-core', async ({ page }) => {
    await page.goto('/this-page-does-not-exist');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('Color Contrast @a11y', () => {
  test('landing page meets contrast requirements', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2aa'])
      // Focus specifically on contrast issues
      .options({ runOnly: ['color-contrast'] })
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('form inputs have sufficient contrast', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .options({ runOnly: ['color-contrast'] })
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('Form Accessibility @a11y', () => {
  test('contact form has proper labels', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .options({ runOnly: ['label', 'label-title-only'] })
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('form error messages are accessible', async ({ page }) => {
    await page.goto('/contact');

    // Try to submit empty form to trigger validation
    const submitButton = page.getByRole('button', { name: /submit|send/i });
    if ((await submitButton.count()) > 0) {
      await submitButton.click();

      // Wait for potential validation messages
      await page.waitForTimeout(500);

      const results = await new AxeBuilder({ page })
        .options({ runOnly: ['aria-valid-attr', 'aria-valid-attr-value'] })
        .analyze();

      expect(results.violations).toEqual([]);
    }
  });
});

test.describe('Image Accessibility @a11y', () => {
  test('images have alt text', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page }).options({ runOnly: ['image-alt'] }).analyze();

    expect(results.violations).toEqual([]);
  });

  test('decorative images are properly marked', async ({ page }) => {
    await page.goto('/');

    // Check that decorative images have empty alt or role="presentation"
    const images = page.locator('img');
    const imageCount = await images.count();

    for (let i = 0; i < imageCount; i++) {
      const img = images.nth(i);
      const alt = await img.getAttribute('alt');
      const role = await img.getAttribute('role');
      const ariaHidden = await img.getAttribute('aria-hidden');

      // Each image should have alt text, or be marked as decorative
      const isAccessible =
        alt !== null || role === 'presentation' || role === 'none' || ariaHidden === 'true';

      expect(isAccessible).toBe(true);
    }
  });
});

test.describe('Landmark Structure @a11y', () => {
  test('page has proper landmark structure', async ({ page }) => {
    await page.goto('/');

    // Should have main landmark
    const main = page.locator('main');
    expect(await main.count()).toBeGreaterThan(0);

    // Should have navigation
    const nav = page.locator('nav, [role="navigation"]');
    expect(await nav.count()).toBeGreaterThan(0);
  });

  test('landmarks are not nested incorrectly', async ({ page }) => {
    await page.goto('/');

    const results = await new AxeBuilder({ page })
      .options({ runOnly: ['landmark-one-main', 'landmark-no-duplicate-main'] })
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('ARIA Usage @a11y', () => {
  test('ARIA attributes are valid', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .options({
        runOnly: [
          'aria-allowed-attr',
          'aria-required-attr',
          'aria-valid-attr',
          'aria-valid-attr-value',
          'aria-roles',
        ],
      })
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('interactive elements have proper roles', async ({ page }) => {
    await page.goto('/');

    const results = await new AxeBuilder({ page })
      .options({ runOnly: ['button-name', 'link-name'] })
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
