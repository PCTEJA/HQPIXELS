/**
 * Reduced motion preference tests.
 *
 * Users who set prefers-reduced-motion should not see animations that could
 * cause vestibular issues. The app should respect this preference and disable
 * or reduce animations accordingly.
 *
 * These tests run in the 'reduced-motion' project defined in playwright.config.ts
 * which sets contextOptions.reducedMotion to 'reduce'.
 */
import { test, expect } from '@playwright/test';

test.describe('Reduced Motion Preference @a11y', () => {
  test('CSS respects prefers-reduced-motion', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that reduced motion styles are applied
    const styles = await page.evaluate(() => {
      const computed = window.getComputedStyle(document.documentElement);
      return {
        scrollBehavior: computed.scrollBehavior,
      };
    });

    // With reduced motion, scroll behavior should be 'auto' not 'smooth'
    expect(styles.scrollBehavior).toBe('auto');

    await context.close();
  });

  test('animations have near-zero duration', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that animated elements have minimal duration
    const animationDurations = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*'));
      const durations: number[] = [];

      const parseDuration = (str: string): number => {
        if (str.endsWith('ms')) return parseFloat(str);
        if (str.endsWith('s')) return parseFloat(str) * 1000;
        return 0;
      };

      for (const el of elements) {
        const computed = window.getComputedStyle(el);
        const animDuration = computed.animationDuration;
        const transDuration = computed.transitionDuration;

        if (animDuration && animDuration !== 'none' && animDuration !== '0s') {
          durations.push(parseDuration(animDuration));
        }
        if (transDuration && transDuration !== 'none' && transDuration !== '0s') {
          durations.push(parseDuration(transDuration));
        }
      }

      return durations;
    });

    // All animation/transition durations should be near zero (0.01ms = 0.00001s)
    for (const duration of animationDurations) {
      // Allow up to 1ms for browser rounding
      expect(duration).toBeLessThanOrEqual(1);
    }

    await context.close();
  });

  test('wall canvas respects reduced motion', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/wall');
    await page.waitForLoadState('networkidle');

    // The wall canvas should not have animated transitions
    const canvas = page.locator('canvas');
    if ((await canvas.count()) > 0) {
      // Check that the canvas container doesn't have transition animations
      const canvasStyles = await canvas.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          transition: computed.transition,
        };
      });

      // Should be 'none' or have 0s duration
      const hasNoTransition =
        canvasStyles.transition === 'none' ||
        canvasStyles.transition === 'all 0s ease 0s' ||
        canvasStyles.transition.includes('0s');
      expect(hasNoTransition).toBe(true);
    }

    await context.close();
  });

  test('page loads without motion-triggered content', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/');

    // Page should be fully usable immediately without waiting for animations
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();

    // Navigation should be immediately accessible
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();

    await context.close();
  });

  test('loading states do not rely solely on animation', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/wall');

    // Check that loading indicators have text alternatives
    const loadingIndicator = page.locator('[role="status"]');
    if ((await loadingIndicator.count()) > 0) {
      // Should have accessible text (aria-label, aria-describedby, or text content)
      const indicator = loadingIndicator.first();
      const ariaLabel = await indicator.getAttribute('aria-label');
      const text = await indicator.textContent();

      // Loading indicator should be perceivable without animation
      expect(ariaLabel !== null || (text !== null && text.trim().length > 0)).toBe(true);
    }

    await context.close();
  });

  test('focus is visible without animation', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/');

    // Tab to focus an element
    await page.keyboard.press('Tab');

    // Focus indicator should be visible immediately (not animated in)
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();

    // Check focus styles
    const focusStyles = await focusedElement.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        outline: computed.outline,
        boxShadow: computed.boxShadow,
        transitionDuration: computed.transitionDuration,
      };
    });

    // Should have visible focus indicator
    const hasFocus = focusStyles.outline !== 'none' || focusStyles.boxShadow !== 'none';
    expect(hasFocus).toBe(true);

    await context.close();
  });

  test('FAQ accordion works without animation', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/faq');
    await page.waitForLoadState('networkidle');

    // Find and click a FAQ item
    const faqItem = page.locator('details').first();
    if ((await faqItem.count()) > 0) {
      const summary = faqItem.locator('summary');
      await summary.click();

      // Content should be immediately visible (no animation delay)
      await expect(faqItem).toHaveAttribute('open', '');
    }

    await context.close();
  });
});

test.describe('Motion vs No-Motion Parity @a11y', () => {
  test('content is identical with and without reduced motion', async ({ browser }) => {
    // Create two contexts: one with reduced motion, one without
    const normalContext = await browser.newContext();
    const reducedContext = await browser.newContext({
      reducedMotion: 'reduce',
    });

    const normalPage = await normalContext.newPage();
    const reducedPage = await reducedContext.newPage();

    // Navigate both to the same page
    await normalPage.goto('/');
    await reducedPage.goto('/');

    await normalPage.waitForLoadState('networkidle');
    await reducedPage.waitForLoadState('networkidle');

    // Compare text content (should be identical)
    const normalText = await normalPage.evaluate(() =>
      document.body.innerText.replace(/\s+/g, ' ').trim(),
    );
    const reducedText = await reducedPage.evaluate(() =>
      document.body.innerText.replace(/\s+/g, ' ').trim(),
    );

    expect(normalText).toBe(reducedText);

    // Clean up
    await normalContext.close();
    await reducedContext.close();
  });
});
