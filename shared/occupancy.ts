/**
 * The occupancy bitmap: 10,000 cells as 1,250 bytes.
 *
 * Why a bitmap rather than a list of taken cells:
 *   - Constant size regardless of how sold-out the wall is.
 *   - The renderer can test "is this cell taken" in O(1) while dragging a
 *     selection, at 60fps, with zero allocation.
 *   - It compresses well and is cheap to diff.
 *
 * Bit order is row-major, LSB-first within each byte:
 *   index = y * GRID_SIZE + x
 *   byte  = index >> 3
 *   bit   = index & 7
 *
 * The SQL side produces the same layout in `public.occupancy_bitmap()`, and
 * tests/unit/occupancy.test.ts round-trips both.
 */

import { GRID_SIZE, TOTAL_CELLS } from './constants';

export const OCCUPANCY_BYTES = Math.ceil(TOTAL_CELLS / 8);

export function createEmptyOccupancy(): Uint8Array {
  return new Uint8Array(OCCUPANCY_BYTES);
}

export function cellIndex(x: number, y: number): number {
  return y * GRID_SIZE + x;
}

export function isCellTaken(bitmap: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return true; // out of bounds is never claimable
  const index = cellIndex(x, y);
  const byte = bitmap[index >> 3];
  if (byte === undefined) return true;
  return (byte & (1 << (index & 7))) !== 0;
}

export function setCellTaken(bitmap: Uint8Array, x: number, y: number, taken = true): void {
  if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return;
  const index = cellIndex(x, y);
  const byteIndex = index >> 3;
  const mask = 1 << (index & 7);
  const current = bitmap[byteIndex];
  if (current === undefined) return;
  bitmap[byteIndex] = taken ? current | mask : current & ~mask;
}

/** Marks every cell of a rectangle. Used when building a manifest from placements. */
export function setRectTaken(
  bitmap: Uint8Array,
  rect: { x: number; y: number; w: number; h: number },
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      setCellTaken(bitmap, x, y, true);
    }
  }
}

/** True only if every cell in the rectangle is free. */
export function isRectAvailable(
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

/**
 * Which cells of a rectangle are taken. Bounded to `limit` entries so a
 * pathological 2500-cell selection cannot produce a huge response body.
 */
export function unavailableCellsInRect(
  bitmap: Uint8Array,
  rect: { x: number; y: number; w: number; h: number },
  limit = 50,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = rect.y; y < rect.y + rect.h && out.length < limit; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w && out.length < limit; x += 1) {
      if (isCellTaken(bitmap, x, y)) out.push({ x, y });
    }
  }
  return out;
}

export function countTakenCells(bitmap: Uint8Array): number {
  let count = 0;
  for (const byte of bitmap) {
    // Popcount via the standard SWAR trick — no lookup table, no branches.
    let v = byte;
    v = v - ((v >> 1) & 0x55);
    v = (v & 0x33) + ((v >> 2) & 0x33);
    count += (v + (v >> 4)) & 0x0f;
  }
  return count;
}

// -----------------------------------------------------------------------------
// Base64 transport
//
// Implemented by hand rather than via atob/btoa or Buffer, because this module
// runs unchanged in the browser, in workerd, and in Node tests.
// -----------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeOccupancy(bitmap: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bitmap.length; i += 3) {
    const b0 = bitmap[i] ?? 0;
    const b1 = bitmap[i + 1];
    const b2 = bitmap[i + 2];

    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

const B64_LOOKUP: Readonly<Record<string, number>> = Object.fromEntries(
  [...B64_ALPHABET].map((c, i) => [c, i]),
);

export function decodeOccupancy(encoded: string): Uint8Array {
  const clean = encoded.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (const ch of clean) {
    const value = B64_LOOKUP[ch];
    if (value === undefined) throw new Error('Malformed occupancy bitmap.');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }

  // Always hand back a full-size bitmap so callers never index past the end.
  if (out.length === OCCUPANCY_BYTES) return out;
  const padded = new Uint8Array(OCCUPANCY_BYTES);
  padded.set(out.subarray(0, Math.min(out.length, OCCUPANCY_BYTES)));
  return padded;
}
