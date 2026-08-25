/**
 * The non-canvas view of the wall.
 *
 * This is not a fallback bolted on at the end — it is a first-class equivalent.
 * A canvas is opaque to assistive technology, so every placement is also a real
 * table row with a real link, and the claim flow is reachable entirely from the
 * keyboard without touching the canvas.
 *
 * All buyer-supplied text renders as React text nodes. There is no
 * `dangerouslySetInnerHTML` anywhere in this project and lint forbids it.
 */

import { useMemo, useState } from 'react';
import type { ManifestPlacement } from '@shared/api-types';
import { CELL_LOGICAL_SIZE } from '@shared/constants';
import { OUTBOUND_LINK_REL } from '@shared/constants';
import { formatCount, formatHost, formatRelativeTime } from '../../lib/format';
import { Badge, EmptyState } from '../primitives';

export interface WallAccessibleListProps {
  readonly placements: readonly ManifestPlacement[];
  readonly onFocusPlacement?: (placement: ManifestPlacement) => void;
  readonly highlightId?: string | null;
}

type SortKey = 'position' | 'size' | 'newest' | 'owner';

export function WallAccessibleList({
  placements,
  onFocusPlacement,
  highlightId,
}: WallAccessibleListProps): React.JSX.Element {
  const [sort, setSort] = useState<SortKey>('newest');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const normalisedQuery = query.trim().toLowerCase();

    const filtered =
      normalisedQuery === ''
        ? [...placements]
        : placements.filter(
            (placement) =>
              placement.title.toLowerCase().includes(normalisedQuery) ||
              placement.host.toLowerCase().includes(normalisedQuery) ||
              (placement.owner ?? '').toLowerCase().includes(normalisedQuery),
          );

    switch (sort) {
      case 'position':
        return filtered.sort((a, b) => a.y - b.y || a.x - b.x);
      case 'size':
        return filtered.sort((a, b) => b.w * b.h - a.w * a.h);
      case 'owner':
        return filtered.sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? ''));
      case 'newest':
      default:
        return filtered.sort(
          (a, b) => new Date(b.activatedAt).getTime() - new Date(a.activatedAt).getTime(),
        );
    }
  }, [placements, sort, query]);

  if (placements.length === 0) {
    return (
      <EmptyState title="No placements on the wall yet">
        Nothing has been claimed and approved so far. This list shows real placements only — we do
        not fill it with examples.
      </EmptyState>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label htmlFor="wall-search" className="field-label">
            Search placements
          </label>
          <input
            id="wall-search"
            type="search"
            className="field-input"
            placeholder="Title, website or owner"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={80}
          />
        </div>

        <div>
          <label htmlFor="wall-sort" className="field-label">
            Sort by
          </label>
          <select
            id="wall-sort"
            className="field-input"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
          >
            <option value="newest">Most recently claimed</option>
            <option value="size">Largest first</option>
            <option value="position">Grid position</option>
            <option value="owner">Owner name</option>
          </select>
        </div>
      </div>

      <p className="mb-3 text-sm text-ink-subtle" role="status">
        Showing {formatCount(rows.length)} of {formatCount(placements.length)} placements.
      </p>

      <div className="scroll-x glass">
        <table className="data-table">
          <caption className="sr-only">
            All live placements on the HQPixels wall, with position, size, owner and destination
            website.
          </caption>
          <thead>
            <tr>
              <th scope="col">Placement</th>
              <th scope="col">Position</th>
              <th scope="col">Size</th>
              <th scope="col">Owner</th>
              <th scope="col">Destination</th>
              <th scope="col">Claimed</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((placement) => (
              <tr
                key={placement.id}
                // aria-current marks the row matching the deep link, so a screen
                // reader lands on the right one.
                aria-current={placement.id === highlightId ? 'true' : undefined}
                className={placement.id === highlightId ? 'bg-cyan/8' : undefined}
              >
                <th scope="row" className="max-w-56 font-medium text-ink">
                  <div className="flex items-center gap-2">
                    {placement.image !== '' && (
                      <img
                        src={placement.image}
                        // Buyer-supplied alt text. Plain text, length-limited and
                        // normalised server-side.
                        alt={placement.altText}
                        width={32}
                        height={32}
                        loading="lazy"
                        decoding="async"
                        className="h-8 w-8 shrink-0 rounded-sm border border-hairline object-contain"
                      />
                    )}
                    <span className="truncate">{placement.title}</span>
                  </div>
                </th>

                <td className="tabular text-ink-muted">
                  {placement.x * CELL_LOGICAL_SIZE}, {placement.y * CELL_LOGICAL_SIZE}
                </td>

                <td className="tabular text-ink-muted">
                  {placement.w * CELL_LOGICAL_SIZE} x {placement.h * CELL_LOGICAL_SIZE}
                </td>

                <td className="text-ink-muted">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span>{placement.owner ?? 'Anonymous'}</span>
                    {placement.foundingBuyer && <Badge tone="founding">Founding</Badge>}
                  </div>
                </td>

                <td>
                  {/*
                    The href goes to our own /go/:id redirect, never to the raw
                    destination. rel="sponsored" is required: these are paid
                    placements. noopener/noreferrer stop window.opener access and
                    referrer leakage.
                  */}
                  <a
                    href={`/go/${placement.id}`}
                    rel={OUTBOUND_LINK_REL}
                    target="_blank"
                    className="tabular text-sm"
                    title={placement.host}
                  >
                    {formatHost(placement.host)}
                  </a>
                  <span className="ml-1.5 align-middle">
                    <Badge tone="sponsored">Ad</Badge>
                  </span>
                </td>

                <td className="whitespace-nowrap text-sm text-ink-subtle">
                  {formatRelativeTime(placement.activatedAt)}
                </td>

                <td>
                  {onFocusPlacement !== undefined && (
                    <button
                      type="button"
                      className="btn btn-ghost min-h-9 px-2.5 py-1 text-xs"
                      onClick={() => onFocusPlacement(placement)}
                    >
                      Show on wall
                      <span className="sr-only">: {placement.title}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="mt-4 text-sm text-ink-muted" role="status">
          No placements match “{query}”.
        </p>
      )}
    </div>
  );
}
