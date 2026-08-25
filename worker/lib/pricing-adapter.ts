/**
 * Adapter between the database's snake_case pricing row and the camelCase
 * `PricingVersion` the shared pricing engine expects.
 *
 * Its real job is validation. `zone_multipliers` is a jsonb column, so from
 * TypeScript's point of view it is `unknown` — an admin-authored zone with a
 * missing field or a string where a number belongs would otherwise flow straight
 * into the price calculation. Anything malformed is dropped, loudly.
 */

import type { PricingVersion, ZoneMultiplier } from '@shared/pricing';
import { GRID_SIZE } from '@shared/constants';
import type { PricingVersionRow } from './supabase';

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate a single zone. Returns null if it is unusable.
 *
 * A zone that is silently dropped changes the price, so `pricingVersionFromRow`
 * reports how many were dropped and the caller logs it.
 */
function normaliseZone(value: unknown): ZoneMultiplier | null {
  if (typeof value !== 'object' || value === null) return null;
  const zone = value as Record<string, unknown>;

  const label = typeof zone.label === 'string' ? zone.label.slice(0, 40) : '';
  const x = zone.x;
  const y = zone.y;
  const w = zone.w;
  const h = zone.h;
  const multiplierBp = zone.multiplierBp;

  if (label === '') return null;
  if (!isNonNegativeInt(x) || !isNonNegativeInt(y)) return null;
  if (!isPositiveInt(w) || !isPositiveInt(h)) return null;
  if (!isPositiveInt(multiplierBp)) return null;
  if (x + w > GRID_SIZE || y + h > GRID_SIZE) return null;
  // A 100x multiplier is certainly a typo, not a pricing strategy.
  if (multiplierBp > 1_000_000) return null;

  return { label, x, y, w, h, multiplierBp };
}

export interface PricingConversion {
  readonly pricing: PricingVersion;
  readonly droppedZones: number;
}

export function pricingVersionFromRowChecked(row: PricingVersionRow): PricingConversion {
  const rawZones = Array.isArray(row.zone_multipliers) ? row.zone_multipliers : [];
  const zones: ZoneMultiplier[] = [];
  let dropped = 0;

  for (const candidate of rawZones) {
    const zone = normaliseZone(candidate);
    if (zone === null) dropped += 1;
    else zones.push(zone);
  }

  return {
    pricing: {
      version: row.version,
      currency: 'USD',
      centsPerLogicalPixel: row.cents_per_logical_pixel,
      // Order is significant (first match wins) and is preserved exactly as
      // stored, so the TypeScript and PL/pgSQL engines agree.
      zoneMultipliers: zones,
      minCells: row.min_cells,
      maxCells: row.max_cells,
      reservationTtlSeconds: row.reservation_ttl_seconds,
    },
    droppedZones: dropped,
  };
}

export function pricingVersionFromRow(row: PricingVersionRow): PricingVersion {
  return pricingVersionFromRowChecked(row).pricing;
}
