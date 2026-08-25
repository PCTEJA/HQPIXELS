/**
 * Scheduled work dispatch.
 *
 * One `scheduled` handler, several cron expressions, dispatched by expression so
 * each job runs at its own cadence. The expressions live in wrangler.jsonc and
 * as constants below; this file maps them to work.
 *
 *   every 2 minutes     reservation expiry + payment reconciliation
 *   4x per hour         analytics flush safety net + manifest rebuild if dirty
 *   hourly at :23       leaderboard snapshots
 *   daily at 03:40      link health + privacy data purge
 *
 * (The literal cron strings are in the exported constants — they are not written
 * out in this comment because a slash-star sequence would terminate it.)
 *
 * Every job is independently safe to run twice, late, or concurrently with
 * itself, because a cron can fire twice and a deploy can overlap. That property
 * is a requirement, not a nicety.
 */

import type { Logger } from '../lib/logger';
import type { Deps } from '../context';
import { expireReservations, reconcilePayments } from './reconcile';
import { rebuildIfDirty, invalidateRankings } from './manifest';
import { checkDestinationLinks } from './link-health';

export const CRON_EXPIRY_AND_RECONCILE = '*/2 * * * *';
export const CRON_ANALYTICS_AND_MANIFEST = '7,22,37,52 * * * *';
export const CRON_LEADERBOARDS = '23 * * * *';
export const CRON_MAINTENANCE = '40 3 * * *';

/** Staging uses a slower expiry cadence; accept both spellings. */
const EXPIRY_ALIASES = new Set([CRON_EXPIRY_AND_RECONCILE, '*/5 * * * *']);
const ANALYTICS_ALIASES = new Set([CRON_ANALYTICS_AND_MANIFEST, '7,37 * * * *']);

export interface ScheduledResult {
  readonly cron: string;
  readonly ranJobs: readonly string[];
  readonly durationMs: number;
}

export async function runScheduled(
  cron: string,
  deps: Deps,
  logger: Logger,
): Promise<ScheduledResult> {
  const startedAt = Date.now();
  const ran: string[] = [];

  // Each job is wrapped so one failure cannot prevent the others from running.
  const attempt = async (name: string, work: () => Promise<unknown>): Promise<void> => {
    const jobLogger = logger.child({ job: name });
    try {
      await work();
      ran.push(name);
    } catch (error) {
      jobLogger.error('scheduled_job_failed', {
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
        severity: 'high',
      });
      await deps.db
        .recordJobRun(name, false, 0, 'unhandled error - see logs')
        .catch(() => undefined);
    }
  };

  if (EXPIRY_ALIASES.has(cron)) {
    // Expiry first: reconciliation is more useful once dead holds are gone.
    await attempt('expire_reservations', () => expireReservations(deps, logger));
    await attempt('reconcile_payments', () => reconcilePayments(deps, logger));
  }

  if (ANALYTICS_ALIASES.has(cron)) {
    await attempt('analytics_flush', () => deps.analytics.flushAll());
    await attempt('manifest_rebuild_if_dirty', () => rebuildIfDirty(deps, logger));
  }

  if (cron === CRON_LEADERBOARDS) {
    await attempt('rebuild_leaderboards', async () => {
      const result = await deps.db.rebuildLeaderboards();
      await invalidateRankings(deps);
      await deps.db
        .recordJobRun('rebuild_leaderboards', result.ok, result.boards, null)
        .catch(() => undefined);
    });
    // Stats include a 30-day click total that the leaderboard pass has just
    // recomputed the inputs for.
    await attempt('refresh_stats_cache', async () => {
      const { KV_KEY_STATS } = await import('@shared/constants');
      await deps.cacheKv.delete(KV_KEY_STATS);
    });
  }

  if (cron === CRON_MAINTENANCE) {
    await attempt('link_health', () => checkDestinationLinks(deps, logger));
    await attempt('purge_privacy_data', async () => {
      const result = await deps.db.purgePrivacyData();
      logger.info('privacy_purge_complete', { ...result });
      await deps.db.recordJobRun('purge_privacy_data', true, 0, null).catch(() => undefined);
    });
    // A full rebuild once a day catches any drift the incremental invalidation
    // missed. Cheap insurance against a stale wall.
    await attempt('daily_manifest_rebuild', async () => {
      const { rebuildManifest } = await import('./manifest');
      await rebuildManifest(deps, logger);
    });
  }

  const durationMs = Date.now() - startedAt;
  logger.info('scheduled_complete', { cron, ranJobs: ran, durationMs });

  return { cron, ranJobs: ran, durationMs };
}
