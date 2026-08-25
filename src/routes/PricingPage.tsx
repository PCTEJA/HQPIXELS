/**
 * Pricing information.
 *
 * Every number on this page comes from the server's pricing table and is
 * computed with the shared pricing engine. The client preview matches what
 * the server will quote exactly, and any disagreement between the two is
 * rejected at reservation time.
 */

import { Link } from 'react-router-dom';
import { CELL_LOGICAL_SIZE, LOGICAL_PIXELS_PER_CELL } from '@shared/constants';
import { computeQuote, type PricingVersion } from '@shared/pricing';
import { usePricing } from '../lib/queries';
import { formatCents } from '../lib/format';
import { Alert, EmptyState } from '../components/primitives';

export function PricingPage(): React.JSX.Element {
  const pricing = usePricing();

  if (pricing.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading pricing information&hellip;
      </p>
    );
  }

  if (pricing.isError) {
    return <EmptyState title="Pricing is unavailable">{pricing.error.message}</EmptyState>;
  }

  const data = pricing.data;
  if (data === undefined) return <></>;

  // Build a compatible PricingVersion for computeQuote
  const pricingVersion: PricingVersion = {
    version: data.version,
    currency: data.currency,
    centsPerLogicalPixel: data.centsPerLogicalPixel,
    zoneMultipliers: data.zoneMultipliers,
    minCells: data.minCells,
    maxCells: data.maxCells,
    reservationTtlSeconds: data.reservationTtlSeconds,
  };

  // Example quotes
  const exampleOne = computeQuote(pricingVersion, { x: 0, y: 0, w: 1, h: 1 });
  const example5x5 = computeQuote(pricingVersion, { x: 0, y: 0, w: 5, h: 5 });
  const example10x10 = computeQuote(pricingVersion, { x: 0, y: 0, w: 10, h: 10 });

  const minimumCents = data.centsPerLogicalPixel * LOGICAL_PIXELS_PER_CELL * data.minCells;
  const holdMinutes = Math.floor(data.reservationTtlSeconds / 60);

  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-semibold">Pricing</h1>
      <p className="mt-2 text-ink-muted">
        All prices are in US dollars. Each unit is {CELL_LOGICAL_SIZE}&times;{CELL_LOGICAL_SIZE}{' '}
        logical pixels ({LOGICAL_PIXELS_PER_CELL} pixels total).
      </p>

      {/* --- base price --------------------------------------------------- */}
      <section aria-labelledby="base-heading" className="mt-10">
        <h2 id="base-heading" className="text-xl font-semibold">
          Base price
        </h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-hairline bg-surface-raised p-4">
            <dt className="text-sm text-ink-muted">Per logical pixel</dt>
            <dd className="mt-1 text-2xl font-semibold tabular">
              {formatCents(data.centsPerLogicalPixel)}
            </dd>
          </div>
          <div className="rounded-lg border border-hairline bg-surface-raised p-4">
            <dt className="text-sm text-ink-muted">Minimum purchase (1 unit)</dt>
            <dd className="mt-1 text-2xl font-semibold tabular">{formatCents(minimumCents)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-ink-subtle">
          Pricing version {data.version}. The minimum purchase is {data.minCells} unit
          {data.minCells !== 1 ? 's' : ''}, and a single reservation can cover up to{' '}
          {data.maxCells.toLocaleString()} units.
        </p>
      </section>

      {/* --- examples ----------------------------------------------------- */}
      <section aria-labelledby="examples-heading" className="mt-10">
        <h2 id="examples-heading" className="text-xl font-semibold">
          Worked examples
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          These are computed with the same pricing engine the server uses.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-hairline">
                <th className="py-2 pr-4 font-medium">Selection</th>
                <th className="py-2 pr-4 font-medium text-right">Units</th>
                <th className="py-2 pr-4 font-medium text-right">Logical pixels</th>
                <th className="py-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody className="text-ink-muted">
              <tr className="border-b border-hairline">
                <td className="py-2 pr-4">1 &times; 1</td>
                <td className="py-2 pr-4 text-right tabular">{exampleOne.cells}</td>
                <td className="py-2 pr-4 text-right tabular">
                  {exampleOne.logicalPixels.toLocaleString()}
                </td>
                <td className="py-2 text-right font-semibold tabular text-ink">
                  {formatCents(exampleOne.totalCents)}
                </td>
              </tr>
              <tr className="border-b border-hairline">
                <td className="py-2 pr-4">5 &times; 5</td>
                <td className="py-2 pr-4 text-right tabular">{example5x5.cells}</td>
                <td className="py-2 pr-4 text-right tabular">
                  {example5x5.logicalPixels.toLocaleString()}
                </td>
                <td className="py-2 text-right font-semibold tabular text-ink">
                  {formatCents(example5x5.totalCents)}
                </td>
              </tr>
              <tr className="border-b border-hairline">
                <td className="py-2 pr-4">10 &times; 10</td>
                <td className="py-2 pr-4 text-right tabular">{example10x10.cells}</td>
                <td className="py-2 pr-4 text-right tabular">
                  {example10x10.logicalPixels.toLocaleString()}
                </td>
                <td className="py-2 text-right font-semibold tabular text-ink">
                  {formatCents(example10x10.totalCents)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* --- zone multipliers --------------------------------------------- */}
      {data.zoneMultipliers.length > 0 && (
        <section aria-labelledby="zones-heading" className="mt-10">
          <h2 id="zones-heading" className="text-xl font-semibold">
            Zone multipliers
          </h2>
          <p className="mt-2 text-sm text-ink-muted">
            Certain regions of the wall have a price modifier. If your selection overlaps a zone,
            those cells are priced at the zone rate; any cells outside are priced at the base rate.
            Multiple zones stack additively if they overlap.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline">
                  <th className="py-2 pr-4 font-medium">Zone</th>
                  <th className="py-2 pr-4 font-medium">Region</th>
                  <th className="py-2 font-medium text-right">Multiplier</th>
                </tr>
              </thead>
              <tbody className="text-ink-muted">
                {data.zoneMultipliers.map((zone, idx) => (
                  <tr key={idx} className="border-b border-hairline">
                    <td className="py-2 pr-4">{zone.label}</td>
                    <td className="py-2 pr-4 tabular">
                      ({zone.x}, {zone.y}) &ndash; ({zone.x + zone.w - 1}, {zone.y + zone.h - 1})
                    </td>
                    <td className="py-2 text-right tabular">
                      {(zone.multiplierBp / 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* --- how it works ------------------------------------------------- */}
      <section aria-labelledby="how-heading" className="mt-10">
        <h2 id="how-heading" className="text-xl font-semibold">
          How reservations work
        </h2>
        <ul className="mt-4 list-inside list-disc space-y-2 text-sm text-ink-muted">
          <li>
            When you select cells and click &ldquo;Reserve&rdquo;, the server creates a reservation
            that holds those cells for <strong>{holdMinutes} minutes</strong>.
          </li>
          <li>
            The quoted total is locked at the moment of reservation. Price changes after that point
            do not affect your hold.
          </li>
          <li>
            The client preview and the server quote use the same pricing engine. If they ever
            disagree (for example, due to a version mismatch), the server rejects the reservation
            and asks you to refresh.
          </li>
          <li>
            If you do not complete checkout within the hold period, the cells are released
            automatically. You are never charged for an expired hold.
          </li>
        </ul>
      </section>

      {/* --- call to action ---------------------------------------------- */}
      <div className="mt-12">
        <Alert tone="info" title="Ready to claim your space?">
          <p className="mt-1 text-sm">
            Head to the wall, select your region, and we will show you the exact price before you
            commit.
          </p>
          <Link to="/claim" className="btn btn-cta mt-4 inline-block no-underline">
            Start claiming
          </Link>
        </Alert>
      </div>
    </div>
  );
}

export default PricingPage;
