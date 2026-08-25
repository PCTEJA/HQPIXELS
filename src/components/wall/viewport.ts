/**
 * Viewport maths for the wall.
 *
 * Pure functions, no PixiJS, no DOM — which is why `tests/unit/viewport.test.ts`
 * can cover the fiddly parts (clamping, zoom-to-cursor, cell hit testing)
 * without a browser.
 *
 * Coordinate spaces:
 *   world  — logical pixels, 0..1000 on both axes. What the buyer buys.
 *   cell   — purchasable units, 0..99. world / 10.
 *   screen — CSS pixels inside the canvas element.
 *
 * screen = (world - offset) * scale
 * world  = screen / scale + offset
 */

import { CELL_LOGICAL_SIZE, GRID_SIZE, WALL_LOGICAL_SIZE } from '@shared/constants';

export interface Viewport {
  /** World coordinate at the canvas's top-left corner. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Screen pixels per world pixel. */
  readonly scale: number;
}

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Zoom limits.
 *
 * MIN is computed per canvas so the whole wall always fits; MAX is 8 screen
 * pixels per world pixel, at which one purchasable unit is 80px — big enough to
 * tap comfortably and to see the artwork, without letting someone zoom into a
 * meaningless blur.
 */
export const MAX_SCALE = 8;

export function minScaleFor(canvas: CanvasSize): number {
  if (canvas.width <= 0 || canvas.height <= 0) return 0.1;
  // Fit the whole wall with a small margin so it does not touch the edges.
  return Math.min(canvas.width / WALL_LOGICAL_SIZE, canvas.height / WALL_LOGICAL_SIZE) * 0.94;
}

/** The viewport that shows the entire wall, centred. */
export function fitViewport(canvas: CanvasSize): Viewport {
  const scale = minScaleFor(canvas);
  return {
    scale,
    offsetX: (WALL_LOGICAL_SIZE - canvas.width / scale) / 2,
    offsetY: (WALL_LOGICAL_SIZE - canvas.height / scale) / 2,
  };
}

/**
 * Keep the wall on screen.
 *
 * When the wall is smaller than the canvas (zoomed out), it is centred. When it
 * is larger, panning is clamped so you can never scroll the wall entirely out of
 * view — the single most disorienting thing an unclamped pan-zoom canvas does.
 */
export function clampViewport(viewport: Viewport, canvas: CanvasSize): Viewport {
  const minScale = minScaleFor(canvas);
  const scale = Math.min(Math.max(viewport.scale, minScale), MAX_SCALE);

  const visibleWorldWidth = canvas.width / scale;
  const visibleWorldHeight = canvas.height / scale;

  let offsetX: number;
  let offsetY: number;

  if (visibleWorldWidth >= WALL_LOGICAL_SIZE) {
    offsetX = (WALL_LOGICAL_SIZE - visibleWorldWidth) / 2;
  } else {
    offsetX = Math.min(Math.max(viewport.offsetX, 0), WALL_LOGICAL_SIZE - visibleWorldWidth);
  }

  if (visibleWorldHeight >= WALL_LOGICAL_SIZE) {
    offsetY = (WALL_LOGICAL_SIZE - visibleWorldHeight) / 2;
  } else {
    offsetY = Math.min(Math.max(viewport.offsetY, 0), WALL_LOGICAL_SIZE - visibleWorldHeight);
  }

  return { scale, offsetX, offsetY };
}

export function screenToWorld(
  viewport: Viewport,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: screenX / viewport.scale + viewport.offsetX,
    y: screenY / viewport.scale + viewport.offsetY,
  };
}

export function worldToScreen(
  viewport: Viewport,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return {
    x: (worldX - viewport.offsetX) * viewport.scale,
    y: (worldY - viewport.offsetY) * viewport.scale,
  };
}

/**
 * Which cell is under a screen point?
 *
 * Returns null outside the wall rather than clamping to an edge cell: clamping
 * would let a drag that leaves the canvas silently select the border, which
 * looks like a bug to the person doing it.
 */
export function screenToCell(
  viewport: Viewport,
  screenX: number,
  screenY: number,
): { x: number; y: number } | null {
  const world = screenToWorld(viewport, screenX, screenY);
  if (world.x < 0 || world.y < 0 || world.x >= WALL_LOGICAL_SIZE || world.y >= WALL_LOGICAL_SIZE) {
    return null;
  }
  return {
    x: Math.floor(world.x / CELL_LOGICAL_SIZE),
    y: Math.floor(world.y / CELL_LOGICAL_SIZE),
  };
}

/** Clamped variant, for continuing a drag that has left the canvas. */
export function screenToCellClamped(
  viewport: Viewport,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const world = screenToWorld(viewport, screenX, screenY);
  return {
    x: Math.min(Math.max(Math.floor(world.x / CELL_LOGICAL_SIZE), 0), GRID_SIZE - 1),
    y: Math.min(Math.max(Math.floor(world.y / CELL_LOGICAL_SIZE), 0), GRID_SIZE - 1),
  };
}

/**
 * Zoom about a fixed screen point.
 *
 * The point under the cursor must stay under the cursor. Getting this wrong is
 * why so many custom zoom implementations feel like the content is sliding away
 * from you.
 */
export function zoomAt(
  viewport: Viewport,
  canvas: CanvasSize,
  screenX: number,
  screenY: number,
  scaleFactor: number,
): Viewport {
  const minScale = minScaleFor(canvas);
  const nextScale = Math.min(Math.max(viewport.scale * scaleFactor, minScale), MAX_SCALE);

  // No change: return the same object so React can skip a re-render.
  if (nextScale === viewport.scale) return viewport;

  const anchor = screenToWorld(viewport, screenX, screenY);

  return clampViewport(
    {
      scale: nextScale,
      offsetX: anchor.x - screenX / nextScale,
      offsetY: anchor.y - screenY / nextScale,
    },
    canvas,
  );
}

/** Centre the viewport on a cell rectangle, at a scale that frames it. */
export function focusRect(
  canvas: CanvasSize,
  rect: { x: number; y: number; w: number; h: number },
  padding = 2.5,
): Viewport {
  const worldW = (rect.w + padding * 2) * CELL_LOGICAL_SIZE;
  const worldH = (rect.h + padding * 2) * CELL_LOGICAL_SIZE;

  const scale = Math.min(
    Math.max(Math.min(canvas.width / worldW, canvas.height / worldH), minScaleFor(canvas)),
    MAX_SCALE,
  );

  const centreX = (rect.x + rect.w / 2) * CELL_LOGICAL_SIZE;
  const centreY = (rect.y + rect.h / 2) * CELL_LOGICAL_SIZE;

  return clampViewport(
    {
      scale,
      offsetX: centreX - canvas.width / scale / 2,
      offsetY: centreY - canvas.height / scale / 2,
    },
    canvas,
  );
}

/**
 * The cell rectangle currently visible, with a margin.
 *
 * This is the culling window: only placements intersecting it get a sprite. A
 * one-cell margin means a placement is loaded just before it scrolls into view
 * rather than popping in.
 */
export function visibleCellBounds(
  viewport: Viewport,
  canvas: CanvasSize,
  marginCells = 2,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const topLeft = screenToWorld(viewport, 0, 0);
  const bottomRight = screenToWorld(viewport, canvas.width, canvas.height);

  return {
    minX: Math.max(0, Math.floor(topLeft.x / CELL_LOGICAL_SIZE) - marginCells),
    minY: Math.max(0, Math.floor(topLeft.y / CELL_LOGICAL_SIZE) - marginCells),
    maxX: Math.min(GRID_SIZE - 1, Math.ceil(bottomRight.x / CELL_LOGICAL_SIZE) + marginCells),
    maxY: Math.min(GRID_SIZE - 1, Math.ceil(bottomRight.y / CELL_LOGICAL_SIZE) + marginCells),
  };
}

export function rectIntersectsBounds(
  rect: { x: number; y: number; w: number; h: number },
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return (
    rect.x <= bounds.maxX &&
    rect.x + rect.w - 1 >= bounds.minX &&
    rect.y <= bounds.maxY &&
    rect.y + rect.h - 1 >= bounds.minY
  );
}

/**
 * Normalise a drag into a rectangle.
 *
 * Dragging up-left must produce the same rectangle as dragging down-right, which
 * means taking min/max rather than assuming the anchor is the top-left.
 */
export function rectFromDrag(
  anchor: { x: number; y: number },
  current: { x: number; y: number },
): { x: number; y: number; w: number; h: number } {
  const x = Math.min(anchor.x, current.x);
  const y = Math.min(anchor.y, current.y);
  return {
    x,
    y,
    w: Math.abs(current.x - anchor.x) + 1,
    h: Math.abs(current.y - anchor.y) + 1,
  };
}

/**
 * Zoom thresholds at which the renderer changes strategy.
 *
 * Below `showImages` the wall is drawn entirely from the 100x100 occupancy
 * texture — one sprite, one draw call, no network. Above it, artwork for visible
 * placements is loaded. That single decision is what makes a fully sold wall
 * render instantly on first paint.
 */
export const ZOOM_THRESHOLDS = {
  /** Load and draw real artwork at or above this scale. */
  showImages: 0.45,
  /** Draw the cell lattice at or above this scale. */
  showGrid: 0.7,
  /** Draw per-placement borders and labels at or above this scale. */
  showDetail: 1.6,
} as const;
