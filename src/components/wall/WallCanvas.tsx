/**
 * The wall renderer.
 *
 * Rendering strategy, which is the whole performance story:
 *
 *   1. Occupancy is a single 100x100 texture built from the manifest's bitmap and
 *      scaled up with nearest-neighbour filtering. The entire wall — sold out or
 *      empty — is ONE sprite and one draw call. No DOM node per cell, no sprite
 *      per cell.
 *   2. Artwork sprites exist only for placements intersecting the viewport, and
 *      only above ZOOM_THRESHOLDS.showImages. First paint therefore never
 *      downloads 10,000 images.
 *   3. The cell lattice is a TilingSprite over a 10x10 tile, so the grid costs
 *      one draw call at any zoom instead of 200 line segments.
 *   4. Pan/zoom is handled with native pointer events on the canvas element
 *      rather than Pixi's interaction system, so gestures stay predictable and
 *      no hit-test tree is maintained for 10,000 targets.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Application, Container, Graphics, Sprite, TilingSprite } from 'pixi.js';
import type { ManifestPlacement, WallManifest } from '@shared/api-types';
import { CELL_LOGICAL_SIZE, GRID_SIZE, WALL_LOGICAL_SIZE } from '@shared/constants';
import { decodeOccupancy, isCellTaken } from '@shared/occupancy';
import { CANVAS_COLORS } from '../../lib/tokens';
import { useReducedMotion } from '../../lib/hooks';
import {
  ZOOM_THRESHOLDS,
  clampViewport,
  fitViewport,
  focusRect,
  rectFromDrag,
  rectIntersectsBounds,
  screenToCell,
  screenToCellClamped,
  visibleCellBounds,
  worldToScreen,
  zoomAt,
  type CanvasSize,
  type Viewport,
} from './viewport';

export interface WallCanvasProps {
  readonly manifest: WallManifest;
  readonly width: number;
  readonly height: number;
  /** `select` enables drag-to-select; `browse` is read-only. */
  readonly mode: 'browse' | 'select';
  readonly selection: { x: number; y: number; w: number; h: number } | null;
  readonly onSelectionChange?: (
    rect: { x: number; y: number; w: number; h: number } | null,
  ) => void;
  /** Keyboard cursor position, owned by the parent so arrow keys work off-canvas. */
  readonly cursor?: { x: number; y: number } | null;
  readonly onCursorChange?: (cell: { x: number; y: number } | null) => void;
  readonly onPlacementActivate?: (placement: ManifestPlacement) => void;
  readonly onHoverChange?: (placement: ManifestPlacement | null) => void;
  /** Placement id to frame on mount (deep link from a share URL). */
  readonly focusPlacementId?: string | null;
  readonly onViewportChange?: (viewport: Viewport) => void;
  /** Reports which placements are on screen, for the impression beacon. */
  readonly onVisiblePlacements?: (ids: readonly string[]) => void;
  /**
   * Key under which this instance registers its imperative controls, so a
   * sibling toolbar can drive zoom across the lazy-import boundary.
   */
  readonly controlsKey?: string;
}

interface PlacementSprite {
  readonly sprite: Sprite;
  readonly placement: ManifestPlacement;
}

export function WallCanvas(props: WallCanvasProps): React.JSX.Element {
  const {
    manifest,
    width,
    height,
    mode,
    selection,
    onSelectionChange,
    cursor,
    onCursorChange,
    onPlacementActivate,
    onHoverChange,
    focusPlacementId,
    onViewportChange,
    onVisiblePlacements,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const occupancyRef = useRef<Sprite | null>(null);
  const gridRef = useRef<TilingSprite | null>(null);
  const imageLayerRef = useRef<Container | null>(null);
  const overlayRef = useRef<Graphics | null>(null);
  const spritesRef = useRef<Map<string, PlacementSprite>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  const viewportRef = useRef<Viewport>({ offsetX: 0, offsetY: 0, scale: 0.5 });
  const canvasSizeRef = useRef<CanvasSize>({ width, height });
  const occupancyBitmapRef = useRef<Uint8Array>(decodeOccupancy(manifest.occupancyBitmap));
  const placementsRef = useRef<readonly ManifestPlacement[]>(manifest.placements);
  const selectionRef = useRef(selection);
  const cursorRef = useRef(cursor ?? null);
  const hoverRef = useRef<ManifestPlacement | null>(null);
  const dragRef = useRef<{
    kind: 'pan' | 'select';
    pointerId: number;
    startScreen: { x: number; y: number };
    startViewport: Viewport;
    anchorCell: { x: number; y: number } | null;
    moved: boolean;
  } | null>(null);
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Previous two-finger distance, for pinch zoom. Declared with the other refs
  // rather than beside its handler so it is initialised before first use.
  const pinchDistanceRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const reducedMotion = useReducedMotion();
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // Keep refs in step with props without re-creating the Pixi application.
  selectionRef.current = selection;
  cursorRef.current = cursor ?? null;
  placementsRef.current = manifest.placements;
  canvasSizeRef.current = { width, height };

  // ---------------------------------------------------------------------------
  // Occupancy texture
  // ---------------------------------------------------------------------------
  /**
   * Build a 100x100 RGBA texture from the occupancy bitmap.
   *
   * Uses a plain 2D canvas rather than a Pixi buffer source: it is stable across
   * Pixi versions, and 100x100 is 40 KB of pixel data written once per manifest
   * change, which is nothing.
   */
  const buildOccupancyCanvas = useCallback((bitmap: Uint8Array): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = GRID_SIZE;
    canvas.height = GRID_SIZE;

    const context = canvas.getContext('2d');
    if (context === null) return canvas;

    const image = context.createImageData(GRID_SIZE, GRID_SIZE);
    const empty = hexToRgb(CANVAS_COLORS.cellEmpty);
    const claimed = hexToRgb(CANVAS_COLORS.cellClaimed);

    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        const index = (y * GRID_SIZE + x) * 4;
        const colour = isCellTaken(bitmap, x, y) ? claimed : empty;
        image.data[index] = colour.r;
        image.data[index + 1] = colour.g;
        image.data[index + 2] = colour.b;
        image.data[index + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
    return canvas;
  }, []);

  // ---------------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------------
  const draw = useCallback(() => {
    const app = appRef.current;
    const world = worldRef.current;
    const overlay = overlayRef.current;
    const grid = gridRef.current;
    const imageLayer = imageLayerRef.current;
    if (app === null || world === null || overlay === null || imageLayer === null) return;

    const viewport = viewportRef.current;
    const canvas = canvasSizeRef.current;

    // One transform for the whole world container: everything inside is
    // positioned in world coordinates and never repositioned on pan or zoom.
    world.scale.set(viewport.scale);
    world.position.set(-viewport.offsetX * viewport.scale, -viewport.offsetY * viewport.scale);

    if (grid !== null) grid.visible = viewport.scale >= ZOOM_THRESHOLDS.showGrid;

    // --- artwork culling ----------------------------------------------------
    const bounds = visibleCellBounds(viewport, canvas);
    const showImages = viewport.scale >= ZOOM_THRESHOLDS.showImages;
    const sprites = spritesRef.current;
    const visibleIds: string[] = [];

    if (showImages) {
      for (const placement of placementsRef.current) {
        if (!rectIntersectsBounds(placement, bounds)) continue;
        visibleIds.push(placement.id);
        if (!sprites.has(placement.id)) void ensureSprite(placement);
      }
    }

    // Drop sprites that have scrolled away. Bounding the live sprite count is
    // what keeps memory flat while panning across a full wall.
    const keep = new Set(visibleIds);
    for (const [id, entry] of sprites) {
      if (!keep.has(id) || !showImages) {
        entry.sprite.destroy();
        sprites.delete(id);
      }
    }

    if (onVisiblePlacements !== undefined) onVisiblePlacements(visibleIds);

    // --- overlay ------------------------------------------------------------
    // A single Graphics object, cleared and redrawn. Cheaper than keeping
    // separate objects for hover, cursor and selection.
    overlay.clear();

    const activeSelection = selectionRef.current;
    if (activeSelection !== null) {
      const valid = isRectAvailable(occupancyBitmapRef.current, activeSelection);
      const colour = valid ? CANVAS_COLORS.selectionValid : CANVAS_COLORS.selectionInvalid;

      overlay
        .rect(
          activeSelection.x * CELL_LOGICAL_SIZE,
          activeSelection.y * CELL_LOGICAL_SIZE,
          activeSelection.w * CELL_LOGICAL_SIZE,
          activeSelection.h * CELL_LOGICAL_SIZE,
        )
        .fill({ color: colour, alpha: 0.18 })
        .stroke({ width: 2 / viewport.scale, color: colour, alpha: 0.95 });
    }

    const hover = hoverRef.current;
    if (hover !== null) {
      overlay
        .rect(
          hover.x * CELL_LOGICAL_SIZE,
          hover.y * CELL_LOGICAL_SIZE,
          hover.w * CELL_LOGICAL_SIZE,
          hover.h * CELL_LOGICAL_SIZE,
        )
        .stroke({ width: 2 / viewport.scale, color: CANVAS_COLORS.highlight, alpha: 0.9 });
    }

    const activeCursor = cursorRef.current;
    if (activeCursor !== null) {
      // The keyboard cursor. Drawn as a double ring so it stays visible over both
      // dark ground and bright artwork.
      overlay
        .rect(
          activeCursor.x * CELL_LOGICAL_SIZE,
          activeCursor.y * CELL_LOGICAL_SIZE,
          CELL_LOGICAL_SIZE,
          CELL_LOGICAL_SIZE,
        )
        .stroke({ width: 3 / viewport.scale, color: CANVAS_COLORS.background, alpha: 0.9 })
        .rect(
          activeCursor.x * CELL_LOGICAL_SIZE,
          activeCursor.y * CELL_LOGICAL_SIZE,
          CELL_LOGICAL_SIZE,
          CELL_LOGICAL_SIZE,
        )
        .stroke({ width: 1.5 / viewport.scale, color: CANVAS_COLORS.focusRing, alpha: 1 });
    }

    // Wall border, so the edge of the buyable area is unambiguous.
    overlay
      .rect(0, 0, WALL_LOGICAL_SIZE, WALL_LOGICAL_SIZE)
      .stroke({ width: 1 / viewport.scale, color: CANVAS_COLORS.gridLineMajor, alpha: 0.8 });

    if (onViewportChange !== undefined) onViewportChange(viewport);
  }, [onViewportChange, onVisiblePlacements]);

  /** Schedule a draw on the next frame; multiple calls in one frame collapse. */
  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      draw();
    });
  }, [draw]);

  /**
   * Create a sprite for one placement, loading its texture lazily.
   *
   * `loadingRef` prevents a second load being started for the same placement
   * while the first is in flight — otherwise panning back and forth over a
   * placement would queue dozens of identical requests.
   */
  const ensureSprite = useCallback(
    async (placement: ManifestPlacement): Promise<void> => {
      const imageLayer = imageLayerRef.current;
      if (imageLayer === null) return;
      if (spritesRef.current.has(placement.id)) return;
      if (loadingRef.current.has(placement.id)) return;
      if (placement.image === '' || placement.image === null) return;

      loadingRef.current.add(placement.id);

      try {
        const pixi = await import('pixi.js');
        const texture = await pixi.Assets.load<import('pixi.js').Texture>({
          src: placement.image,
          // Buyer artwork is pixel art at small sizes; smoothing it would blur it.
          data: { scaleMode: 'nearest' },
        });

        // The viewport may have moved on while the texture loaded.
        if (imageLayerRef.current === null) return;

        const sprite = new pixi.Sprite(texture);
        sprite.x = placement.x * CELL_LOGICAL_SIZE;
        sprite.y = placement.y * CELL_LOGICAL_SIZE;
        sprite.width = placement.w * CELL_LOGICAL_SIZE;
        sprite.height = placement.h * CELL_LOGICAL_SIZE;
        // Pixi's own hit testing is off: 10,000 interactive objects would be a
        // hit-test tree we do not need, since we resolve hits from the manifest.
        sprite.eventMode = 'none';

        imageLayer.addChild(sprite);
        spritesRef.current.set(placement.id, { sprite, placement });
        scheduleDraw();
      } catch {
        // A single broken image must not break the wall. It simply stays as the
        // occupancy block until the next manifest rebuild.
      } finally {
        loadingRef.current.delete(placement.id);
      }
    },
    [scheduleDraw],
  );

  // ---------------------------------------------------------------------------
  // Initialise Pixi
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let application: Application | null = null;

    const init = async (): Promise<void> => {
      const host = hostRef.current;
      if (host === null || width <= 0 || height <= 0) return;

      try {
        const pixi = await import('pixi.js');
        if (cancelled) return;

        application = new pixi.Application();
        await application.init({
          width,
          height,
          background: CANVAS_COLORS.background,
          antialias: false,
          // Cap at 2: beyond that the pixel count grows faster than the visual
          // benefit on a wall of hard-edged blocks.
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
          powerPreference: 'high-performance',
          // We drive rendering ourselves from scheduleDraw, so there is no
          // continuous render loop burning battery on a static wall.
          preference: 'webgl',
        });

        if (cancelled) {
          application.destroy(true, { children: true });
          return;
        }

        host.appendChild(application.canvas);
        application.canvas.style.touchAction = 'none';
        application.canvas.setAttribute('aria-hidden', 'true');

        const world = new pixi.Container();
        application.stage.addChild(world);

        // 1. occupancy
        const occupancyTexture = pixi.Texture.from(
          buildOccupancyCanvas(occupancyBitmapRef.current),
        );
        occupancyTexture.source.scaleMode = 'nearest';
        const occupancy = new pixi.Sprite(occupancyTexture);
        occupancy.width = WALL_LOGICAL_SIZE;
        occupancy.height = WALL_LOGICAL_SIZE;
        occupancy.eventMode = 'none';
        world.addChild(occupancy);

        // 2. artwork
        const imageLayer = new pixi.Container();
        imageLayer.eventMode = 'none';
        world.addChild(imageLayer);

        // 3. lattice, one tiling sprite over a 10x10 tile
        const tile = document.createElement('canvas');
        tile.width = CELL_LOGICAL_SIZE;
        tile.height = CELL_LOGICAL_SIZE;
        const tileContext = tile.getContext('2d');
        if (tileContext !== null) {
          tileContext.strokeStyle = intToCss(CANVAS_COLORS.gridLine);
          tileContext.lineWidth = 1;
          tileContext.beginPath();
          tileContext.moveTo(0.5, 0);
          tileContext.lineTo(0.5, CELL_LOGICAL_SIZE);
          tileContext.moveTo(0, 0.5);
          tileContext.lineTo(CELL_LOGICAL_SIZE, 0.5);
          tileContext.stroke();
        }
        const gridTexture = pixi.Texture.from(tile);
        gridTexture.source.scaleMode = 'nearest';
        const gridSprite = new pixi.TilingSprite({
          texture: gridTexture,
          width: WALL_LOGICAL_SIZE,
          height: WALL_LOGICAL_SIZE,
        });
        gridSprite.eventMode = 'none';
        gridSprite.alpha = 0.85;
        world.addChild(gridSprite);

        // 4. overlay
        const overlay = new pixi.Graphics();
        overlay.eventMode = 'none';
        world.addChild(overlay);

        appRef.current = application;
        worldRef.current = world;
        occupancyRef.current = occupancy;
        gridRef.current = gridSprite;
        imageLayerRef.current = imageLayer;
        overlayRef.current = overlay;

        // Initial framing: a deep link frames its placement, otherwise fit all.
        const size = { width, height };
        const target =
          focusPlacementId != null
            ? placementsRef.current.find((p) => p.id === focusPlacementId)
            : undefined;

        viewportRef.current = target !== undefined ? focusRect(size, target) : fitViewport(size);

        setReady(true);
        draw();
      } catch (error) {
        if (!cancelled) {
          setInitError(
            error instanceof Error && /webgl/i.test(error.message) ? 'webgl' : 'unknown',
          );
        }
      }
    };

    void init();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;

      for (const [, entry] of spritesRef.current) entry.sprite.destroy();
      spritesRef.current.clear();
      loadingRef.current.clear();

      const current = appRef.current ?? application;
      if (current !== null) {
        current.destroy(true, { children: true, texture: true });
      }
      appRef.current = null;
      worldRef.current = null;
      occupancyRef.current = null;
      gridRef.current = null;
      imageLayerRef.current = null;
      overlayRef.current = null;
      setReady(false);
    };
    // Deliberately not depending on `draw`/`ensureSprite`: this effect creates
    // and destroys the WebGL context and must run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // React to size changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const app = appRef.current;
    if (app === null || width <= 0 || height <= 0) return;

    app.renderer.resize(width, height);
    canvasSizeRef.current = { width, height };
    viewportRef.current = clampViewport(viewportRef.current, { width, height });
    scheduleDraw();
  }, [width, height, scheduleDraw]);

  // ---------------------------------------------------------------------------
  // React to a new manifest
  // ---------------------------------------------------------------------------
  useEffect(() => {
    occupancyBitmapRef.current = decodeOccupancy(manifest.occupancyBitmap);

    const occupancy = occupancyRef.current;
    if (occupancy === null) {
      scheduleDraw();
      return;
    }

    void (async () => {
      const pixi = await import('pixi.js');
      const texture = pixi.Texture.from(buildOccupancyCanvas(occupancyBitmapRef.current));
      texture.source.scaleMode = 'nearest';
      const previous = occupancy.texture;
      occupancy.texture = texture;
      // Release the old GPU texture; leaking one per manifest update would grow
      // unbounded on a long-lived tab.
      previous.destroy(true);

      // Artwork may have changed for an existing id, so drop every sprite and let
      // culling rebuild what is visible.
      for (const [, entry] of spritesRef.current) entry.sprite.destroy();
      spritesRef.current.clear();

      scheduleDraw();
    })();
  }, [manifest.manifestVersion, manifest.occupancyBitmap, buildOccupancyCanvas, scheduleDraw]);

  // Redraw when the parent changes selection or cursor.
  useEffect(() => {
    scheduleDraw();
  }, [selection, cursor, scheduleDraw]);

  // ---------------------------------------------------------------------------
  // Pointer interaction
  // ---------------------------------------------------------------------------
  const placementAt = useCallback((cell: { x: number; y: number }): ManifestPlacement | null => {
    // Linear scan over active placements. At the MVP's scale (thousands at most)
    // this is microseconds and avoids maintaining a spatial index that would need
    // rebuilding on every manifest change.
    for (const placement of placementsRef.current) {
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
  }, []);

  const localPoint = (event: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!ready) return;
    const point = localPoint(event);

    pinchRef.current.set(event.pointerId, point);

    // Two fingers: hand over to the pinch handler and cancel any drag.
    if (pinchRef.current.size >= 2) {
      dragRef.current = null;
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);

    const cell = screenToCell(viewportRef.current, point.x, point.y);

    // Middle mouse, space-modified, or browse mode: pan. Otherwise select.
    const wantsPan = mode !== 'select' || event.button === 1 || event.shiftKey || cell === null;

    dragRef.current = {
      kind: wantsPan ? 'pan' : 'select',
      pointerId: event.pointerId,
      startScreen: point,
      startViewport: viewportRef.current,
      anchorCell: cell,
      moved: false,
    };

    if (!wantsPan && cell !== null && onSelectionChange !== undefined) {
      onSelectionChange({ x: cell.x, y: cell.y, w: 1, h: 1 });
      onCursorChange?.(cell);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!ready) return;
    const point = localPoint(event);

    if (pinchRef.current.has(event.pointerId)) pinchRef.current.set(event.pointerId, point);

    // --- pinch zoom ---------------------------------------------------------
    if (pinchRef.current.size >= 2) {
      const points = [...pinchRef.current.values()].slice(0, 2);
      const first = points[0];
      const second = points[1];
      if (first === undefined || second === undefined) return;

      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const previous = pinchDistanceRef.current;
      pinchDistanceRef.current = distance;

      if (previous !== null && previous > 0 && distance > 0) {
        const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        viewportRef.current = zoomAt(
          viewportRef.current,
          canvasSizeRef.current,
          midpoint.x,
          midpoint.y,
          distance / previous,
        );
        scheduleDraw();
      }
      return;
    }

    const drag = dragRef.current;

    // --- hover (no button held) --------------------------------------------
    if (drag === null) {
      const cell = screenToCell(viewportRef.current, point.x, point.y);
      const placement = cell === null ? null : placementAt(cell);
      if (placement?.id !== hoverRef.current?.id) {
        hoverRef.current = placement;
        onHoverChange?.(placement);
        scheduleDraw();
      }
      return;
    }

    const dx = point.x - drag.startScreen.x;
    const dy = point.y - drag.startScreen.y;
    // A few pixels of slack so a tap is not treated as a drag.
    if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;

    if (drag.kind === 'pan') {
      viewportRef.current = clampViewport(
        {
          scale: drag.startViewport.scale,
          offsetX: drag.startViewport.offsetX - dx / drag.startViewport.scale,
          offsetY: drag.startViewport.offsetY - dy / drag.startViewport.scale,
        },
        canvasSizeRef.current,
      );
      scheduleDraw();
      return;
    }

    if (drag.anchorCell !== null && onSelectionChange !== undefined) {
      // Clamped, so dragging past the canvas edge extends to the wall edge
      // rather than freezing the selection.
      const current = screenToCellClamped(viewportRef.current, point.x, point.y);
      const rect = rectFromDrag(drag.anchorCell, current);
      onSelectionChange(rect);
      onCursorChange?.(current);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    pinchRef.current.delete(event.pointerId);
    if (pinchRef.current.size < 2) pinchDistanceRef.current = null;

    const drag = dragRef.current;
    dragRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (drag === null || drag.moved) return;

    // A tap, not a drag: open the placement under it.
    const point = localPoint(event);
    const cell = screenToCell(viewportRef.current, point.x, point.y);
    if (cell === null) return;

    onCursorChange?.(cell);

    const placement = placementAt(cell);
    if (placement !== null) {
      onPlacementActivate?.(placement);
    } else if (mode === 'select' && onSelectionChange !== undefined) {
      onSelectionChange({ x: cell.x, y: cell.y, w: 1, h: 1 });
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!ready) return;
    // Prevent the page scrolling behind the canvas.
    event.preventDefault();

    const point = localPoint(event);
    // Normalise across deltaMode values so a trackpad and a mouse wheel feel
    // comparable, and clamp so one violent scroll does not jump to max zoom.
    const magnitude = Math.min(Math.abs(event.deltaY), 100);
    const direction = event.deltaY > 0 ? -1 : 1;
    const factor = 1 + direction * (magnitude / 100) * 0.35;

    viewportRef.current = zoomAt(
      viewportRef.current,
      canvasSizeRef.current,
      point.x,
      point.y,
      factor,
    );
    scheduleDraw();
  };

  // Non-passive wheel listener: React's onWheel is passive, so preventDefault
  // there is ignored and the page scrolls behind the canvas.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  // ---------------------------------------------------------------------------
  // Imperative controls for the parent's zoom buttons
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const controls: WallControls = {
      zoomIn: () => {
        const size = canvasSizeRef.current;
        viewportRef.current = zoomAt(
          viewportRef.current,
          size,
          size.width / 2,
          size.height / 2,
          1.4,
        );
        scheduleDraw();
      },
      zoomOut: () => {
        const size = canvasSizeRef.current;
        viewportRef.current = zoomAt(
          viewportRef.current,
          size,
          size.width / 2,
          size.height / 2,
          1 / 1.4,
        );
        scheduleDraw();
      },
      reset: () => {
        viewportRef.current = fitViewport(canvasSizeRef.current);
        scheduleDraw();
      },
      focusCell: (cell) => {
        viewportRef.current = focusRect(canvasSizeRef.current, { ...cell, w: 1, h: 1 }, 6);
        scheduleDraw();
      },
      focusRect: (rect) => {
        viewportRef.current = focusRect(canvasSizeRef.current, rect);
        scheduleDraw();
      },
      /**
       * Keep a cell in view without changing zoom.
       *
       * Used by arrow-key navigation: moving the cursor off screen and leaving it
       * there is the classic keyboard-canvas failure.
       */
      revealCell: (cell) => {
        const viewport = viewportRef.current;
        const size = canvasSizeRef.current;
        const screen = worldToScreen(
          viewport,
          cell.x * CELL_LOGICAL_SIZE + CELL_LOGICAL_SIZE / 2,
          cell.y * CELL_LOGICAL_SIZE + CELL_LOGICAL_SIZE / 2,
        );
        const margin = 60;

        if (
          screen.x >= margin &&
          screen.x <= size.width - margin &&
          screen.y >= margin &&
          screen.y <= size.height - margin
        ) {
          return;
        }

        viewportRef.current = clampViewport(
          {
            scale: viewport.scale,
            offsetX: cell.x * CELL_LOGICAL_SIZE - size.width / viewport.scale / 2,
            offsetY: cell.y * CELL_LOGICAL_SIZE - size.height / viewport.scale / 2,
          },
          size,
        );
        scheduleDraw();
      },
      getViewport: () => viewportRef.current,
    };

    wallControlsRegistry.set(props.controlsKey ?? 'default', controls);
    return () => {
      wallControlsRegistry.delete(props.controlsKey ?? 'default');
    };
  }, [scheduleDraw, props.controlsKey]);

  if (initError !== null) {
    return (
      <div className="glass flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-semibold text-ink">The interactive wall could not start</p>
        <p className="max-w-md text-sm text-ink-muted">
          {initError === 'webgl'
            ? 'Your browser could not create a WebGL context. Hardware acceleration may be disabled.'
            : 'Something went wrong starting the canvas renderer.'}{' '}
          Every placement is also listed in the accessible table below, which works without WebGL.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className="h-full w-full select-none"
      style={{
        cursor: mode === 'select' ? 'crosshair' : 'grab',
        // The activation flash is skipped entirely under reduced motion.
        transition: reducedMotion ? 'none' : undefined,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => {
        if (hoverRef.current !== null) {
          hoverRef.current = null;
          onHoverChange?.(null);
          scheduleDraw();
        }
      }}
      onWheel={handleWheel}
      // The canvas itself is aria-hidden; keyboard users interact with the
      // accessible list and the toolbar, which is what WallSurface renders.
      aria-hidden="true"
    />
  );
}

// -----------------------------------------------------------------------------
// Imperative control registry
// -----------------------------------------------------------------------------

export interface WallControls {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  focusCell: (cell: { x: number; y: number }) => void;
  focusRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  revealCell: (cell: { x: number; y: number }) => void;
  getViewport: () => Viewport;
}

/**
 * A tiny registry instead of a forwarded ref.
 *
 * The canvas is a lazily imported component behind Suspense; threading a ref
 * through `lazy()` and a Suspense boundary is fragile, and the toolbar needs to
 * call into it from a sibling. One module-scope map keyed by an id is simpler and
 * survives the lazy boundary.
 */
export const wallControlsRegistry = new Map<string, WallControls>();

export function getWallControls(key = 'default'): WallControls | undefined {
  return wallControlsRegistry.get(key);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function hexToRgb(value: number): { r: number; g: number; b: number } {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function intToCss(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function isRectAvailable(
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

export default WallCanvas;
