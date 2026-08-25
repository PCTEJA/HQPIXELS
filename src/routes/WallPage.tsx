/**
 * Full-screen wall.
 *
 * `?focus=<placementId>` frames a specific placement, which is what a shared
 * placement card links to.
 */

import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useWallManifest } from '../lib/queries';
import { WallSurface } from '../components/wall/WallSurface';
import { EmptyState } from '../components/primitives';
import { formatCount } from '../lib/format';

export function WallPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const manifest = useWallManifest();

  const rawFocus = params.get('focus');
  // Only accept a UUID shape. An arbitrary string here would be handed to the
  // renderer and used in a lookup.
  const focusPlacementId =
    rawFocus !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawFocus)
      ? rawFocus
      : null;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-3 pb-16 pt-4 sm:px-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">The wall</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {manifest.data !== undefined
              ? `${formatCount(manifest.data.counts.activePlacements)} live placements, ${formatCount(
                  manifest.data.counts.availableCells,
                )} units still available.`
              : 'Loading the current state of the wall…'}
          </p>
        </div>
        <Link to="/claim" className="btn btn-cta no-underline">
          Claim your plot
        </Link>
      </div>

      {manifest.isError ? (
        <EmptyState title="We could not load the wall">{manifest.error.message}</EmptyState>
      ) : manifest.data !== undefined ? (
        <WallSurface
          manifest={manifest.data}
          mode="browse"
          selection={null}
          focusPlacementId={focusPlacementId}
          heightClass="h-[min(78vh,900px)]"
        />
      ) : (
        <div
          className="grid-motif flex h-[60vh] items-center justify-center rounded-card border border-hairline"
          role="status"
        >
          <p className="text-sm text-ink-subtle">Loading the wall…</p>
        </div>
      )}
    </div>
  );
}

export default WallPage;
