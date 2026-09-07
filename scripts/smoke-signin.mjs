// Run after a production build. All API calls are intercepted; no email is sent.
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const root = resolve('dist/client');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const submitted = [];
  await page.addInitScript(() => {
    let serial = 0;
    window.turnstile = {
      render: (_container, options) => {
        const id = `widget-${++serial}`;
        setTimeout(() => options.callback(`token-${id}`), 0);
        return id;
      },
      remove: () => {},
      reset: () => {
        throw new Error('Sign-in must not reset an unrelated widget');
      },
    };
  });
  await page.route('https://signin.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/magic-link') {
      submitted.push(route.request().postDataJSON().turnstileToken);
      return route.fulfill(
        submitted.length === 1
          ? {
              status: 403,
              json: { error: { code: 'turnstile_failed', message: 'Please try again.' } },
            }
          : { json: { ok: true } },
      );
    }
    if (path === '/api/auth/session') {
      return route.fulfill({ json: { authenticated: false, user: null, csrfToken: 'smoke-csrf' } });
    }
    if (path.startsWith('/api/')) return route.fulfill({ json: {} });
    const file = path.startsWith('/assets/')
      ? resolve(root, '.' + path)
      : resolve(root, 'index.html');
    assert(file.startsWith(root));
    await route.fulfill({
      body: await readFile(file),
      contentType: { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[
        extname(file)
      ],
    });
  });
  await page.goto('https://signin.test/faq');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email address' }).fill('test@example.com');
  const submit = page.getByRole('button', { name: 'Email me a sign-in link', exact: true });
  await submit.click();
  await page.getByText('Sign-in failed', { exact: true }).waitFor();
  await submit.click();
  await page.getByText('Check your inbox', { exact: true }).waitFor();
  assert.equal(submitted.length, 2);
  assert.notEqual(submitted[0], submitted[1]);
  console.log(
    'PASS: failed sign-in obtains a fresh widget token and retries successfully (mock API).',
  );
} finally {
  await browser.close();
}
