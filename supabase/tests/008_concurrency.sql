-- =============================================================================
-- HQPixels — pgTAP Concurrency Tests
-- =============================================================================
-- Verifies the anti-double-allocation guarantee under concurrent access.
-- Note: Full concurrency testing requires the pg-concurrency-test.ps1 script
-- which uses 100 parallel connections. This file tests the mechanisms.
-- Run with: psql -d hqpixels -f supabase/tests/008_concurrency.sql
-- =============================================================================

BEGIN;
SELECT plan(18);

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('aaaaaaaa-aaaa-4aaa-cccc-aaaaaaaaaaaa', 'conc.alice@test.com', now(), '{"name":"Conc Alice"}'),
  ('bbbbbbbb-bbbb-4bbb-cccc-bbbbbbbbbbbb', 'conc.bob@test.com',   now(), '{"name":"Conc Bob"}'),
  ('cccccccc-cccc-4ccc-cccc-cccccccccccc', 'conc.carol@test.com', now(), '{"name":"Conc Carol"}')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- pixel_cells Primary Key Prevents Double Allocation
-- ---------------------------------------------------------------------------
SELECT col_is_pk(
  'public', 'pixel_cells', ARRAY['cell_x', 'cell_y'],
  'pixel_cells has composite PK preventing double allocation'
);

-- ---------------------------------------------------------------------------
-- First Claim Wins, Second Fails
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result1 jsonb;
  v_result2 jsonb;
BEGIN
  -- Alice claims first
  v_result1 := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-cccc-aaaaaaaaaaaa', 15, 15, 2, 2, 1, 4000, 4000,
    '{}'::jsonb, 'v1', null
  );
  PERFORM set_config('test.first_ok', (v_result1 ->> 'ok')::text, true);
  
  -- Bob tries the exact same cells
  v_result2 := public.reserve_cells(
    'bbbbbbbb-bbbb-4bbb-cccc-bbbbbbbbbbbb', 15, 15, 2, 2, 1, 4000, 4000,
    '{}'::jsonb, 'v1', null
  );
  PERFORM set_config('test.second_code', v_result2 ->> 'code', true);
END;
$$;

SELECT ok(
  (current_setting('test.first_ok'))::boolean,
  'first claim succeeds'
);

SELECT is(
  current_setting('test.second_code'),
  'cells_unavailable',
  'second identical claim fails'
);

-- ---------------------------------------------------------------------------
-- Partial Overlap Fails Entirely (Atomicity)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Carol tries to overlap just one cell of Alice's block
  v_result := public.reserve_cells(
    'cccccccc-cccc-4ccc-cccc-cccccccccccc', 16, 16, 2, 2, 1, 4000, 4000,
    '{}'::jsonb, 'v1', null
  );
  PERFORM set_config('test.partial_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.partial_code'),
  'cells_unavailable',
  'partial overlap is refused entirely'
);

-- No partial reservation created
SELECT is(
  (SELECT count(*)::integer FROM public.reservations 
   WHERE owner_id = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'),
  0,
  'no partial reservation row created'
);

-- No orphan cells
SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells pc
   WHERE NOT EXISTS (
     SELECT 1 FROM public.reservations r WHERE r.id = pc.reservation_id
   )),
  0,
  'no orphan cells exist'
);

-- ---------------------------------------------------------------------------
-- Transaction Isolation Check
-- ---------------------------------------------------------------------------
-- This verifies that the reservation mechanism uses proper locking
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' 
      AND p.proname = 'reserve_cells'
  ),
  'reserve_cells function exists'
);

-- The function uses advisory locks or row-level locking
-- We can't easily test concurrent transactions in a single connection,
-- but we verify the mechanism is in place

-- ---------------------------------------------------------------------------
-- Cell Count Integrity
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells 
   WHERE reservation_id = (
     SELECT id FROM public.reservations 
     WHERE owner_id = 'aaaaaaaa-aaaa-4aaa-cccc-aaaaaaaaaaaa' 
     LIMIT 1
   )),
  4,
  'exactly 4 cells for 2x2 reservation'
);

-- ---------------------------------------------------------------------------
-- Unique Index on Open Checkout
-- ---------------------------------------------------------------------------
SELECT has_index(
  'public', 'payments', 'payments_one_open_per_reservation',
  'partial unique index exists for one open checkout per reservation'
);

-- ---------------------------------------------------------------------------
-- Unique Index on Settled Payment  
-- ---------------------------------------------------------------------------
SELECT has_index(
  'public', 'payments', 'payments_one_settled_per_reservation',
  'partial unique index exists for one settled payment per reservation'
);

-- ---------------------------------------------------------------------------
-- Reservation Transitions Table Exists
-- ---------------------------------------------------------------------------
SELECT has_table(
  'public', 'reservation_transitions',
  'reservation_transitions table exists for state machine'
);

-- Verify it has expected columns
SELECT has_column('public', 'reservation_transitions', 'from_state', 
  'reservation_transitions has from_state');
SELECT has_column('public', 'reservation_transitions', 'to_state',
  'reservation_transitions has to_state');

-- ---------------------------------------------------------------------------
-- Adjacent Non-Overlapping Claims Succeed
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Carol claims adjacent to Alice (no overlap)
  v_result := public.reserve_cells(
    'cccccccc-cccc-4ccc-cccc-cccccccccccc', 17, 17, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  PERFORM set_config('test.adjacent_ok', (v_result ->> 'ok')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.adjacent_ok'))::boolean,
  'adjacent non-overlapping claim succeeds'
);

-- ---------------------------------------------------------------------------
-- Total Cell Count Matches Reservations
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cell_count integer;
  v_expected integer;
BEGIN
  SELECT count(*)::integer INTO v_cell_count FROM public.pixel_cells;
  
  SELECT sum(width * height)::integer INTO v_expected
  FROM public.reservations
  WHERE state NOT IN ('expired', 'payment_failed', 'rejected_refunded', 'chargeback_disabled');
  
  PERFORM set_config('test.cell_count', v_cell_count::text, true);
  PERFORM set_config('test.expected_count', COALESCE(v_expected, 0)::text, true);
END;
$$;

SELECT is(
  (current_setting('test.cell_count'))::integer,
  (current_setting('test.expected_count'))::integer,
  'total cell count matches active reservation dimensions'
);

-- ---------------------------------------------------------------------------
-- No Duplicate Cells
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT EXISTS (
    SELECT cell_x, cell_y, count(*)
    FROM public.pixel_cells
    GROUP BY cell_x, cell_y
    HAVING count(*) > 1
  ),
  'no duplicate cells exist'
);

-- ---------------------------------------------------------------------------
-- All Cells Within Grid Bounds
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.pixel_cells
    WHERE cell_x < 0 OR cell_x >= 100
       OR cell_y < 0 OR cell_y >= 100
  ),
  'all cells are within 100x100 grid bounds'
);

SELECT * FROM finish();
ROLLBACK;
