/**
 * Landing page.
 *
 * Every number on this page comes from /api/public/stats. Where data has not
 * loaded, or is genuinely zero, the page says so — there are no placeholder
 * counts, no fabricated testimonials, no countdown timers and no "27 people
 * viewing" widgets. Scarcity is communicated with the real remaining inventory,
 * which is scarce enough to be interesting on its own.
 */

import { Link } from 'react-router-dom';
import { CELL_LOGICAL_SIZE, TOTAL_CELLS, WALL_LOGICAL_SIZE } from '@shared/constants';
import { formatCents, formatCompact, formatCount, formatRelativeTime } from '../lib/format';
import { usePublicStats, useWallManifest } from '../lib/queries';
import { WallSurface } from '../components/wall/WallSurface';
import { EmptyState } from '../components/primitives';

export function LandingPage(): React.JSX.Element {
  const stats = usePublicStats();
  const manifest = useWallManifest();

  const inventory = stats.data?.inventory;
  const pricing = stats.data?.pricing;
  const activity = stats.data?.activity;

  return (
    <>
      {/* --- hero ------------------------------------------------------------ */}
      <section className="grid-motif grid-motif-fade relative -mx-4 mb-14 px-4 pb-10 pt-6 sm:-mx-6 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan">
          The internet&rsquo;s curated tech wall
        </p>

        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] sm:text-5xl">
          Own a square in the next chapter of the web.
        </h1>

        <p className="mt-5 max-w-2xl text-lg text-ink-muted">
          Claim permanent visual space for your product, portfolio, community or idea &mdash; then
          watch the wall grow.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link to="/wall" className="btn btn-primary no-underline">
            Explore the wall
          </Link>
          <Link to="/claim" className="btn btn-cta no-underline">
            Claim your plot
          </Link>
        </div>

        {/* Honest headline figures, or nothing. */}
        <dl className="mt-10 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
          <Figure
            label="Wall size"
            value={`${WALL_LOGICAL_SIZE} x ${WALL_LOGICAL_SIZE}`}
            detail="1,000,000 pixels"
          />
          <Figure
            label="Units available"
            value={inventory === undefined ? null : formatCount(inventory.availableCells)}
            detail={`of ${formatCount(TOTAL_CELLS)} total`}
          />
          <Figure
            label="Starting price"
            value={pricing === undefined ? null : formatCents(pricing.minimumPurchaseCents)}
            detail={`for ${CELL_LOGICAL_SIZE} x ${CELL_LOGICAL_SIZE} pixels`}
          />
          <Figure
            label="Total page views"
            value={stats.data === undefined ? null : formatCompact(stats.data.totalPageViews)}
            // The label says exactly what is measured. Not "visitors", not
            // "people" — we do not measure those.
            detail="page loads, not people"
          />
        </dl>
      </section>

      {/* --- the wall ------------------------------------------------------- */}
      <section aria-labelledby="wall-heading" className="mb-16">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="wall-heading" className="text-2xl font-semibold">
              The wall, right now
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              Drag to move, scroll to zoom. Every block is a real, paid, approved placement.
            </p>
          </div>
          <Link to="/wall" className="btn btn-ghost no-underline">
            Open full screen
          </Link>
        </div>

        {manifest.isPending ? (
          <div className="grid-motif flex h-96 items-center justify-center rounded-card border border-hairline">
            <p className="text-sm text-ink-subtle" role="status">
              Loading the wall…
            </p>
          </div>
        ) : manifest.isError ? (
          <EmptyState title="We could not load the wall">
            {manifest.error.message} Reload the page, or <Link to="/contact">let us know</Link> if
            it keeps happening.
          </EmptyState>
        ) : manifest.data !== undefined ? (
          <WallSurface
            manifest={manifest.data}
            mode="browse"
            selection={null}
            heightClass="h-[min(60vh,520px)]"
          />
        ) : null}
      </section>

      {/* --- how it works --------------------------------------------------- */}
      <section aria-labelledby="how-heading" className="mb-16">
        <h2 id="how-heading" className="text-2xl font-semibold">
          Three steps, then it is yours
        </h2>

        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          <Step
            number={1}
            title="Choose"
            body="Drag a rectangle anywhere that is still free. You see the exact size and the exact price in US dollars before anything is held."
          />
          <Step
            number={2}
            title="Preview"
            body="Upload your artwork, add a title and your link, and see precisely how it will sit on the wall. Your units are held while you work."
          />
          <Step
            number={3}
            title="Pay"
            body="Pay once through Stripe. A person reviews every placement against our content policy before it goes live, usually within one business day."
          />
        </ol>

        <p className="mt-5 max-w-2xl text-sm text-ink-subtle">
          No subscription and no renewal. One payment, and the plot stays yours. You can update your
          artwork and link later; changes go back through review.
        </p>
      </section>

      {/* --- recently claimed ---------------------------------------------- */}
      <section aria-labelledby="recent-heading" className="mb-16">
        <h2 id="recent-heading" className="text-2xl font-semibold">
          Recently claimed
        </h2>

        {stats.data === undefined ? (
          <p className="mt-4 text-sm text-ink-subtle" role="status">
            Loading…
          </p>
        ) : stats.data.recentlyClaimed.length === 0 ? (
          <EmptyState
            title="Nothing has been claimed yet"
            action={
              <Link to="/claim" className="btn btn-cta mt-2 no-underline">
                Be the first
              </Link>
            }
          >
            The wall is brand new. The first hundred buyers to complete a purchase get a founding
            buyer badge, and that count is taken from settled payments, not from a marketing list.
          </EmptyState>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stats.data.recentlyClaimed.map((entry) => (
              <li
                key={`${entry.x}-${entry.y}-${entry.activatedAt}`}
                className="glass flex items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{entry.title}</p>
                  <p className="tabular mt-0.5 text-xs text-ink-subtle">
                    {entry.w * CELL_LOGICAL_SIZE} x {entry.h * CELL_LOGICAL_SIZE} px at{' '}
                    {entry.x * CELL_LOGICAL_SIZE},{entry.y * CELL_LOGICAL_SIZE}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-ink-subtle">
                  {formatRelativeTime(entry.activatedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- honest social proof ------------------------------------------- */}
      {activity !== undefined && activity.settledPurchases > 0 && (
        <section aria-labelledby="proof-heading" className="mb-16">
          <h2 id="proof-heading" className="text-2xl font-semibold">
            Where things stand
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Counted from settled payments. Refunded, disputed and test transactions are excluded.
          </p>

          <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Completed purchases" value={formatCount(activity.settledPurchases)} />
            <StatCard label="Distinct owners" value={formatCount(activity.distinctOwners)} />
            <StatCard
              label="Outbound clicks (30 days)"
              value={formatCount(activity.outboundClicks30d)}
            />
            <StatCard
              label="Founding badges left"
              value={formatCount(activity.foundingBuyersRemaining)}
            />
          </dl>

          <p className="mt-4">
            <Link to="/stats" className="text-sm">
              See the full statistics and how each number is measured
            </Link>
          </p>
        </section>
      )}

      {/* --- closing CTA --------------------------------------------------- */}
      <section className="glass flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Ready to claim your square?</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Minimum purchase is {CELL_LOGICAL_SIZE} x {CELL_LOGICAL_SIZE} pixels
            {pricing !== undefined ? ` for ${formatCents(pricing.minimumPurchaseCents)}` : ''}. Paid
            once, in US dollars.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/pricing" className="btn btn-ghost no-underline">
            See pricing
          </Link>
          <Link to="/claim" className="btn btn-cta no-underline">
            Claim your plot
          </Link>
        </div>
      </section>
    </>
  );
}

function Figure({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | null;
  detail: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.08em] text-ink-subtle">{label}</dt>
      <dd className="tabular mt-1 text-xl font-semibold text-ink">
        {/* A dash, never a fabricated number, while data is unavailable. */}
        {value ?? <span className="text-ink-subtle">&mdash;</span>}
      </dd>
      <dd className="text-xs text-ink-subtle">{detail}</dd>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="glass p-4">
      <dt className="text-xs uppercase tracking-[0.08em] text-ink-subtle">{label}</dt>
      <dd className="tabular mt-1.5 text-2xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

function Step({
  number,
  title,
  body,
}: {
  number: number;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <li className="glass p-5">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="tabular flex h-7 w-7 items-center justify-center rounded-md border border-cyan/40 bg-cyan/10 text-sm font-semibold text-cyan"
        >
          {number}
        </span>
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      <p className="mt-3 text-sm text-ink-muted">{body}</p>
    </li>
  );
}

export default LandingPage;
