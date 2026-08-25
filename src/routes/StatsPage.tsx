/**
 * Public statistics.
 *
 * The defining feature of this page is that every number states what it actually
 * measures, next to the number. "Total page views" is labelled as page loads and
 * never as visitors or people. Counter lag is disclosed. Excluded transactions
 * are named. If a figure is not measured, it is not shown.
 */

import { Link } from 'react-router-dom';
import { CELL_LOGICAL_SIZE, TOTAL_CELLS, TOTAL_LOGICAL_PIXELS } from '@shared/constants';
import { usePublicStats } from '../lib/queries';
import { formatBasisPoints, formatCents, formatCount, formatDateTime } from '../lib/format';
import { Alert, EmptyState } from '../components/primitives';

export function StatsPage(): React.JSX.Element {
  const stats = usePublicStats();

  if (stats.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading statistics…
      </p>
    );
  }

  if (stats.isError) {
    return <EmptyState title="Statistics are unavailable">{stats.error.message}</EmptyState>;
  }

  const data = stats.data;
  if (data === undefined) return <></>;

  return (
    <div>
      <h1 className="text-3xl font-semibold">Statistics</h1>
      <p className="mt-2 max-w-2xl text-ink-muted">
        Everything on this page is measured, not estimated for marketing. Each figure says exactly
        what it counts and what it excludes.
      </p>

      {/* --- inventory ------------------------------------------------------ */}
      <section aria-labelledby="inventory-heading" className="mt-10">
        <h2 id="inventory-heading" className="text-xl font-semibold">
          Inventory
        </h2>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Units claimed"
            value={formatCount(data.inventory.claimedCells)}
            note={`of ${formatCount(TOTAL_CELLS)} units on the wall`}
          />
          <Stat
            label="Units available"
            value={formatCount(data.inventory.availableCells)}
            note={`each ${CELL_LOGICAL_SIZE} x ${CELL_LOGICAL_SIZE} pixels`}
          />
          <Stat
            label="Percentage sold"
            value={formatBasisPoints(data.inventory.percentSoldBp)}
            note="claimed units divided by total units"
          />
          <Stat
            label="Pixels claimed"
            value={formatCount(data.inventory.claimedLogicalPixels)}
            note={`of ${formatCount(TOTAL_LOGICAL_PIXELS)} logical pixels`}
          />
        </dl>

        <div className="mt-5">
          <div
            role="meter"
            aria-valuenow={data.inventory.claimedCells}
            aria-valuemin={0}
            aria-valuemax={data.inventory.totalCells}
            aria-label="Units claimed"
            className="h-3 overflow-hidden rounded-full border border-hairline bg-surface-sunken"
          >
            <div
              className="h-full bg-cyan"
              style={{
                // Integer basis points from the server, so no float arithmetic
                // and no rounding disagreement with the printed percentage.
                width: `${data.inventory.percentSoldBp / 100}%`,
              }}
            />
          </div>
        </div>
      </section>

      {/* --- traffic -------------------------------------------------------- */}
      <section aria-labelledby="traffic-heading" className="mt-12">
        <h2 id="traffic-heading" className="text-xl font-semibold">
          Traffic
        </h2>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Stat
            label="Total page views"
            value={formatCount(data.totalPageViews)}
            // The honest definition, right next to the number.
            note="Successful page loads reported by browsers, after bot filtering and per-visitor rate limiting. This is NOT unique visitors and NOT a count of people."
          />
          <Stat
            label="Outbound clicks (last 30 days)"
            value={formatCount(data.activity.outboundClicks30d)}
            note="Clicks through hqpixels.com/go that passed our duplicate and bot filters. Repeat clicks from the same visitor inside a five-minute window are excluded."
          />
        </dl>

        <Alert tone="info" className="mt-4" title="How current these numbers are">
          Counters are aggregated in five-minute buckets and flushed in batches, so they can lag by
          up to {data.countersLagSeconds} seconds. We do this deliberately: writing to the database
          on every page view would not survive a traffic spike.
        </Alert>
      </section>

      {/* --- purchases ------------------------------------------------------ */}
      <section aria-labelledby="purchases-heading" className="mt-12">
        <h2 id="purchases-heading" className="text-xl font-semibold">
          Purchases
        </h2>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat
            label="Completed purchases"
            value={formatCount(data.activity.settledPurchases)}
            note="Payments that settled with Stripe. Failed, refunded, disputed and test-mode payments are excluded."
          />
          <Stat
            label="Distinct owners"
            value={formatCount(data.activity.distinctOwners)}
            note="Accounts with at least one live placement."
          />
          <Stat
            label="Founding badges remaining"
            value={formatCount(data.activity.foundingBuyersRemaining)}
            note="Awarded to the first 100 accounts whose payment settles. Assigned from the payment ledger, in order, and cannot be granted manually."
          />
        </dl>
      </section>

      {/* --- pricing -------------------------------------------------------- */}
      <section aria-labelledby="pricing-heading" className="mt-12">
        <h2 id="pricing-heading" className="text-xl font-semibold">
          Current pricing
        </h2>

        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <Stat
            label="Price per pixel"
            value={formatCents(data.pricing.centsPerLogicalPixel)}
            note="US dollars, per logical pixel"
          />
          <Stat
            label="Minimum purchase"
            value={formatCents(data.pricing.minimumPurchaseCents)}
            note={`one ${CELL_LOGICAL_SIZE} x ${CELL_LOGICAL_SIZE} pixel unit`}
          />
          <Stat
            label="Price version"
            value={String(data.pricing.version)}
            note="Prices are versioned. A reservation locks the version it was quoted under."
          />
        </dl>

        <p className="mt-4 text-sm text-ink-muted">
          <Link to="/pricing">See the full pricing page</Link> for how zone multipliers work and
          what happens if pricing changes while you are mid-purchase.
        </p>
      </section>

      {/* --- what we do not measure ---------------------------------------- */}
      <section aria-labelledby="not-measured-heading" className="mt-12">
        <h2 id="not-measured-heading" className="text-xl font-semibold">
          What we do not publish
        </h2>
        <ul className="mt-3 max-w-2xl list-disc space-y-2 pl-5 text-sm text-ink-muted">
          <li>
            <strong>Unique visitors.</strong> We do not build long-lived visitor profiles, so we
            genuinely cannot count them. We would rather publish nothing than publish a guess.
          </li>
          <li>
            <strong>People viewing right now.</strong> We do not track live sessions. A widget
            claiming otherwise would be theatre.
          </li>
          <li>
            <strong>Revenue.</strong> Not published, for the same reason we do not publish buyer
            emails: it is not ours to share.
          </li>
          <li>
            <strong>Per-placement click counts.</strong> Visible to the owner on their dashboard,
            and in aggregate on the rankings. Not exposed per placement publicly, because that is
            competitive information belonging to the buyer.
          </li>
        </ul>
      </section>

      <p className="mt-10 text-xs text-ink-subtle">
        Generated {formatDateTime(data.generatedAt)}. This page is cached at the edge for up to a
        minute.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}): React.JSX.Element {
  return (
    <div className="glass p-4">
      <dt className="text-xs uppercase tracking-[0.08em] text-ink-subtle">{label}</dt>
      <dd className="tabular mt-1.5 text-2xl font-semibold text-ink">{value}</dd>
      <dd className="mt-2 text-xs leading-relaxed text-ink-subtle">{note}</dd>
    </div>
  );
}

export default StatsPage;
