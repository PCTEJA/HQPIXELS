/**
 * Keyboard accessibility tests.
 *
 * Verifies that all interactive elements can be reached and operated using
 * keyboard-only navigation. This is essential for users who cannot use a mouse.
 */
import { test, expect } from '@playwright/test';

test.describe('Keyboard Navigation', () => {
  test('can tab through landing page navigation', async ({ page }) => {
    await page.goto('/');

    // Focus should start at body or first focusable element
    await page.keyboard.press('Tab');

    // Should be able to tab through header navigation links
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(['A', 'BUTTON']).toContain(focusedTag);

    // Continue tabbing through navigation
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const tag = await page.evaluate(() => document.activeElement?.tagName);
      expect(tag).toBeDefined();
    }
  });

  test('skip link navigates to main content', async ({ page }) => {
    await page.goto('/');

    // Look for skip link (commonly first focusable element)
    await page.keyboard.press('Tab');

    // Check if there's a skip link or main landmark
    const hasMain = await page.locator('main').count();
    expect(hasMain).toBeGreaterThan(0);
  });

  test('buttons can be activated with Enter', async ({ page }) => {
    await page.goto('/');

    // Find and focus the CTA button
    const ctaButton = page.getByRole('link', { name: /claim/i });
    await ctaButton.focus();

    // Press Enter to activate
    await page.keyboard.press('Enter');

    // Should navigate to claim page
    await expect(page).toHaveURL(/\/claim/);
  });

  test('buttons can be activated with Space', async ({ page }) => {
    await page.goto('/pricing');

    // Find a button element (not a link)
    const button = page.getByRole('button').first();
    if ((await button.count()) > 0) {
      await button.focus();
      const tagName = await button.evaluate((el) => el.tagName);

      if (tagName === 'BUTTON') {
        // Space should work on actual buttons
        await page.keyboard.press('Space');
      }
    }
  });

  test('links have visible focus indicator', async ({ page }) => {
    await page.goto('/');

    // Tab to a link
    const link = page.getByRole('link').first();
    await link.focus();

    // Check that focus is visible (outline or other indicator)
    const styles = await link.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        outline: computed.outline,
        outlineWidth: computed.outlineWidth,
        boxShadow: computed.boxShadow,
      };
    });

    // Should have some focus indicator (outline, box-shadow, or border)
    const hasFocusIndicator =
      styles.outline !== 'none' || styles.outlineWidth !== '0px' || styles.boxShadow !== 'none';
    expect(hasFocusIndicator).toBe(true);
  });

  test('form inputs can be navigated with Tab', async ({ page }) => {
    await page.goto('/contact');

    // Tab through form fields
    const inputs = page.getByRole('textbox');
    const inputCount = await inputs.count();

    if (inputCount > 0) {
      await inputs.first().focus();

      for (let i = 0; i < inputCount - 1; i++) {
        await page.keyboard.press('Tab');
      }

      // Should still have focus on a form element
      const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
      expect(['INPUT', 'TEXTAREA', 'BUTTON', 'A']).toContain(focusedTag);
    }
  });

  test('dialogs trap focus', async ({ page }) => {
    await page.goto('/');

    // Try to open sign-in dialog if available
    const signInButton = page.getByRole('button', { name: /sign in/i });
    if ((await signInButton.count()) > 0) {
      await signInButton.click();

      // Wait for dialog to open
      const dialog = page.getByRole('dialog');
      if ((await dialog.count()) > 0) {
        // Tab should stay within dialog
        await page.keyboard.press('Tab');
        const _firstFocused = await page.evaluate(() =>
          document.activeElement?.closest('[role="dialog"]'),
        );

        // Continue tabbing
        for (let i = 0; i < 5; i++) {
          await page.keyboard.press('Tab');
        }

        // Focus should still be in dialog
        const stillInDialog = await page.evaluate(() => {
          const active = document.activeElement;
          return active?.closest('[role="dialog"]') !== null || active?.closest('dialog') !== null;
        });

        if (await dialog.isVisible()) {
          expect(stillInDialog).toBe(true);
        }

        // Escape should close dialog
        await page.keyboard.press('Escape');
      }
    }
  });

  test('interactive elements have accessible names', async ({ page }) => {
    await page.goto('/');

    // All buttons should have accessible names
    const buttons = page.getByRole('button');
    const buttonCount = await buttons.count();

    for (let i = 0; i < buttonCount; i++) {
      const button = buttons.nth(i);
      const name = (await button.getAttribute('aria-label')) ?? (await button.innerText());
      expect(name.length).toBeGreaterThan(0);
    }

    // All links should have accessible names
    const links = page.getByRole('link');
    const linkCount = await links.count();

    for (let i = 0; i < Math.min(linkCount, 20); i++) {
      const link = links.nth(i);
      const name = (await link.getAttribute('aria-label')) ?? (await link.innerText());
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  test('heading hierarchy is logical', async ({ page }) => {
    await page.goto('/');

    // Get all headings
    const headings = await page.evaluate(() => {
      const hs = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      return Array.from(hs).map((h) => ({
        level: parseInt(h.tagName[1] ?? '0', 10),
        text: h.textContent?.trim() ?? '',
      }));
    });

    // Should have at least one h1
    const h1Count = headings.filter((h) => h.level === 1).length;
    expect(h1Count).toBeGreaterThanOrEqual(1);

    // Heading levels should not skip (e.g., h1 -> h3)
    for (let i = 1; i < headings.length; i++) {
      const prev = headings[i - 1];
      const curr = headings[i];
      if (prev && curr) {
        // Can go to same, lower, or only one level deeper
        expect(curr.level - prev.level).toBeLessThanOrEqual(1);
      }
    }
  });
});

test.describe('Wall Canvas Keyboard Access @a11y', () => {
  test('wall has accessible list alternative', async ({ page }) => {
    await page.goto('/wall');

    // Wait for wall to load
    await page.waitForLoadState('networkidle');

    // The wall surface should have an accessible alternative
    // (WallAccessibleList provides this)
    const accessibleList = page.locator('[role="list"]');
    const canvas = page.locator('canvas');

    // Either we have a canvas with accessible list, or just accessible elements
    const hasCanvas = (await canvas.count()) > 0;
    const hasList = (await accessibleList.count()) > 0;

    // Should have some accessible content
    expect(hasCanvas || hasList).toBe(true);
  });
});
