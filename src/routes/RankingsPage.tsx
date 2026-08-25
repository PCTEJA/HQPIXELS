/**
 * Rankings.
 *
 * Four separate boards, each ranked by ONE number with its measurement written
 * next to it. There is deliberately no composite "score": a composite cannot be
 * explained honestly, and an unexplainable ranking is indistinguishable from a
 * rigged one.
 */

import { Link } from 'react-router-dom';
import type { LeaderboardKind } from '@shared/api-types';
import { usePublicRankings } from '../lib/queries';
import { formatCents, formatCount, formatDateTime } from '../lib/format';
import { Badge, EmptyState } from '../components/primitives';

const BOARD_TITLES: Readonly<Record<LeaderboardKind, string>> = {
  largest_owners: 'Largest owners',
  top_supporters: 'Top supporters',
  most_visited: 'Most visited',
  rising: 'Rising',
};

const BOARD_DESCRIPTIONS: Readonly<Record<LeaderboardKind, string>> = {
  largest_owners: 'Who owns the most space on the wall.',
  top_supporters: 'Who has spent the most, net of refunds.',
  most_visited: 'Which placements send the most people onward.',
  rising: 'Which placements are getting attention this week.',
};

interface RawBoard {
  readonly kind: LeaderboardKind;
  readonly computedAt: string;
  readonly payload: {
    readonly entries: ReadonlyArray<{
      rank: number;
      label: string;
      handle: string | null;
      placementId: string | null;
      value: number;
      valueUnit: 'logical_pixels' | 'cents' | 'clicks';
      foundingBuyer: boolean;
    }>;
    readonly methodology: string;
    readonly windowDescription: string;
  };
}

export function RankingsPage(): React.JSX.Element {
  const rankings = usePublicRankings();

  if (rankings.isPending) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading rankings…
      </p>
    );
  }

  if (rankings.isError) {
    return <EmptyState title="Rankings are unavailable">{rankings.error.message}</EmptyState>;
  }

  const boards = (rankings.data?.boards ?? []) as unknown as readonly RawBoard[];

  return (
    <div>
      <h1 className="text-3xl font-semibold">Rankings</h1>
      <p className="mt-2 max-w-2xl text-ink-muted">
        Four boards, four separate measurements. We do not combine them into a single score, because
        a combined score cannot be explained and therefore cannot be trusted.
      </p>

      <p className="mt-4 max-w-2xl text-sm text-ink-subtle">
        Excluded from every board: unpaid holds, refunded purchases, disputed payments, rejected
        placements and anything created in test mode. Rankings are recomputed hourly.
      </p>

      {boards.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="No rankings yet"
            action={
              <Link to="/claim" className="btn btn-cta mt-2 no-underline">
                Claim the first plot
              </Link>
            }
          >
            Nobody has completed a purchase yet, so there is nothing to rank. We would rather show
            an empty board than invent entries.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-8 space-y-10">
          {boards.map((board) => (
            <Board key={board.kind} board={board} />
          ))}
        </div>
      )}

      {rankings.data !== undefined && (
        <p className="mt-10 text-xs text-ink-subtle">
          Generated {formatDateTime(rankings.data.generatedAt)}.
        </p>
      )}
    </div>
  );
}

function Board({ board }: { board: RawBoard }): React.JSX.Element {
  const entries = board.payload.entries;
  const headingId = `board-${board.kind}`;

  return (
    <section aria-labelledby={headingId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-xl font-semibold">
          {BOARD_TITLES[board.kind]}
        </h2>
        <p className="text-xs text-ink-subtle">{board.payload.windowDescription}</p>
      </div>

      <p className="mt-1 text-sm text-ink-muted">{BOARD_DESCRIPTIONS[board.kind]}</p>

      {/* The methodology is rendered, not hidden behind a tooltip. */}
      <p className="mt-2 max-w-2xl rounded-control border border-hairline bg-surface px-3 py-2 text-xs leading-relaxed text-ink-subtle">
        <strong className="text-ink-muted">How this is measured:</strong>{' '}
        {board.payload.methodology}
      </p>

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-ink-subtle">
          Nothing qualifies for this board yet.
          {board.kind === 'rising' &&
            ' A placement needs at least 25 filtered clicks in the window to appear, so a small burst cannot top it.'}
        </p>
      ) : (
        <div className="scroll-x glass mt-4">
          <table className="data-table">
            <caption className="sr-only">
              {BOARD_TITLES[board.kind]}: {board.payload.methodology}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="w-14">
                  Rank
                </th>
                <th scope="col">
                  {board.kind === 'largest_owners' || board.kind === 'top_supporters'
                    ? 'Owner'
                    : 'Placement'}
                </th>
                <th scope="col" className="text-right">
                  {unitHeading(entries[0]?.valueUnit ?? 'clicks')}
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${board.kind}-${entry.rank}`}>
                  <td className="tabular text-ink-subtle">{entry.rank}</td>
                  <td>
                    <div className="flex flex-wrap items-center gap-2">
                      {entry.placementId !== null ? (
                        <Link to={`/wall?focus=${entry.placementId}`} className="font-medium">
                          {entry.label}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">{entry.label}</span>
                      )}
                      {entry.handle !== null && (
                        <span className="tabular text-xs text-ink-subtle">@{entry.handle}</span>
                      )}
                      {entry.foundingBuyer && <Badge tone="founding">Founding</Badge>}
                    </div>
                  </td>
                  <td className="tabular text-right font-medium">
                    {formatValue(entry.value, entry.valueUnit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-xs text-ink-subtle">Updated {formatDateTime(board.computedAt)}.</p>
    </section>
  );
}

function unitHeading(unit: 'logical_pixels' | 'cents' | 'clicks'): string {
  switch (unit) {
    case 'logical_pixels':
      return 'Pixels owned';
    case 'cents':
      return 'Net spend';
    case 'clicks':
      return 'Clicks';
    default:
      return 'Value';
  }
}

function formatValue(value: number, unit: 'logical_pixels' | 'cents' | 'clicks'): string {
  switch (unit) {
    case 'cents':
      return formatCents(value);
    case 'logical_pixels':
    case 'clicks':
    default:
      return formatCount(value);
  }
}

export default RankingsPage;
