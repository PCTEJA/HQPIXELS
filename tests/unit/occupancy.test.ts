/**
 * Unit tests for shared/occupancy.ts.
 *
 * The occupancy bitmap is the foundation of collision detection. These tests
 * verify bit operations, boundary handling, and round-trip consistency.
 */

import { describe, expect, it } from 'vitest';
import {
  cellIndex,
  countTakenCells,
  createEmptyOccupancy,
  isCellTaken,
  isRectAvailable,
  OCCUPANCY_BYTES,
  setCellTaken,
  setRectTaken,
  unavailableCellsInRect,
} from '@shared/occupancy';
import { GRID_SIZE, TOTAL_CELLS } from '@shared/constants';

describe('createEmptyOccupancy', () => {
  it('creates a bitmap of the correct size', () => {
    const bitmap = createEmptyOccupancy();
    expect(bitmap).toBeInstanceOf(Uint8Array);
    expect(bitmap.length).toBe(OCCUPANCY_BYTES);
  });

  it('creates a bitmap with all zeros', () => {
    const bitmap = createEmptyOccupancy();
    for (const byte of bitmap) {
      expect(byte).toBe(0);
    }
  });

  it('returns a new array each time', () => {
    const a = createEmptyOccupancy();
    const b = createEmptyOccupancy();
    expect(a).not.toBe(b);
  });
});

describe('cellIndex', () => {
  it('computes row-major index', () => {
    expect(cellIndex(0, 0)).toBe(0);
    expect(cellIndex(1, 0)).toBe(1);
    expect(cellIndex(0, 1)).toBe(GRID_SIZE);
    expect(cellIndex(99, 99)).toBe(GRID_SIZE * 99 + 99);
  });

  it('covers the full grid', () => {
    expect(cellIndex(GRID_SIZE - 1, GRID_SIZE - 1)).toBe(TOTAL_CELLS - 1);
  });
});

describe('isCellTaken / setCellTaken', () => {
  it('defaults to not taken', () => {
    const bitmap = createEmptyOccupancy();
    expect(isCellTaken(bitmap, 0, 0)).toBe(false);
    expect(isCellTaken(bitmap, 50, 50)).toBe(false);
  });

  it('marks a cell as taken', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 10, 20, true);
    expect(isCellTaken(bitmap, 10, 20)).toBe(true);
    expect(isCellTaken(bitmap, 10, 21)).toBe(false);
  });

  it('can clear a taken cell', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 5, 5, true);
    expect(isCellTaken(bitmap, 5, 5)).toBe(true);
    setCellTaken(bitmap, 5, 5, false);
    expect(isCellTaken(bitmap, 5, 5)).toBe(false);
  });

  it('handles corner cells', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 0, 0);
    setCellTaken(bitmap, 99, 0);
    setCellTaken(bitmap, 0, 99);
    setCellTaken(bitmap, 99, 99);
    expect(isCellTaken(bitmap, 0, 0)).toBe(true);
    expect(isCellTaken(bitmap, 99, 0)).toBe(true);
    expect(isCellTaken(bitmap, 0, 99)).toBe(true);
    expect(isCellTaken(bitmap, 99, 99)).toBe(true);
  });

  it('treats out-of-bounds as taken (defensive)', () => {
    const bitmap = createEmptyOccupancy();
    expect(isCellTaken(bitmap, -1, 0)).toBe(true);
    expect(isCellTaken(bitmap, 0, -1)).toBe(true);
    expect(isCellTaken(bitmap, 100, 0)).toBe(true);
    expect(isCellTaken(bitmap, 0, 100)).toBe(true);
  });

  it('ignores out-of-bounds sets', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, -1, 0);
    setCellTaken(bitmap, 100, 0);
    // Should not throw or corrupt
    expect(countTakenCells(bitmap)).toBe(0);
  });

  it('correctly maps cells to bytes and bits', () => {
    const bitmap = createEmptyOccupancy();
    // Cell 0 should be byte 0, bit 0
    setCellTaken(bitmap, 0, 0);
    expect(bitmap[0]).toBe(1);

    // Cell 7 should be byte 0, bit 7
    setCellTaken(bitmap, 7, 0);
    expect(bitmap[0]).toBe(1 | (1 << 7));

    // Cell 8 should be byte 1, bit 0
    setCellTaken(bitmap, 8, 0);
    expect(bitmap[1]).toBe(1);
  });
});

describe('setRectTaken', () => {
  it('marks all cells in a rectangle', () => {
    const bitmap = createEmptyOccupancy();
    setRectTaken(bitmap, { x: 10, y: 10, w: 3, h: 2 });

    // Inside the rect
    expect(isCellTaken(bitmap, 10, 10)).toBe(true);
    expect(isCellTaken(bitmap, 11, 10)).toBe(true);
    expect(isCellTaken(bitmap, 12, 10)).toBe(true);
    expect(isCellTaken(bitmap, 10, 11)).toBe(true);
    expect(isCellTaken(bitmap, 11, 11)).toBe(true);
    expect(isCellTaken(bitmap, 12, 11)).toBe(true);

    // Just outside
    expect(isCellTaken(bitmap, 9, 10)).toBe(false);
    expect(isCellTaken(bitmap, 13, 10)).toBe(false);
    expect(isCellTaken(bitmap, 10, 9)).toBe(false);
    expect(isCellTaken(bitmap, 10, 12)).toBe(false);
  });

  it('handles 1x1 rectangle', () => {
    const bitmap = createEmptyOccupancy();
    setRectTaken(bitmap, { x: 50, y: 50, w: 1, h: 1 });
    expect(isCellTaken(bitmap, 50, 50)).toBe(true);
    expect(countTakenCells(bitmap)).toBe(1);
  });
});

describe('isRectAvailable', () => {
  it('returns true for empty bitmap', () => {
    const bitmap = createEmptyOccupancy();
    expect(isRectAvailable(bitmap, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
  });

  it('returns false if any cell in rect is taken', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 5, 5);
    expect(isRectAvailable(bitmap, { x: 0, y: 0, w: 10, h: 10 })).toBe(false);
    expect(isRectAvailable(bitmap, { x: 5, y: 5, w: 1, h: 1 })).toBe(false);
  });

  it('returns true if taken cell is outside rect', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 50, 50);
    expect(isRectAvailable(bitmap, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
  });

  it('handles adjacent but non-overlapping rects', () => {
    const bitmap = createEmptyOccupancy();
    setRectTaken(bitmap, { x: 0, y: 0, w: 10, h: 10 });
    // Adjacent rect should be available
    expect(isRectAvailable(bitmap, { x: 10, y: 0, w: 10, h: 10 })).toBe(true);
    expect(isRectAvailable(bitmap, { x: 0, y: 10, w: 10, h: 10 })).toBe(true);
  });
});

describe('unavailableCellsInRect', () => {
  it('returns empty array when all cells are free', () => {
    const bitmap = createEmptyOccupancy();
    const cells = unavailableCellsInRect(bitmap, { x: 0, y: 0, w: 5, h: 5 });
    expect(cells).toEqual([]);
  });

  it('returns taken cells within the rect', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 2, 2);
    setCellTaken(bitmap, 3, 3);
    const cells = unavailableCellsInRect(bitmap, { x: 0, y: 0, w: 10, h: 10 });
    expect(cells).toContainEqual({ x: 2, y: 2 });
    expect(cells).toContainEqual({ x: 3, y: 3 });
    expect(cells).toHaveLength(2);
  });

  it('excludes cells outside the rect', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 50, 50);
    const cells = unavailableCellsInRect(bitmap, { x: 0, y: 0, w: 10, h: 10 });
    expect(cells).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const bitmap = createEmptyOccupancy();
    // Mark 100 cells
    for (let i = 0; i < 100; i++) {
      setCellTaken(bitmap, i % 10, Math.floor(i / 10));
    }
    const cells = unavailableCellsInRect(bitmap, { x: 0, y: 0, w: 10, h: 10 }, 10);
    expect(cells.length).toBe(10);
  });

  it('default limit is 50', () => {
    const bitmap = createEmptyOccupancy();
    // Mark 100 cells
    for (let i = 0; i < 100; i++) {
      setCellTaken(bitmap, i % 10, Math.floor(i / 10));
    }
    const cells = unavailableCellsInRect(bitmap, { x: 0, y: 0, w: 10, h: 10 });
    expect(cells.length).toBe(50);
  });
});

describe('countTakenCells', () => {
  it('returns 0 for empty bitmap', () => {
    const bitmap = createEmptyOccupancy();
    expect(countTakenCells(bitmap)).toBe(0);
  });

  it('counts single cell', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 0, 0);
    expect(countTakenCells(bitmap)).toBe(1);
  });

  it('counts multiple scattered cells', () => {
    const bitmap = createEmptyOccupancy();
    setCellTaken(bitmap, 0, 0);
    setCellTaken(bitmap, 50, 50);
    setCellTaken(bitmap, 99, 99);
    expect(countTakenCells(bitmap)).toBe(3);
  });

  it('counts rectangle correctly', () => {
    const bitmap = createEmptyOccupancy();
    setRectTaken(bitmap, { x: 0, y: 0, w: 10, h: 10 });
    expect(countTakenCells(bitmap)).toBe(100);
  });

  it('counts full grid', () => {
    const bitmap = createEmptyOccupancy();
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        setCellTaken(bitmap, x, y);
      }
    }
    expect(countTakenCells(bitmap)).toBe(TOTAL_CELLS);
  });
});

describe('round-trip consistency', () => {
  it('set and check all cells individually', () => {
    const bitmap = createEmptyOccupancy();

    // Set every other cell
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if ((x + y) % 2 === 0) {
          setCellTaken(bitmap, x, y);
        }
      }
    }

    // Verify
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const expected = (x + y) % 2 === 0;
        expect(isCellTaken(bitmap, x, y)).toBe(expected);
      }
    }

    expect(countTakenCells(bitmap)).toBe(TOTAL_CELLS / 2);
  });
});
