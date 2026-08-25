/**
 * /go/:placementId — the controlled outbound redirect.
 *
 * The single most important property: the redirect target is NEVER taken from
 * the request. It is looked up by id from data we validated and stored. There is
 * no `?url=` parameter to abuse, so this endpoint cannot be used as an open
 * redirect to launder a phishing link through our domain.
 *
 * Performance: the lookup hits KV, not Postgres, and the click is counted in a
 * Durable Object buffer. A click therefore costs one KV read and one in-memory
 * increment — no database work on the click path at all.
 */

import { Hono } from 'hono';
import { OUTBOUND_LINK_REL, VISITOR_COOKIE_TTL_SECONDS } from '@shared/constants';
import { placementIdParamSchema } from '@shared/schemas';
import type { AppContext, AppEnv } from '../context';
import { NO_STORE } from '../lib/cache';
import { ipBucketKey, looksAutomated } from '../lib/client-ip';
import { visitorCookie } from '../lib/cookies';
import { randomToken } from '../lib/crypto';
import { lookupDestination } from '../jobs/manifest';
import { escapeHtml } from '../lib/html';

export const goRoutes = new Hono<AppEnv>();

goRoutes.get('/:placementId', async (c) => {
  const deps = c.get('deps');
  const logger = c.get('logger');

  const parsed = placementIdParamSchema.safeParse({ placementId: c.req.param('placementId') });
  if (!parsed.success) {
    return notFoundPage(c);
  }
  const placementId = parsed.data.placementId;

  const destination = await lookupDestination(deps, placementId);

  // A disabled, rejected, refunded or non-existent placement all look identical
  // from here. That is deliberate: this endpoint must not be an oracle for which
  // placement ids exist.
  if (destination === null) {
    return notFoundPage(c);
  }

  // --- click accounting -------------------------------------------------------
  let visitorId = c.get('visitorId');
  const isNewVisitor = visitorId === null;
  if (visitorId === null) visitorId = randomToken(16);

  const bucketKey = await ipBucketKey(visitorId, deps.config.signingSecret, 'click');
  const decision = await deps.rateLimiter.consume('clickRedirect', bucketKey);
  const automated = looksAutomated(c.req.raw);

  // Over-limit and automated clicks are recorded as `filtered` rather than
  // dropped, so the buyer's dashboard can show real vs excluded counts and the
  // leaderboards use only the filtered-clean number.
  deps.analytics.recordClick(placementId, visitorId, automated || !decision.allowed);

  logger.debug('outbound_redirect', {
    placementId,
    host: destination.host,
    filtered: automated || !decision.allowed,
  });

  // --- the redirect -----------------------------------------------------------
  // 302, not 301: a permanent redirect would be cached by the browser forever,
  // and we must be able to disable a malicious link and have that take effect.
  const response = c.redirect(destination.url, 302);

  response.headers.set('Cache-Control', NO_STORE);
  // Do not leak which placement (or which page) the visitor came from to the
  // destination site.
  response.headers.set('Referrer-Policy', 'no-referrer');
  // Signals to search engines that this is a paid link, on the redirect itself
  // as well as on the anchor tag.
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Link', `<${destination.url}>; rel="${OUTBOUND_LINK_REL}"`);

  if (isNewVisitor) {
    response.headers.append(
      'Set-Cookie',
      visitorCookie(
        visitorId,
        { isProduction: deps.config.isProduction },
        VISITOR_COOKIE_TTL_SECONDS,
      ),
    );
  }

  return response;
});

/**
 * A small HTML page rather than a bare 404.
 *
 * Someone reaching this followed a link from the wall that has since been taken
 * down, and telling them so is better than a blank error. Everything
 * interpolated is escaped; there is no user-controlled content on the page at
 * all, but the escaping helper is used anyway so the pattern is consistent.
 */
function notFoundPage(c: AppContext): Response {
  const siteUrl = c.get('deps').config.siteUrl;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Link unavailable - HQPixels</title>
<style>
  :root { color-scheme: dark light; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #070A0F; color: #EAF7FF;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  main { max-width: 34rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.5rem; color: #9FB3C8; }
  a {
    display: inline-block; padding: 0.7rem 1.25rem; border-radius: 0.5rem;
    background: #FFC857; color: #070A0F; font-weight: 600; text-decoration: none;
  }
  a:focus-visible { outline: 3px solid #28D7F4; outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <h1>That link is not available</h1>
  <p>The placement it pointed to is no longer active. It may have been taken down, refunded, or the hold expired.</p>
  <a href="${escapeHtml(siteUrl)}/wall">Explore the wall</a>
</main>
</body>
</html>`;

  return c.html(html, 404, {
    'Cache-Control': 'public, max-age=60',
    'X-Robots-Tag': 'noindex, nofollow',
  });
}
