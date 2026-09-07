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
  // Only this isolated browser test replaces the external challenge widget.
  await page.addInitScript(() => {
    window.turnstile = {
      render: (_container, options) => {
        setTimeout(() => options.callback('smoke-token'), 0);
        return 'smoke-widget';
      },
      remove: () => {},
      reset: () => {},
    };
  });
  const errors = [];
  let views = 0;
  page.on('pageerror', (error) => errors.push(error.stack));
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
  await page.route('https://wall.test/api/reservations/test-hold', async (route) => {
    // Let the preview mount before the hold arrives to exercise the countdown.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      json: {
        reservation: {
          id: 'test-hold',
          state: 'reserved',
          x: 0,
          y: 0,
          w: 5,
          h: 5,
          totalCents: 2500,
          expiresAt: new Date(Date.now() + 2700000).toISOString(),
        },
        placement: {
          id: 'test-placement',
          title: '',
          altText: '',
          destinationUrl: null,
          imageUrl: null,
        },
      },
    });
  });
  await page.goto('https://wall.test/claim?reservation=test-hold');
  await expect(page.getByRole('heading', { name: 'Your artwork and link' })).toBeVisible();
  await expect(page).toHaveURL('https://wall.test/claim?reservation=test-hold');
  await page.getByRole('link', { name: 'Claim your plot', exact: true }).first().click();
  await expect(page).toHaveURL('https://wall.test/claim');
  await expect(wall).toBeVisible();
  await page.route('https://wall.test/api/reservations/missing-hold', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'Hold not found.' } },
    }),
  );
  await page.goto('https://wall.test/claim?reservation=missing-hold');
  await expect(page.getByText('We could not find that hold')).toBeVisible();
  await page.getByRole('link', { name: 'Start a new selection' }).click();
  await expect(wall).toBeVisible();
  let createdRect;
  let createCount = 0;
  await page.route('https://wall.test/api/auth/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: 'smoke-user', email: 'test@example.com', emailVerified: true },
        csrfToken: 'smoke-token',
      },
    }),
  );
  await page.route('https://wall.test/api/public/pricing', (route) =>
    route.fulfill({
      json: {
        version: 1,
        currency: 'USD',
        centsPerLogicalPixel: 1,
        zoneMultipliers: [],
        minCells: 1,
        maxCells: 10000,
        reservationTtlSeconds: 2700,
      },
    }),
  );
  await page.route('https://wall.test/api/public/quote?*', (route) =>
    route.fulfill({
      json: {
        available: true,
        unavailableCells: [],
        quote: { totalCents: 2500, pricingVersion: 1, lines: [] },
      },
    }),
  );
  await page.route('https://wall.test/api/reservations', async (route) => {
    assert.equal(route.request().method(), 'POST');
    createdRect = route.request().postDataJSON().rect;
    createCount += 1;
    await route.fulfill({ json: { reservation: { id: 'fresh-hold' } } });
  });
  await page.route('https://wall.test/api/reservations/fresh-hold', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      json: {
        reservation: {
          id: 'fresh-hold',
          state: 'reserved',
          ...createdRect,
          totalCents: 2500,
          expiresAt: new Date(Date.now() + 2700000).toISOString(),
        },
        placement: {
          id: 'fresh-placement',
          title: '',
          altText: '',
          destinationUrl: null,
          imageUrl: null,
        },
      },
    });
  });
  await page.goto('https://wall.test/claim');
  await page.locator('canvas').waitFor({ state: 'visible' });
  await wall.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Hold these units', exact: true }).click();
  await expect(page).toHaveURL('https://wall.test/claim/resume?reservation=fresh-hold');
  await expect(page.getByRole('heading', { name: 'Your artwork and link' })).toBeVisible();
  await expect(page.getByLabel('Placement preview')).toContainText('$25.00');
  await expect(page.getByLabel('Placement preview')).toContainText('20 x 10 pixels');
  assert.equal(createCount, 1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your artwork and link' })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: wall selection, preview with delayed hold, new-claim navigation, missing-hold recovery, and strict CSP.',
  );
} finally {
  await browser.close();
}
