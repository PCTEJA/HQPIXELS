/**
 * Destination link health checks.
 *
 * Why this matters beyond tidiness: an expired advertiser domain gets
 * re-registered, often by someone running malware or a phishing kit. A wall of
 * permanent links is a wall of permanent liabilities unless something keeps
 * checking them.
 *
 * SSRF POSTURE — read this before changing anything here.
 *
 * This job makes outbound requests to URLs a buyer chose. That is inherently
 * SSRF-shaped, so it is constrained hard:
 *
 *   * Only stored, already-normalised URLs are fetched. `normalizeDestinationUrl`
 *     has already rejected IP literals, private ranges, credentials, non-web
 *     schemes, non-web ports and localhost, and the stored value is the
 *     canonical form — not the buyer's raw string.
 *   * The URL is re-validated here anyway, in case a stored row predates a
 *     tightening of the rules.
 *   * `redirect: 'manual'`. A 302 to http://169.254.169.254/ is the classic
 *     bypass; we never follow one. A redirect is recorded as its status code and
 *     the chain stops there.
 *   * HEAD first, with a hard timeout, and the response BODY IS NEVER READ. We
 *     want a status code, not content.
 *   * Runs only on a cron trigger, never in response to a user request, so it
 *     cannot be used as a probe-on-demand oracle.
 *
 * A dedicated egress-restricted service would be stronger still, and that is
 * recorded as a residual risk in SECURITY.md.
 */

import { normalizeDestinationUrl } from '@shared/url-safety';
import type { Logger } from '../lib/logger';
import type { Deps } from '../context';
import { invalidateManifest } from './manifest';

const REQUEST_TIMEOUT_MS = 6000;
const BATCH_SIZE = 25;

export interface LinkHealthResult {
  readonly checked: number;
  readonly healthy: number;
  readonly unhealthy: number;
  readonly disabled: number;
  readonly skipped: number;
}

/** Status codes that mean "this link works well enough for a visitor". */
function isHealthyStatus(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  // Redirects are fine for a visitor even though we do not follow them.
  if (status >= 300 && status < 400) return true;
  // Some sites block HEAD or bot-like clients with 403/405 while working fine in
  // a browser. Treating those as dead would generate false takedowns.
  if (status === 403 || status === 405 || status === 429) return true;
  return false;
}

export async function checkDestinationLinks(deps: Deps, logger: Logger): Promise<LinkHealthResult> {
  const result = { checked: 0, healthy: 0, unhealthy: 0, disabled: 0, skipped: 0 };

  let due: Awaited<ReturnType<Deps['db']['linksDueForCheck']>>;
  try {
    due = await deps.db.linksDueForCheck(BATCH_SIZE);
  } catch (error) {
    logger.error('link_health_query_failed', {
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
    return result;
  }

  let anyDisabled = false;

  for (const item of due) {
    // Re-validate even though it was validated on the way in: a stored row may
    // predate a tightening of the URL rules, and this is the one place we
    // deliberately make an outbound request.
    const revalidated = normalizeDestinationUrl(item.url, {
      selfHosts: [deps.config.siteHost],
      requireHttps: false,
    });

    if (!revalidated.ok) {
      result.skipped += 1;
      logger.warn('link_health_stored_url_now_invalid', {
        placementId: item.placementId,
        reason: revalidated.reason,
        severity: 'high',
      });
      // A stored URL that no longer passes validation is disabled outright: the
      // rules tightened for a reason.
      await deps.db
        .disablePlacement(
          item.placementId,
          null,
          `auto-disabled: destination no longer passes URL validation (${revalidated.reason})`,
          'system',
          'link-health',
        )
        .catch(() => undefined);
      result.disabled += 1;
      anyDisabled = true;
      continue;
    }

    result.checked += 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let status = 0;
    try {
      const response = await fetch(revalidated.url, {
        method: 'HEAD',
        // Never follow a redirect: that is the SSRF bypass.
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Identify ourselves honestly so a site owner can allowlist or block us.
          'User-Agent': 'HQPixels-LinkCheck/1.0 (+https://hqpixels.com/faq#link-checks)',
          Accept: '*/*',
        },
      });
      status = response.status;
      // The body is deliberately never read.
    } catch (error) {
      // A timeout, DNS failure or TLS error all mean "not reachable".
      status = error instanceof Error && error.name === 'AbortError' ? 598 : 599;
    } finally {
      clearTimeout(timeout);
    }

    const healthy = isHealthyStatus(status);
    if (healthy) result.healthy += 1;
    else result.unhealthy += 1;

    try {
      const recorded = await deps.db.recordLinkCheck(item.placementId, status, healthy);
      if (recorded.ok === true && (recorded as { disabled?: boolean }).disabled === true) {
        result.disabled += 1;
        anyDisabled = true;
        logger.warn('placement_auto_disabled_dead_link', {
          placementId: item.placementId,
          host: item.host,
          status,
        });
      }
    } catch (error) {
      logger.warn('link_check_record_failed', {
        placementId: item.placementId,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    }
  }

  if (anyDisabled) {
    await invalidateManifest(deps, logger).catch(() => undefined);
  }

  logger.info('link_health_complete', { ...result });

  await deps.db
    .recordJobRun(
      'link_health',
      true,
      result.checked,
      `healthy=${result.healthy} unhealthy=${result.unhealthy} disabled=${result.disabled} skipped=${result.skipped}`,
    )
    .catch(() => undefined);

  return result;
}
