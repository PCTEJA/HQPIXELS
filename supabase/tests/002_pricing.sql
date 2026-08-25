-- =============================================================================
-- HQPixels — pgTAP Pricing Tests
-- =============================================================================
-- Verifies quote_total_cents() matches shared/pricing.ts exactly.
-- Run with: psql -d hqpixels -f supabase/tests/002_pricing.sql
-- =============================================================================

BEGIN;
SELECT plan(14);

-- ---------------------------------------------------------------------------
-- Setup: Get the active pricing version
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pv_id uuid;
BEGIN
  SELECT id INTO v_pv_id FROM public.pricing_versions WHERE is_active;
  PERFORM set_config('test.pricing_version_id', v_pv_id::text, true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Basic Pricing (10 cents per logical pixel, 100 px per cell = 1000 cents/cell)
-- ---------------------------------------------------------------------------
SELECT is(
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 0, 0, 1, 1
  ),
  1000,
  'one cell costs exactly 1000 cents ($10.00)'
);

SELECT is(
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 5, 5, 10, 10
  ),
  100000,
  '10x10 cells cost 100000 cents ($1000.00)'
);

SELECT is(
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 0, 0, 2, 2
  ),
  4000,
  '2x2 cells cost 4000 cents ($40.00)'
);

-- ---------------------------------------------------------------------------
-- Position Independence (flat pricing has no zone multipliers)
-- ---------------------------------------------------------------------------
SELECT is(
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 0, 0, 3, 4
  ),
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 90, 80, 3, 4
  ),
  'flat pricing is position independent'
);

-- ---------------------------------------------------------------------------
-- Boundary Validation
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  format(
    'SELECT public.quote_total_cents(%L::uuid, 99, 0, 2, 1)',
    current_setting('test.pricing_version_id')
  ),
  NULL,
  NULL,
  'rectangle past the right edge is rejected'
);

SELECT throws_ok(
  format(
    'SELECT public.quote_total_cents(%L::uuid, 0, 99, 1, 2)',
    current_setting('test.pricing_version_id')
  ),
  NULL,
  NULL,
  'rectangle past the bottom edge is rejected'
);

SELECT throws_ok(
  format(
    'SELECT public.quote_total_cents(%L::uuid, 0, 0, 0, 1)',
    current_setting('test.pricing_version_id')
  ),
  NULL,
  NULL,
  'zero-width rectangle is rejected'
);

SELECT throws_ok(
  format(
    'SELECT public.quote_total_cents(%L::uuid, 0, 0, 1, 0)',
    current_setting('test.pricing_version_id')
  ),
  NULL,
  NULL,
  'zero-height rectangle is rejected'
);

SELECT throws_ok(
  format(
    'SELECT public.quote_total_cents(%L::uuid, 0, 0, 60, 60)',
    current_setting('test.pricing_version_id')
  ),
  NULL,
  NULL,
  'oversized rectangle (> 2500 cells) is rejected'
);

-- ---------------------------------------------------------------------------
-- Zone Multipliers
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_zone_pv_id uuid;
  v_total integer;
BEGIN
  -- Create a pricing version with a zone multiplier for testing
  INSERT INTO public.pricing_versions (
    version, cents_per_logical_pixel, zone_multipliers, is_active, notes
  ) VALUES (
    999, 10,
    '[{"label":"Center","x":0,"y":0,"w":1,"h":1,"multiplierBp":15000}]'::jsonb,
    false, 'pgTAP zone multiplier test fixture'
  ) RETURNING id INTO v_zone_pv_id;

  -- 4 cells at (0,0) 2x2: cell (0,0) is 1.5x (1500), other 3 are 1.0x (1000 each) = 4500
  v_total := public.quote_total_cents(v_zone_pv_id, 0, 0, 2, 2);
  
  PERFORM set_config('test.zone_result', v_total::text, true);
END;
$$;

SELECT is(
  (current_setting('test.zone_result'))::integer,
  4500,
  'zone multiplier applies to matching cells only (1500 + 1000 + 1000 + 1000 = 4500)'
);

-- ---------------------------------------------------------------------------
-- Integer Math Verification (no floats)
-- ---------------------------------------------------------------------------
SELECT is(
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 0, 0, 1, 1
  )::numeric % 1,
  0::numeric,
  'result is always an integer (no fractional cents)'
);

-- ---------------------------------------------------------------------------
-- Pricing Version Must Be Active
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_inactive_pv_id uuid;
BEGIN
  SELECT id INTO v_inactive_pv_id 
  FROM public.pricing_versions 
  WHERE NOT is_active 
  LIMIT 1;
  
  PERFORM set_config('test.inactive_pv_id', v_inactive_pv_id::text, true);
END;
$$;

-- Inactive version CAN still be quoted (for historical reservations),
-- but reserve_cells rejects it. This tests basic quote functionality.
SELECT lives_ok(
  format(
    'SELECT public.quote_total_cents(%L::uuid, 0, 0, 1, 1)',
    current_setting('test.inactive_pv_id')
  ),
  'quote_total_cents works with any valid pricing version'
);

-- ---------------------------------------------------------------------------
-- TypeScript Parity Check
-- ---------------------------------------------------------------------------
-- These values must match shared/pricing.ts computeQuote() exactly.
-- If these fail, the Worker and DB disagree on price computation.
SELECT is(
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 0, 0, 5, 5
  ),
  25000,
  'TS parity: 5x5 = 25 cells * 1000 = 25000 cents'
);

SELECT is(
  public.quote_total_cents(
    (current_setting('test.pricing_version_id'))::uuid, 50, 50, 1, 1
  ),
  1000,
  'TS parity: center single cell = 1000 cents'
);

SELECT * FROM finish();
ROLLBACK;
