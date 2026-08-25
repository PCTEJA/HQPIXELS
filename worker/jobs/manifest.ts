/**
 * Manifest and redirect-map maintenance.
 *
 * Two artefacts are rebuilt together because they are two views of the same
 * data:
 *
 *   KV_KEY_MANIFEST — PUBLIC. Served to every visitor, edge-cached. Contains
 *     hostnames only, never full destination URLs, never buyer identity.
 *
 *   KV_KEY_REDIRECTS — PRIVATE. placementId -> destination URL. Read by
 *     /go/:placementId so a click costs one KV read instead of a database query.
 *     Never served to a browser under any circumstance.
 *
 * Keeping them in one function means they cannot drift: a placement that appears
 * on the wall always has a working redirect, and a disabled one loses both at
 * the same moment.
 */

import {
  KV_KEY_MANIFEST,
  KV_KEY_MANIFEST_DIRTY,
  KV_KEY_RANKINGS,
  KV_KEY_STATS,
} from '@shared/constants';
import { absoluteImageUrl } from '../lib/images';
import type { Logger } from '../lib/logger';
import type { Deps } from '../context';

/** Private KV key. Not exported from shared/constants precisely so no client code can reach for it. */
export const KV_KEY_REDIRECTS = 'redirects:v1';

export interface ManifestRebuildResult {
  readonly version: number;
  readonly activePlacements: number;
  readonly redirectEntries: number;
  readonly durationMs: number;
}

/**
 * Rebuild both artefacts from the database and write them to KV.
 *
 * Write order matters: the redirect map is written FIRST. If the process dies
 * between the two writes, we would rather have working redirects for a placement
 * not yet on the wall than a placement on the wall whose link 404s.
 */
export async function rebuildManifest(deps: Deps, logger: Logger): Promise<ManifestRebuildResult> {
  const startedAt = Date.now();

  const [manifest, redirects] = await Promise.all([
    deps.db.buildWallManifest(),
    deps.db.buildRedirectMap(),
  ]);

  const version = typeof manifest.manifestVersion === 'number' ? manifest.manifestVersion : 0;
  const placements = Array.isArray(manifest.placements) ? manifest.placements : [];

  const publicManifest = {
    ...manifest,
    placements: placements.map((entry) => {
      const placement = entry as Record<string, unknown>;
      const path = typeof placement.imagePath === 'string' ? placement.imagePath : null;
      const { imagePath: _drop, ...rest } = placement;
      return { ...rest, image: absoluteImageUrl(deps.config, path), verified: true };
    }),
  };

  // Safety net: assert the public payload really is public before publishing it
  // to a globally readable cache. Cheap, and catches a SQL change that widens
  // the projection by accident.
  assertNoPrivateData(publicManifest);

  await deps.cacheKv.put(KV_KEY_REDIRECTS, JSON.stringify({ version, entries: redirects }), {
    expirationTtl: 86_400,
  });

  await deps.cacheKv.put(
    KV_KEY_MANIFEST,
    JSON.stringify({
      value: publicManifest,
      version,
      generatedAt: new Date(deps.now()).toISOString(),
    }),
    { expirationTtl: 86_400 },
  );

  await deps.cacheKv.delete(KV_KEY_MANIFEST_DIRTY).catch(() => undefined);

  const result: ManifestRebuildResult = {
    version,
    activePlacements: placements.length,
    redirectEntries: Object.keys(redirects).length,
    durationMs: Date.now() - startedAt,
  };

  logger.info('manifest_rebuilt', { ...result });
  return result;
}

/**
 * Fail closed if the public manifest ever contains something private.
 *
 * Checks the shape of the data rather than a field allowlist, because the risk
 * is a new field appearing, not an existing one changing.
 */
function assertNoPrivateData(manifest: Record<string, unknown>): void {
  const serialised = JSON.stringify(manifest);

  const forbidden: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /"destinationUrl"\s*:/, label: 'destinationUrl' },
    { pattern: /"ownerId"\s*:/, label: 'ownerId' },
    { pattern: /"reservationId"\s*:/, label: 'reservationId' },
    { pattern: /"email"\s*:/, label: 'email' },
    { pattern: /"amountCents"\s*:/, label: 'amountCents' },
    { pattern: /"quotedTotalCents"\s*:/, label: 'quotedTotalCents' },
    { pattern: /"stripe/i, label: 'stripe identifiers' },
    { pattern: /"moderationNote"\s*:/, label: 'moderationNote' },
  ];

  for (const { pattern, label } of forbidden) {
    if (pattern.test(serialised)) {
      throw new Error(
        `Refusing to publish the wall manifest: it contains ${label}, which must never be public.`,
      );
    }
  }
}

/**
 * Invalidate the public caches after a change to the wall.
 *
 * Rebuilds immediately rather than only deleting, so the next visitor gets a
 * warm cache instead of paying for the rebuild. Falls back to a delete (plus a
 * dirty marker for the cron to pick up) if the rebuild fails, because serving a
 * stale wall after a takedown is not acceptable.
 */
export async function invalidateManifest(deps: Deps, logger: Logger): Promise<void> {
  try {
    await rebuildManifest(deps, logger);
    // Stats include claimed-cell counts, which have just changed.
    await deps.cacheKv.delete(KV_KEY_STATS).catch(() => undefined);
  } catch (error) {
    logger.error('manifest_rebuild_failed_falling_back_to_purge', {
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      severity: 'high',
    });

    // Delete so nothing stale is served, and mark dirty so the cron retries.
    await Promise.all([
      deps.cacheKv.delete(KV_KEY_MANIFEST).catch(() => undefined),
      deps.cacheKv.delete(KV_KEY_REDIRECTS).catch(() => undefined),
      deps.cacheKv.delete(KV_KEY_STATS).catch(() => undefined),
      deps.cacheKv
        .put(KV_KEY_MANIFEST_DIRTY, String(deps.now()), { expirationTtl: 86_400 })
        .catch(() => undefined),
    ]);

    throw error;
  }
}

/** Cron safety net: rebuild only if something marked the manifest dirty. */
export async function rebuildIfDirty(deps: Deps, logger: Logger): Promise<boolean> {
  const dirty = await deps.cacheKv.get(KV_KEY_MANIFEST_DIRTY).catch(() => null);
  const missing = (await deps.cacheKv.get(KV_KEY_MANIFEST).catch(() => null)) === null;

  if (dirty === null && !missing) return false;

  logger.info('manifest_rebuild_triggered', {
    reason: dirty !== null ? 'dirty_flag' : 'cache_miss',
  });
  await rebuildManifest(deps, logger);
  return true;
}

/** Refresh the rankings snapshot cache after a leaderboard recompute. */
export async function invalidateRankings(deps: Deps): Promise<void> {
  await deps.cacheKv.delete(KV_KEY_RANKINGS).catch(() => undefined);
}

export interface RedirectMapEntry {
  readonly url: string;
  readonly host: string;
}

/**
 * Look up a destination for /go/:placementId.
 *
 * KV first (no database on the click path). Falls back to a single-row RPC on a
 * cold cache, which also self-heals by marking the manifest dirty.
 */
export async function lookupDestination(
  deps: Deps,
  placementId: string,
): Promise<RedirectMapEntry | null> {
  try {
    const cached = await deps.cacheKv.get(KV_KEY_REDIRECTS, 'json');
    if (cached !== null) {
      const entries = (cached as { entries?: Record<string, RedirectMapEntry> }).entries;
      const entry = entries?.[placementId];
      if (entry !== undefined && typeof entry.url === 'string') return entry;
      // A cache that exists but lacks this id means the placement is not active.
      // Trust it rather than falling through to the database on every 404 — that
      // would make an id-enumeration attack expensive for us.
      return null;
    }
  } catch {
    // Fall through to the database.
  }

  const result = await deps.db.resolveDestination(placementId);
  if (result.ok !== true) return null;

  const record = result as unknown as { url: string; host: string };
  await deps.cacheKv
    .put(KV_KEY_MANIFEST_DIRTY, String(deps.now()), { expirationTtl: 86_400 })
    .catch(() => undefined);

  return { url: record.url, host: record.host };
}
