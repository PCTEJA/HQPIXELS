/**
 * robots.txt and sitemap.xml.
 *
 * Served by the Worker rather than as static files because the disallow list and
 * the sitemap both depend on the environment: a staging deployment must be
 * entirely un-indexed, and the sitemap needs the canonical host.
 *
 * Structured data is deliberately minimal and only ever describes things that
 * are true. No fabricated aggregate ratings, no invented offer counts.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../context';
import { escapeXml } from '../lib/html';
import { publicCacheControl } from '../lib/cache';

export const seoRoutes = new Hono<AppEnv>();

/** Public, indexable pages. Everything else is either private or noise. */
const PUBLIC_ROUTES: ReadonlyArray<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'hourly', priority: '1.0' },
  { path: '/wall', changefreq: 'hourly', priority: '0.9' },
  { path: '/pricing', changefreq: 'weekly', priority: '0.8' },
  { path: '/rankings', changefreq: 'daily', priority: '0.6' },
  { path: '/stats', changefreq: 'daily', priority: '0.6' },
  { path: '/faq', changefreq: 'monthly', priority: '0.5' },
  { path: '/content-policy', changefreq: 'monthly', priority: '0.4' },
  { path: '/terms', changefreq: 'monthly', priority: '0.3' },
  { path: '/privacy', changefreq: 'monthly', priority: '0.3' },
  { path: '/refund-policy', changefreq: 'monthly', priority: '0.3' },
  { path: '/contact', changefreq: 'monthly', priority: '0.4' },
];

/**
 * Paths that must never be indexed.
 *
 * `/go/` is disallowed for a specific reason: those are paid outbound links.
 * Letting a crawler follow them would pass link equity to advertisers, which is
 * exactly what `rel="sponsored nofollow"` and this rule exist to prevent.
 */
const DISALLOWED = [
  '/api/',
  '/go/',
  '/dashboard',
  '/admin',
  '/claim/success',
  '/claim/cancelled',
  '/claim/resume',
];

seoRoutes.get('/robots.txt', (c) => {
  const config = c.get('deps').config;

  // A staging deployment that gets indexed becomes a duplicate-content problem
  // and a source of confused buyers. Block everything.
  if (!config.isProduction) {
    return c.text(
      [
        'User-agent: *',
        'Disallow: /',
        '',
        '# Non-production deployment. Not for indexing.',
        '',
      ].join('\n'),
      200,
      {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    );
  }

  const lines = [
    'User-agent: *',
    ...DISALLOWED.map((path) => `Disallow: ${path}`),
    'Allow: /',
    '',
    // Politeness, not security: a crawler that ignores this is handled by the
    // WAF and the rate limiter.
    'Crawl-delay: 1',
    '',
    `Sitemap: ${config.siteUrl}/sitemap.xml`,
    '',
  ];

  return c.text(lines.join('\n'), 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': publicCacheControl({ maxAge: 3600, staleWhileRevalidate: 86_400 }),
  });
});

seoRoutes.get('/sitemap.xml', (c) => {
  const config = c.get('deps').config;

  if (!config.isProduction) {
    // An empty but valid sitemap. Better than a 404, which some tools retry.
    return c.body(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n',
      200,
      { 'Content-Type': 'application/xml; charset=utf-8', 'X-Robots-Tag': 'noindex' },
    );
  }

  // Date only, not a timestamp: a lastmod that changes every request teaches
  // crawlers that nothing is stable.
  const today = new Date(c.get('deps').now()).toISOString().slice(0, 10);

  const entries = PUBLIC_ROUTES.map((route) =>
    [
      '  <url>',
      `    <loc>${escapeXml(`${config.siteUrl}${route.path}`)}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      `    <changefreq>${route.changefreq}</changefreq>`,
      `    <priority>${route.priority}</priority>`,
      '  </url>',
    ].join('\n'),
  );

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');

  return c.body(xml, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': publicCacheControl({ maxAge: 3600, staleWhileRevalidate: 86_400 }),
  });
});
