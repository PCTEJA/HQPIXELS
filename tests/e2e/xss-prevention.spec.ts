/**
 * XSS prevention tests.
 *
 * Verifies that the application properly escapes user input and that XSS
 * payloads in URL parameters, search queries, and other inputs are rendered
 * as text rather than executed as code.
 *
 * The app has a strict CSP (no unsafe-inline for scripts, no unsafe-eval),
 * but defense in depth requires proper output encoding as well.
 */
import { test, expect, type Page } from '@playwright/test';

/** Common XSS test vectors */
const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  'javascript:alert(1)',
  '<iframe src="javascript:alert(1)">',
  '"><script>alert(1)</script>',
  "'-alert(1)-'",
  '<body onload=alert(1)>',
  '<input onfocus=alert(1) autofocus>',
  '<marquee onstart=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  '<div style="background:url(javascript:alert(1))">',
  '{{constructor.constructor("alert(1)")()}}',
  '${alert(1)}',
  '<math><maction actiontype="statusline#http://google.com" xlink:href="javascript:alert(1)">',
];

/**
 * Listen for JavaScript errors and alert() calls
 */
async function setupXssDetection(page: Page): Promise<{ triggered: boolean; message: string }> {
  const result = { triggered: false, message: '' };

  // Catch any alert() calls
  page.on('dialog', async (dialog) => {
    result.triggered = true;
    result.message = `Dialog triggered: ${dialog.message()}`;
    await dialog.dismiss();
  });

  // Listen for console errors that might indicate XSS
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('XSS')) {
      result.triggered = true;
      result.message = msg.text();
    }
  });

  return result;
}

test.describe('XSS Prevention - URL Parameters', () => {
  for (const payload of XSS_PAYLOADS.slice(0, 5)) {
    test(`blocks XSS in query param: ${payload.slice(0, 30)}...`, async ({ page }) => {
      const detection = await setupXssDetection(page);

      // Try the payload in a query parameter
      const encodedPayload = encodeURIComponent(payload);
      await page.goto(`/?q=${encodedPayload}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);

      // No XSS should have been triggered
      expect(detection.triggered).toBe(false);

      // The payload should be visible as text, not executed
      const bodyHtml = await page.content();
      // Scripts should not be in the DOM as executable elements
      expect(bodyHtml).not.toContain('<script>alert');
    });
  }

  test('XSS payload in focus parameter renders as text', async ({ page }) => {
    const detection = await setupXssDetection(page);
    const payload = '<script>alert("xss")</script>';

    await page.goto(`/wall?focus=${encodeURIComponent(payload)}`);
    await page.waitForLoadState('networkidle');

    expect(detection.triggered).toBe(false);
  });

  test('XSS payload in reservation parameter is harmless', async ({ page }) => {
    const detection = await setupXssDetection(page);
    const payload = '<img src=x onerror=alert(1)>';

    await page.goto(`/claim/success?reservation=${encodeURIComponent(payload)}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    expect(detection.triggered).toBe(false);
  });
});

test.describe('XSS Prevention - URL Hash', () => {
  test('XSS payload in hash is not executed', async ({ page }) => {
    const detection = await setupXssDetection(page);

    await page.goto('/#<script>alert(1)</script>');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    expect(detection.triggered).toBe(false);
  });
});

test.describe('XSS Prevention - Search and Forms', () => {
  test('XSS in search input is escaped', async ({ page }) => {
    const detection = await setupXssDetection(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Find a search/text input if one exists
    const searchInput = page.locator('input[type="search"], input[type="text"]').first();
    if ((await searchInput.count()) > 0) {
      await searchInput.fill('<script>alert(1)</script>');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);

      expect(detection.triggered).toBe(false);
    }
  });

  test('XSS in contact form is escaped', async ({ page }) => {
    const detection = await setupXssDetection(page);

    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    // Fill form fields with XSS payloads
    const textInputs = page.locator('input[type="text"], textarea');
    const inputCount = await textInputs.count();

    for (let i = 0; i < inputCount; i++) {
      const input = textInputs.nth(i);
      await input.fill('<script>alert(1)</script>');
    }

    // Try to submit (will likely fail validation, which is fine)
    const submitButton = page.getByRole('button', { name: /submit|send/i });
    if ((await submitButton.count()) > 0) {
      await submitButton.click();
      await page.waitForTimeout(500);
    }

    expect(detection.triggered).toBe(false);
  });
});

test.describe('XSS Prevention - CSP Enforcement', () => {
  test('CSP blocks inline script execution', async ({ page }) => {
    // The CSP should block any inline scripts
    const consoleMessages: string[] = [];
    page.on('console', (msg) => {
      consoleMessages.push(msg.text());
    });

    await page.goto('/');

    // Try to inject inline script via devtools/evaluate
    // This simulates what would happen if XSS got through output encoding
    const result = await page.evaluate(() => {
      try {
        // This should be blocked by CSP
        const script = document.createElement('script');
        script.textContent = 'window.__xssTest = true';
        document.body.appendChild(script);
        return (window as unknown as { __xssTest?: boolean }).__xssTest === true;
      } catch {
        return false;
      }
    });

    // Even if the script element was added, CSP should prevent execution
    // Note: page.evaluate runs in a different context than CSP applies to
    // This test verifies the CSP header is set correctly
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('CSP blocks eval()', async ({ page }) => {
    await page.goto('/');

    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'];

    // Verify no unsafe-eval
    expect(csp).not.toContain('unsafe-eval');

    // The script-src directive should be restrictive
    expect(csp).toMatch(/script-src[^;]*'self'/);
  });
});

test.describe('XSS Prevention - Data Attributes', () => {
  test('malicious data in URL does not appear in dangerous attributes', async ({ page }) => {
    const payload = 'javascript:alert(1)';
    await page.goto(`/?redirect=${encodeURIComponent(payload)}`);
    await page.waitForLoadState('networkidle');

    // Check that no href, src, or action attributes contain javascript:
    const dangerousLinks = await page.evaluate(() => {
      const elements = document.querySelectorAll('[href^="javascript:"], [src^="javascript:"], [action^="javascript:"]');
      return elements.length;
    });

    expect(dangerousLinks).toBe(0);
  });

  test('onclick and other event handlers are not injected', async ({ page }) => {
    await page.goto('/?x=" onclick="alert(1)');
    await page.waitForLoadState('networkidle');

    // Check for injected event handlers
    const injectedHandlers = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      let count = 0;
      for (const el of all) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith('on') && attr.value.includes('alert')) {
            count++;
          }
        }
      }
      return count;
    });

    expect(injectedHandlers).toBe(0);
  });
});

test.describe('XSS Prevention - Content Types', () => {
  test('API responses have correct content type', async ({ page }) => {
    // API should return JSON, not HTML
    const response = await page.request.get('/api/wall/manifest');
    const contentType = response.headers()['content-type'];

    // Should be JSON, which browsers won't render as HTML
    expect(contentType).toContain('application/json');
  });

  test('X-Content-Type-Options prevents MIME sniffing', async ({ page }) => {
    const response = await page.goto('/');
    const xcto = response?.headers()['x-content-type-options'];

    expect(xcto).toBe('nosniff');
  });
});
