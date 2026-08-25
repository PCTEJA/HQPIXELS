/**
 * The wall, assembled: toolbar, canvas, keyboard layer, hover card, and the
 * accessible list.
 *
 * The keyboard layer is the important part. The canvas is `aria-hidden`, so this
 * component provides a real focusable element with a documented key map, and
 * every action available by mouse is available by keyboard:
 *
 *   arrows          move the cursor one unit (Shift: ten units)
 *   Shift+arrows    extend the selection
 *   Enter / Space   select the cursor cell, or open the placement under it
 *   Escape          clear the selection
 *   + / -           zoom
 *   0               fit the whole wall
 *   Home / End      jump to the first/last column of the row
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ManifestPlacement, WallManifest } from '@shared/api-types';
import { CELL_LOGICAL_SIZE, GRID_SIZE, OUTBOUND_LINK_REL } from '@shared/constants';
import { decodeOccupancy, isCellTaken } from '@shared/occupancy';
import { Badge, Button, LiveRegion } from '../primitives';
import { useAnnouncer, useElementSize } from '../../lib/hooks';
import { formatCount, formatHost, formatRectPixels } from '../../lib/format';
import { WallAccessibleList } from './WallAccessibleList';
import { getWallControls } from './WallCanvas';
import { rectFromDrag } from './viewport';
import { beacon } from '../../lib/api';

const WallCanvas = lazy(() => import('./WallCanvas'));

export interface WallSurfaceProps {
  readonly manifest: WallManifest;
  readonly mode: 'browse' | 'select';
  readonly selection: { x: number; y: number; w: number; h: number } | null;
  readonly onSelectionChange?: (
    rect: { x: number; y: number; w: number; h: number } | null,
  ) => void;
  readonly focusPlacementId?: string | null;
  /** Rendered below the toolbar, e.g. the claim wizard's selection summary. */
  readonly sidePanel?: React.ReactNode;
  readonly heightClass?: string;
}

export function WallSurface({
  manifest,
  mode,
  selection,
  onSelectionChange,
  focusPlacementId,
  sidePanel,
  heightClass = 'h-[min(70vh,640px)]',
}: WallSurfaceProps): React.JSX.Element {
  const { ref: sizeRef, width, height } = useElementSize<HTMLDivElement>();
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState<ManifestPlacement | null>(null);
  const [selected, setSelected] = useState<ManifestPlacement | null>(null);
  const [scale, setScale] = useState(0.5);
  const { message, announce } = useAnnouncer();

  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const occupancy = useRef<Uint8Array>(decodeOccupancy(manifest.occupancyBitmap));
  occupancy.current = decodeOccupancy(manifest.occupancyBitmap);

  const controls = () => getWallControls('wall');

  // --- impression reporting ---------------------------------------------------
  // Batched and debounced: one call per second at most, and only for placements
  // actually on screen. Labelled an estimate everywhere it is shown.
  const visibleRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const ids = visibleRef.current;
      if (ids.length === 0) return;
      beacon('/api/public/impressions', { placementIds: ids.slice(0, 200) });
      visibleRef.current = [];
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  // --- keyboard --------------------------------------------------------------
  const moveCursor = useCallback(
    (dx: number, dy: number, extend: boolean) => {
      const current = cursor ?? { x: 0, y: 0 };
      const next = {
        x: Math.min(Math.max(current.x + dx, 0), GRID_SIZE - 1),
        y: Math.min(Math.max(current.y + dy, 0), GRID_SIZE - 1),
      };

      setCursor(next);
      controls()?.revealCell(next);

      if (extend && mode === 'select' && onSelectionChange !== undefined) {
        const anchor = anchorRef.current ?? current;
        anchorRef.current = anchor;
        const rect = rectFromDrag(anchor, next);
        onSelectionChange(rect);
        announce(
          `Selection ${rect.w} by ${rect.h} units, ${formatRectPixels(rect)}, ${
            isRectFree(occupancy.current, rect) ? 'available' : 'partly unavailable'
          }.`,
        );
        return;
      }

      anchorRef.current = null;

      const placement = placementAt(manifest.placements, next);
      announce(
        placement !== null
          ? `Column ${next.x + 1}, row ${next.y + 1}. ${placement.title}, by ${
              placement.owner ?? 'anonymous'
            }, links to ${placement.host}.`
          : `Column ${next.x + 1}, row ${next.y + 1}. ${
              isCellTaken(occupancy.current, next.x, next.y) ? 'Claimed.' : 'Available.'
            }`,
      );
    },
    [cursor, mode, onSelectionChange, announce, manifest.placements],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.shiftKey && !isArrow(event.key) ? 1 : event.ctrlKey || event.metaKey ? 10 : 1;
    const bigStep = event.altKey ? 10 : step;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveCursor(-bigStep, 0, event.shiftKey);
        return;
      case 'ArrowRight':
        event.preventDefault();
        moveCursor(bigStep, 0, event.shiftKey);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveCursor(0, -bigStep, event.shiftKey);
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveCursor(0, bigStep, event.shiftKey);
        return;

      case 'Home':
        event.preventDefault();
        moveCursor(-GRID_SIZE, 0, event.shiftKey);
        return;
      case 'End':
        event.preventDefault();
        moveCursor(GRID_SIZE, 0, event.shiftKey);
        return;

      case 'Enter':
      case ' ': {
        event.preventDefault();
        const cell = cursor ?? { x: 0, y: 0 };
        const placement = placementAt(manifest.placements, cell);

        if (placement !== null) {
          setSelected(placement);
          announce(`Opened details for ${placement.title}.`);
          return;
        }
        if (mode === 'select' && onSelectionChange !== undefined) {
          anchorRef.current = cell;
          onSelectionChange({ x: cell.x, y: cell.y, w: 1, h: 1 });
          announce(
            `Selected one unit at column ${cell.x + 1}, row ${cell.y + 1}. ` +
              'Hold Shift with the arrow keys to select more.',
          );
        }
        return;
      }

      case 'Escape':
        if (selection !== null && onSelectionChange !== undefined) {
          event.preventDefault();
          onSelectionChange(null);
          anchorRef.current = null;
          announce('Selection cleared.');
        }
        return;

      case '+':
      case '=':
        event.preventDefault();
        controls()?.zoomIn();
        return;
      case '-':
      case '_':
        event.preventDefault();
        controls()?.zoomOut();
        return;
      case '0':
        event.preventDefault();
        controls()?.reset();
        announce('Zoomed out to show the whole wall.');
        return;
      default:
        return;
    }
  };

  const claimed = manifest.counts.claimedCells;
  const available = manifest.counts.availableCells;

  return (
    <section aria-label="The HQPixels wall">
      {/* --- toolbar --------------------------------------------------------- */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          className="flex items-center gap-1 rounded-control border border-hairline bg-surface p-1"
          role="group"
          aria-label="Zoom controls"
        >
          <Button
            variant="ghost"
            className="min-h-9 px-2.5 py-1"
            onClick={() => controls()?.zoomOut()}
          >
            <span aria-hidden="true">-</span>
            <span className="sr-only">Zoom out</span>
          </Button>
          <span className="tabular w-14 text-center text-xs text-ink-subtle" aria-live="off">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            className="min-h-9 px-2.5 py-1"
            onClick={() => controls()?.zoomIn()}
          >
            <span aria-hidden="true">+</span>
            <span className="sr-only">Zoom in</span>
          </Button>
          <Button
            variant="ghost"
            className="min-h-9 px-2.5 py-1 text-xs"
            onClick={() => {
              controls()?.reset();
              announce('Zoomed out to show the whole wall.');
            }}
          >
            Fit
          </Button>
        </div>

        <p className="tabular text-sm text-ink-muted">
          {formatCount(claimed)} claimed &middot; {formatCount(available)} available
        </p>

        {selection !== null && (
          <p className="tabular ml-auto text-sm text-cyan">
            {selection.w} x {selection.h} units ({formatRectPixels(selection)})
          </p>
        )}
      </div>

      {/* --- canvas + keyboard layer ---------------------------------------- */}
      <div
        className={`relative overflow-hidden rounded-card border border-hairline ${heightClass}`}
      >
        <div ref={sizeRef} className="absolute inset-0">
          {width > 0 && height > 0 && (
            <Suspense
              fallback={
                <div
                  className="grid-motif flex h-full items-center justify-center"
                  role="status"
                  aria-label="Loading the wall"
                >
                  <p className="text-sm text-ink-subtle">Loading the wall…</p>
                </div>
              }
            >
              <WallCanvas
                controlsKey="wall"
                manifest={manifest}
                width={width}
                height={height}
                mode={mode}
                selection={selection}
                {...(onSelectionChange !== undefined ? { onSelectionChange } : {})}
                cursor={cursor}
                onCursorChange={setCursor}
                onHoverChange={setHovered}
                onPlacementActivate={setSelected}
                focusPlacementId={focusPlacementId ?? null}
                onViewportChange={(viewport) => setScale(viewport.scale)}
                onVisiblePlacements={(ids) => {
                  visibleRef.current = ids;
                }}
              />
            </Suspense>
          )}
        </div>

        {/*
          The focusable keyboard surface. Sits over the canvas, has no background,
          and carries the accessible name and instructions the canvas cannot.
        */}
        <div
          role="application"
          aria-label={
            mode === 'select'
              ? 'Pixel wall, selection mode. Use the arrow keys to move, hold Shift and press an arrow key to select an area, then press Enter.'
              : 'Pixel wall. Use the arrow keys to move between units and press Enter to open a placement.'
          }
          aria-describedby="wall-keyboard-help"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="absolute inset-0 outline-offset-[-3px]"
        />

        {/* --- hover card --------------------------------------------------- */}
        {hovered !== null && (
          <div className="glass-raised pointer-events-none absolute bottom-3 left-3 max-w-xs p-3">
            <p className="truncate text-sm font-semibold text-ink">{hovered.title}</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {hovered.w * CELL_LOGICAL_SIZE} x {hovered.h * CELL_LOGICAL_SIZE} pixels &middot;{' '}
              {hovered.owner ?? 'Anonymous'}
            </p>
            <p className="tabular mt-1 truncate text-xs text-cyan">{formatHost(hovered.host)}</p>
            <div className="mt-2 flex gap-1.5">
              <Badge tone="verified">Paid &amp; approved</Badge>
              {hovered.foundingBuyer && <Badge tone="founding">Founding buyer</Badge>}
            </div>
          </div>
        )}
      </div>

      <p id="wall-keyboard-help" className="mt-2 text-xs text-ink-subtle">
        Drag to {mode === 'select' ? 'select' : 'pan'}, scroll or pinch to zoom. With the wall
        focused: arrow keys move, Shift with an arrow key selects an area, Enter opens or selects,
        Escape clears, plus and minus zoom, 0 fits the whole wall.
      </p>

      <LiveRegion message={message} />

      {sidePanel}

      {/* --- selected placement ------------------------------------------- */}
      {selected !== null && (
        <div className="glass mt-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold">{selected.title}</h3>
              <p className="mt-1 text-sm text-ink-muted">{selected.altText}</p>
              <p className="mt-2 text-sm text-ink-subtle">
                {formatRectPixels(selected)} at grid {selected.x * CELL_LOGICAL_SIZE},
                {selected.y * CELL_LOGICAL_SIZE} &middot; owned by{' '}
                {selected.owner ?? 'an anonymous buyer'}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone="verified">Paid &amp; approved</Badge>
                <Badge tone="sponsored">Paid placement</Badge>
                {selected.foundingBuyer && <Badge tone="founding">Founding buyer</Badge>}
              </div>
            </div>

            <div className="flex flex-col items-stretch gap-2">
              {/* Shows the hostname before the visitor leaves, so nobody clicks
                  through to a domain they did not expect. */}
              <a
                href={`/go/${selected.id}`}
                rel={OUTBOUND_LINK_REL}
                target="_blank"
                className="btn btn-primary no-underline"
              >
                Visit {formatHost(selected.host, 24)}
              </a>
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* --- accessible equivalent ---------------------------------------- */}
      <details className="mt-6">
        <summary className="cursor-pointer text-sm font-medium text-cyan">
          Browse all placements as a list ({formatCount(manifest.placements.length)})
        </summary>
        <div className="mt-4">
          <WallAccessibleList
            placements={manifest.placements}
            highlightId={focusPlacementId ?? null}
            onFocusPlacement={(placement) => {
              controls()?.focusRect(placement);
              setSelected(placement);
              setCursor({ x: placement.x, y: placement.y });
              announce(`Showing ${placement.title} on the wall.`);
            }}
          />
        </div>
      </details>
    </section>
  );
}

function placementAt(
  placements: readonly ManifestPlacement[],
  cell: { x: number; y: number },
): ManifestPlacement | null {
  for (const placement of placements) {
    if (
      cell.x >= placement.x &&
      cell.x < placement.x + placement.w &&
      cell.y >= placement.y &&
      cell.y < placement.y + placement.h
    ) {
      return placement;
    }
  }
  return null;
}

function isRectFree(
  bitmap: Uint8Array,
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (isCellTaken(bitmap, x, y)) return false;
    }
  }
  return true;
}

function isArrow(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}
