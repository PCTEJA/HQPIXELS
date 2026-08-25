/**
 * Price computation. Integer cents only — there is no floating point anywhere in
 * this file, and `shared/pricing.test.ts` asserts that.
 *
 * The same algorithm exists twice on purpose:
 *
 *   1. here, in TypeScript, used by the Worker to produce the authoritative
 *      quote and by the client to render a preview, and
 *   2. in PL/pgSQL as `public.quote_total_cents()`, used inside the reservation
 *      transaction.
 *
 * The reservation RPC recomputes the total and rejects the request if the
 * Worker's number disagrees. Two independent implementations agreeing is a
 * cheap, strong guard against a price-tampering bug on either side.
 */

import {
  CELL_LOGICAL_SIZE,
  GRID_SIZE,
  LOGICAL_PIXELS_PER_CELL,
  MAX_SELECTION_CELLS,
  MIN_SELECTION_CELLS,
} from './constants';

/** Basis points. 10_000 bp = 1.00x. Integer multipliers keep the math exact. */
export const BP_DENOMINATOR = 10_000;

export interface ZoneMultiplier {
  /** Human-readable label shown in the price breakdown, e.g. "Center spotlight". */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 10_000 = no change. 15_000 = +50%. Must be a positive integer. */
  readonly multiplierBp: number;
}

export interface PricingVersion {
  readonly version: number;
  readonly currency: 'USD';
  /** e.g. 10 = $0.10 per logical pixel. */
  readonly centsPerLogicalPixel: number;
  readonly zoneMultipliers: readonly ZoneMultiplier[];
  readonly minCells: number;
  readonly maxCells: number;
  readonly reservationTtlSeconds: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface QuoteLine {
  readonly label: string;
  readonly cells: number;
  readonly logicalPixels: number;
  readonly multiplierBp: number;
  readonly amountCents: number;
}

export interface Quote {
  readonly pricingVersion: number;
  readonly currency: 'USD';
  readonly rect: Rect;
  readonly cells: number;
  readonly logicalPixels: number;
  readonly centsPerLogicalPixel: number;
  /** Price before zone multipliers. */
  readonly baseCents: number;
  /** What the buyer is charged. Always an integer number of cents. */
  readonly totalCents: number;
  readonly lines: readonly QuoteLine[];
}

export class PricingError extends Error {
  constructor(
    readonly code:
      'out_of_bounds' | 'bad_dimensions' | 'too_small' | 'too_large' | 'invalid_pricing_version',
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Geometry validation. Throws `PricingError` rather than returning a boolean so
 * a caller cannot forget to check. Bounds are inclusive-exclusive:
 * x .. x+w-1 must all be within 0..GRID_SIZE-1.
 */
export function assertValidRect(rect: Rect, pricing?: PricingVersion): void {
  const { x, y, w, h } = rect;

  if (!isNonNegativeInt(x) || !isNonNegativeInt(y) || !isPositiveInt(w) || !isPositiveInt(h)) {
    throw new PricingError('bad_dimensions', 'Coordinates and size must be positive integers.');
  }
  if (x + w > GRID_SIZE || y + h > GRID_SIZE) {
    throw new PricingError(
      'out_of_bounds',
      `Selection must stay inside the ${GRID_SIZE}x${GRID_SIZE} grid.`,
    );
  }

  const cells = w * h;
  const minCells = pricing?.minCells ?? MIN_SELECTION_CELLS;
  const maxCells = Math.min(pricing?.maxCells ?? MAX_SELECTION_CELLS, MAX_SELECTION_CELLS);

  if (cells < minCells) {
    throw new PricingError('too_small', `Minimum purchase is ${minCells} unit(s).`);
  }
  if (cells > maxCells) {
    throw new PricingError('too_large', `Maximum single reservation is ${maxCells} units.`);
  }
}

function assertValidPricing(p: PricingVersion): void {
  if (
    !isPositiveInt(p.version) ||
    !isPositiveInt(p.centsPerLogicalPixel) ||
    !isPositiveInt(p.minCells) ||
    !isPositiveInt(p.maxCells) ||
    p.currency !== 'USD'
  ) {
    throw new PricingError('invalid_pricing_version', 'Pricing version is malformed.');
  }
  for (const z of p.zoneMultipliers) {
    if (
      !isNonNegativeInt(z.x) ||
      !isNonNegativeInt(z.y) ||
      !isPositiveInt(z.w) ||
      !isPositiveInt(z.h) ||
      !isPositiveInt(z.multiplierBp)
    ) {
      throw new PricingError('invalid_pricing_version', `Zone "${z.label}" is malformed.`);
    }
  }
}

function cellInZone(cx: number, cy: number, z: ZoneMultiplier): boolean {
  return cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h;
}

/**
 * The multiplier that applies to a single cell.
 *
 * Rule: the FIRST matching zone in array order wins. Order is therefore part of
 * the pricing version and must never be reordered in place — publish a new
 * version instead. Deterministic ordering is what lets the SQL implementation
 * agree with this one.
 */
export function multiplierForCell(
  cx: number,
  cy: number,
  zones: readonly ZoneMultiplier[],
): { multiplierBp: number; label: string } {
  for (const z of zones) {
    if (cellInZone(cx, cy, z)) return { multiplierBp: z.multiplierBp, label: z.label };
  }
  return { multiplierBp: BP_DENOMINATOR, label: 'Standard' };
}

/**
 * Per-cell price at a given multiplier, in whole cents.
 *
 * Rounding: half-up on a non-negative integer numerator, expressed with integer
 * arithmetic only. `Math.floor((a + d/2) / d)` is exact here because both
 * operands are safe integers well under 2^53.
 */
function cellCents(centsPerLogicalPixel: number, multiplierBp: number): number {
  const base = centsPerLogicalPixel * LOGICAL_PIXELS_PER_CELL;
  const numerator = base * multiplierBp;
  return Math.floor((numerator + BP_DENOMINATOR / 2) / BP_DENOMINATOR);
}

/**
 * Authoritative quote for a rectangle.
 *
 * Cost is O(cells) and cells is capped at 2500, so worst case is a few thousand
 * integer operations — negligible on a Worker CPU budget.
 */
export function computeQuote(pricing: PricingVersion, rect: Rect): Quote {
  assertValidPricing(pricing);
  assertValidRect(rect, pricing);

  const { x, y, w, h } = rect;
  const cells = w * h;
  const logicalPixels = cells * LOGICAL_PIXELS_PER_CELL;

  // Group by multiplier so the breakdown shown to the buyer has one line per
  // distinct rate rather than one line per cell.
  const groups = new Map<number, { label: string; cells: number; amountCents: number }>();

  for (let cy = y; cy < y + h; cy += 1) {
    for (let cx = x; cx < x + w; cx += 1) {
      const { multiplierBp, label } = multiplierForCell(cx, cy, pricing.zoneMultipliers);
      const amount = cellCents(pricing.centsPerLogicalPixel, multiplierBp);
      const existing = groups.get(multiplierBp);
      if (existing) {
        existing.cells += 1;
        existing.amountCents += amount;
      } else {
        groups.set(multiplierBp, { label, cells: 1, amountCents: amount });
      }
    }
  }

  const lines: QuoteLine[] = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([multiplierBp, g]) => ({
      label: g.label,
      cells: g.cells,
      logicalPixels: g.cells * LOGICAL_PIXELS_PER_CELL,
      multiplierBp,
      amountCents: g.amountCents,
    }));

  const totalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const baseCents = pricing.centsPerLogicalPixel * logicalPixels;

  return {
    pricingVersion: pricing.version,
    currency: pricing.currency,
    rect,
    cells,
    logicalPixels,
    centsPerLogicalPixel: pricing.centsPerLogicalPixel,
    baseCents,
    totalCents,
    lines,
  };
}

/** `1234` -> `"$12.34"`. Integer-safe; never uses division on the cents value. */
export function formatCents(cents: number, currency: 'USD' = 'USD'): string {
  if (!Number.isSafeInteger(cents))
    throw new PricingError('bad_dimensions', 'Cents must be an integer.');
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const remainder = abs % 100;
  const symbol = currency === 'USD' ? '$' : '';
  const grouped = dollars.toLocaleString('en-US');
  return `${negative ? '-' : ''}${symbol}${grouped}.${String(remainder).padStart(2, '0')}`;
}

/** Logical pixel dimensions of a cell rectangle, for display. */
export function rectToLogicalPixels(rect: Rect): { width: number; height: number } {
  return { width: rect.w * CELL_LOGICAL_SIZE, height: rect.h * CELL_LOGICAL_SIZE };
}

/** The launch pricing version. Mirrors the row seeded by the first migration. */
export const LAUNCH_PRICING: PricingVersion = {
  version: 1,
  currency: 'USD',
  centsPerLogicalPixel: 10,
  zoneMultipliers: [],
  minCells: MIN_SELECTION_CELLS,
  maxCells: MAX_SELECTION_CELLS,
  reservationTtlSeconds: 45 * 60,
};
