// Exercise the production bundle under its actual CSP, without backend secrets.
// Run after pnpm run build:production: node scripts/smoke-wall.mjs
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const root = resolve('dist/client');
const headers = await readFile(resolve(root, '_headers'), 'utf8');
const csp = headers.match(/Content-Security-Policy: (.+)/)[1];
assert(!csp.includes("'unsafe-eval'"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  let views = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://wall.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) {
      if (path === '/api/public/view') {
        assert.equal(route.request().headers()['x-hq-csrf'], 'smoke-token');
        views += 1;
        return route.fulfill({ status: 204 });
      }
      const json =
        path === '/api/auth/session'
          ? { authenticated: false, user: null, csrfToken: 'smoke-token' }
          : path === '/api/public/wall-manifest'
            ? {
                manifestVersion: 1,
                generatedAt: new Date().toISOString(),
                grid: { size: 100, cellLogicalSize: 10 },
                placements: [],
                occupancyBitmap: Buffer.alloc(1250).toString('base64'),
                counts: { activePlacements: 0, claimedCells: 0, availableCells: 10000 },
              }
            : { manifestVersion: 1 };
      return route.fulfill({ json });
    }
    const file = path.startsWith('/assets/')
      ? resolve(root, '.' + path)
      : resolve(root, 'index.html');
    assert(file.startsWith(root));
    const contentType = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[
      extname(file)
    ];
    await route.fulfill({
      body: await readFile(file),
      contentType,
      headers: { 'Content-Security-Policy': csp },
    });
  });
  await page.goto('https://wall.test/wall');
  await page.locator('canvas').waitFor({ state: 'visible' });
  const zoom = page.getByRole('group', { name: 'Zoom controls' });
  const before = await zoom.innerText();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForFunction(
    (old) => document.querySelector('[aria-label="Zoom controls"]').innerText !== old,
    before,
  );
  assert.equal(await page.getByText('The interactive wall could not start').count(), 0);
  assert(views > 0);
  await page.goto('https://wall.test/claim');
  await page.locator('canvas').waitFor({ state: 'visible' });
  const wall = page.getByRole('application', { name: /Pixel wall, selection mode/ });
  const bounds = await wall.boundingBox();
  assert(bounds);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.click(x, y);
  await expect(page.getByText('1 x 1 units (10 x 10 pixels)', { exact: true })).toBeVisible();
  await expect(wall).toBeFocused();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('section[aria-label="The HQPixels wall"] .ml-auto')).not.toHaveText(
    '1 x 1 units (10 x 10 pixels)',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByText('Drag a rectangle on the wall,', { exact: false })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 x 1 units (10 x 10 pixels)', { exact: true })).toBeVisible();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByText('2 x 1 units (20 x 10 pixels)', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: production wall renders and zooms under strict CSP; mouse click, drag, and keyboard selection work; page view carries CSRF.',
  );
} finally {
  await browser.close();
}
