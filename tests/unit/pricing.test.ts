/**
 * Unit tests for shared/pricing.ts.
 *
 * These verify the quote computation, geometry validation, zone multipliers,
 * and formatting. The same algorithm runs in PL/pgSQL — the behaviour suite
 * verifies they agree.
 */

import { describe, expect, it } from 'vitest';
import {
  assertValidRect,
  BP_DENOMINATOR,
  computeQuote,
  formatCents,
  LAUNCH_PRICING,
  multiplierForCell,
  PricingError,
  rectToLogicalPixels,
  type PricingVersion,
  type Rect,
  type ZoneMultiplier,
} from '@shared/pricing';
import {
  GRID_SIZE,
  LOGICAL_PIXELS_PER_CELL,
  MAX_SELECTION_CELLS,
  MIN_SELECTION_CELLS,
} from '@shared/constants';

describe('assertValidRect', () => {
  it('accepts a minimal 1x1 selection at origin', () => {
    expect(() => assertValidRect({ x: 0, y: 0, w: 1, h: 1 })).not.toThrow();
  });

  it('accepts a selection at the far corner', () => {
    expect(() => assertValidRect({ x: GRID_SIZE - 1, y: GRID_SIZE - 1, w: 1, h: 1 })).not.toThrow();
  });

  it('accepts the maximum selection size', () => {
    // 50x50 = 2500 cells
    expect(() => assertValidRect({ x: 0, y: 0, w: 50, h: 50 })).not.toThrow();
  });

  it('rejects a selection that exceeds the grid bounds', () => {
    expect(() => assertValidRect({ x: 99, y: 0, w: 2, h: 1 })).toThrow(PricingError);
    expect(() => assertValidRect({ x: 0, y: 99, w: 1, h: 2 })).toThrow(PricingError);
  });

  it('rejects a selection larger than MAX_SELECTION_CELLS', () => {
    expect(() => assertValidRect({ x: 0, y: 0, w: 51, h: 50 })).toThrow(PricingError);
  });

  it('rejects negative coordinates', () => {
    expect(() => assertValidRect({ x: -1, y: 0, w: 1, h: 1 })).toThrow(PricingError);
    expect(() => assertValidRect({ x: 0, y: -1, w: 1, h: 1 })).toThrow(PricingError);
  });

  it('rejects zero dimensions', () => {
    expect(() => assertValidRect({ x: 0, y: 0, w: 0, h: 1 })).toThrow(PricingError);
    expect(() => assertValidRect({ x: 0, y: 0, w: 1, h: 0 })).toThrow(PricingError);
  });

  it('rejects non-integer coordinates', () => {
    expect(() => assertValidRect({ x: 0.5, y: 0, w: 1, h: 1 })).toThrow(PricingError);
    expect(() => assertValidRect({ x: 0, y: 0, w: 1.5, h: 1 })).toThrow(PricingError);
  });

  it('respects pricing version min/max cells', () => {
    const customPricing: PricingVersion = {
      ...LAUNCH_PRICING,
      minCells: 4,
      maxCells: 100,
    };
    // 2x2 = 4 cells, at minimum
    expect(() => assertValidRect({ x: 0, y: 0, w: 2, h: 2 }, customPricing)).not.toThrow();
    // 1 cell, below minimum
    expect(() => assertValidRect({ x: 0, y: 0, w: 1, h: 1 }, customPricing)).toThrow(PricingError);
    // 11x10 = 110 cells, above maximum
    expect(() => assertValidRect({ x: 0, y: 0, w: 11, h: 10 }, customPricing)).toThrow(
      PricingError,
    );
  });

  it('includes correct error codes', () => {
    try {
      assertValidRect({ x: 100, y: 0, w: 1, h: 1 });
    } catch (e) {
      expect((e as PricingError).code).toBe('out_of_bounds');
    }

    try {
      assertValidRect({ x: 0, y: 0, w: -1, h: 1 });
    } catch (e) {
      expect((e as PricingError).code).toBe('bad_dimensions');
    }
  });
});

describe('multiplierForCell', () => {
  const zones: ZoneMultiplier[] = [
    { label: 'Premium center', x: 40, y: 40, w: 20, h: 20, multiplierBp: 15_000 },
    { label: 'Discount corner', x: 0, y: 0, w: 10, h: 10, multiplierBp: 8_000 },
  ];

  it('returns the first matching zone', () => {
    const result = multiplierForCell(45, 45, zones);
    expect(result.label).toBe('Premium center');
    expect(result.multiplierBp).toBe(15_000);
  });

  it('returns Standard for cells outside all zones', () => {
    const result = multiplierForCell(70, 70, zones);
    expect(result.label).toBe('Standard');
    expect(result.multiplierBp).toBe(BP_DENOMINATOR);
  });

  it('returns discount zone for cells in corner', () => {
    const result = multiplierForCell(5, 5, zones);
    expect(result.label).toBe('Discount corner');
    expect(result.multiplierBp).toBe(8_000);
  });

  it('handles empty zones array', () => {
    const result = multiplierForCell(50, 50, []);
    expect(result.label).toBe('Standard');
    expect(result.multiplierBp).toBe(BP_DENOMINATOR);
  });

  it('respects zone boundaries (exclusive end)', () => {
    // Cell at (59, 59) is inside the zone (40-59 inclusive)
    expect(multiplierForCell(59, 59, zones).label).toBe('Premium center');
    // Cell at (60, 60) is outside
    expect(multiplierForCell(60, 60, zones).label).toBe('Standard');
  });
});

describe('computeQuote', () => {
  it('computes correct total for a simple 1x1 at standard rate', () => {
    const quote = computeQuote(LAUNCH_PRICING, { x: 70, y: 70, w: 1, h: 1 });
    expect(quote.cells).toBe(1);
    expect(quote.logicalPixels).toBe(LOGICAL_PIXELS_PER_CELL);
    // 10 cents per logical pixel * 100 pixels per cell = $10.00 = 1000 cents
    expect(quote.totalCents).toBe(1000);
    expect(quote.baseCents).toBe(1000);
    expect(quote.currency).toBe('USD');
    expect(quote.pricingVersion).toBe(1);
  });

  it('computes correct total for a 2x2 selection', () => {
    const quote = computeQuote(LAUNCH_PRICING, { x: 0, y: 0, w: 2, h: 2 });
    expect(quote.cells).toBe(4);
    expect(quote.logicalPixels).toBe(4 * LOGICAL_PIXELS_PER_CELL);
    expect(quote.totalCents).toBe(4000);
  });

  it('applies zone multipliers correctly', () => {
    const pricingWithZones: PricingVersion = {
      ...LAUNCH_PRICING,
      zoneMultipliers: [
        { label: 'Premium', x: 0, y: 0, w: 10, h: 10, multiplierBp: 15_000 }, // +50%
      ],
    };

    const quote = computeQuote(pricingWithZones, { x: 0, y: 0, w: 1, h: 1 });
    // Base: 1000 cents, multiplied by 1.5 = 1500 cents
    expect(quote.totalCents).toBe(1500);
  });

  it('groups cells by multiplier in line items', () => {
    const pricingWithZones: PricingVersion = {
      ...LAUNCH_PRICING,
      zoneMultipliers: [{ label: 'Premium', x: 0, y: 0, w: 1, h: 1, multiplierBp: 15_000 }],
    };

    // 2x1 selection: one cell in premium zone, one standard
    const quote = computeQuote(pricingWithZones, { x: 0, y: 0, w: 2, h: 1 });
    expect(quote.lines).toHaveLength(2);
    const premiumLine = quote.lines.find((l) => l.label === 'Premium');
    const standardLine = quote.lines.find((l) => l.label === 'Standard');
    expect(premiumLine?.cells).toBe(1);
    expect(premiumLine?.amountCents).toBe(1500);
    expect(standardLine?.cells).toBe(1);
    expect(standardLine?.amountCents).toBe(1000);
    expect(quote.totalCents).toBe(2500);
  });

  it('uses integer arithmetic only (no floating point errors)', () => {
    // This test verifies we never get a fractional cent
    const pricing: PricingVersion = {
      ...LAUNCH_PRICING,
      centsPerLogicalPixel: 3, // 3 cents/pixel * 100 = 300 cents per cell
      zoneMultipliers: [
        { label: 'Odd', x: 0, y: 0, w: 100, h: 100, multiplierBp: 10_001 }, // 1.0001x
      ],
    };

    const quote = computeQuote(pricing, { x: 0, y: 0, w: 1, h: 1 });
    // 300 * 10001 / 10000 = 300.03 -> rounds to 300
    expect(Number.isInteger(quote.totalCents)).toBe(true);
  });

  it('preserves rect in the quote', () => {
    const rect: Rect = { x: 10, y: 20, w: 3, h: 4 };
    const quote = computeQuote(LAUNCH_PRICING, rect);
    expect(quote.rect).toEqual(rect);
  });

  it('throws on invalid pricing version', () => {
    const badPricing = { ...LAUNCH_PRICING, centsPerLogicalPixel: 0 };
    expect(() => computeQuote(badPricing, { x: 0, y: 0, w: 1, h: 1 })).toThrow(PricingError);
  });
});

describe('formatCents', () => {
  it('formats zero correctly', () => {
    expect(formatCents(0)).toBe('$0.00');
  });

  it('formats small amounts correctly', () => {
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(99)).toBe('$0.99');
  });

  it('formats whole dollars correctly', () => {
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(1000)).toBe('$10.00');
  });

  it('formats mixed amounts correctly', () => {
    expect(formatCents(1234)).toBe('$12.34');
    expect(formatCents(9999)).toBe('$99.99');
  });

  it('formats large amounts with comma separators', () => {
    expect(formatCents(100000)).toBe('$1,000.00');
    expect(formatCents(1000000)).toBe('$10,000.00');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
  });

  it('handles negative amounts', () => {
    expect(formatCents(-100)).toBe('-$1.00');
    expect(formatCents(-1234)).toBe('-$12.34');
  });

  it('throws on non-integer input', () => {
    expect(() => formatCents(12.34)).toThrow(PricingError);
    expect(() => formatCents(NaN)).toThrow(PricingError);
    expect(() => formatCents(Infinity)).toThrow(PricingError);
  });
});

describe('rectToLogicalPixels', () => {
  it('converts cell dimensions to logical pixels', () => {
    const result = rectToLogicalPixels({ x: 0, y: 0, w: 10, h: 5 });
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it('handles 1x1 cell', () => {
    const result = rectToLogicalPixels({ x: 0, y: 0, w: 1, h: 1 });
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });
});

describe('LAUNCH_PRICING constant', () => {
  it('has expected default values', () => {
    expect(LAUNCH_PRICING.version).toBe(1);
    expect(LAUNCH_PRICING.currency).toBe('USD');
    expect(LAUNCH_PRICING.centsPerLogicalPixel).toBe(10);
    expect(LAUNCH_PRICING.minCells).toBe(MIN_SELECTION_CELLS);
    expect(LAUNCH_PRICING.maxCells).toBe(MAX_SELECTION_CELLS);
    expect(LAUNCH_PRICING.zoneMultipliers).toEqual([]);
  });
});
