-- =============================================================================
-- HQPixels — pgTAP Reservation Flow Tests
-- =============================================================================
-- Verifies reserve_cells(), state transitions, and the anti-double-allocation
-- guarantees.
-- Run with: psql -d hqpixels -f supabase/tests/003_reservation_flow.sql
-- =============================================================================

BEGIN;
SELECT plan(32);

-- ---------------------------------------------------------------------------
-- Setup: Create test users via auth.users (triggers create profiles)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alice.res@test.com', now(), '{"name":"Alice Res"}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bob.res@test.com',   now(), '{"name":"Bob Res"}'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'carol.res@test.com', null,  '{"name":"Carol Res"}')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Basic Reservation Success
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
  v_res_id uuid;
BEGIN
  -- Reserve a 2x2 block at (10,10)
  v_result := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 10, 2, 2, 1, 4000, 4000,
    '{"lines":[]}'::jsonb, 'v1', '203.0.113.0/24'
  );
  
  PERFORM set_config('test.res_ok', (v_result ->> 'ok')::text, true);
  PERFORM set_config('test.res_id', (v_result -> 'reservation' ->> 'id'), true);
END;
$$;

SELECT ok(
  (current_setting('test.res_ok'))::boolean,
  'a valid reservation succeeds'
);

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells 
   WHERE reservation_id = (current_setting('test.res_id'))::uuid),
  4,
  'four cells are recorded for 2x2 reservation'
);

SELECT is(
  (SELECT status FROM public.placements 
   WHERE reservation_id = (current_setting('test.res_id'))::uuid),
  'draft'::placement_status,
  'a draft placement is created alongside'
);

SELECT is(
  (SELECT state FROM public.reservations 
   WHERE id = (current_setting('test.res_id'))::uuid),
  'reserved'::reservation_state,
  'new reservation starts in reserved state'
);

-- ---------------------------------------------------------------------------
-- Overlapping Claim Prevention
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Try to reserve overlapping cells (11,11 overlaps with Alice's 10-12 range)
  v_result := public.reserve_cells(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 11, 11, 2, 2, 1, 4000, 4000,
    '{}'::jsonb, 'v1', null
  );
  
  PERFORM set_config('test.overlap_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.overlap_code'),
  'cells_unavailable',
  'an overlapping claim is refused'
);

SELECT is(
  (SELECT count(*)::integer FROM public.reservations 
   WHERE owner_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'the refused claim created no reservation row (no partial reservation)'
);

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells),
  4,
  'the refused claim created no cells'
);

-- ---------------------------------------------------------------------------
-- Non-Overlapping Claim Success
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Reserve a non-overlapping block at (20,20)
  v_result := public.reserve_cells(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 20, 20, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  
  PERFORM set_config('test.neighbor_ok', (v_result ->> 'ok')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.neighbor_ok'))::boolean,
  'a non-overlapping neighbour succeeds'
);

-- ---------------------------------------------------------------------------
-- Price Tampering Prevention
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Try to claim at a fraudulent price
  v_result := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 40, 40, 1, 1, 1,
    1, -- buyer claims it costs one cent
    1000, '{}'::jsonb, 'v1', null
  );
  
  PERFORM set_config('test.tamper_code', v_result ->> 'code', true);
  PERFORM set_config('test.tamper_correct', (v_result ->> 'totalCents'), true);
END;
$$;

SELECT is(
  current_setting('test.tamper_code'),
  'quote_changed',
  'client-supplied total that disagrees is refused'
);

SELECT is(
  (current_setting('test.tamper_correct'))::integer,
  1000,
  'the correct price is returned'
);

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells WHERE cell_x = 40 AND cell_y = 40),
  0,
  'the tampered request reserved nothing'
);

-- ---------------------------------------------------------------------------
-- Worker/DB Price Disagreement
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ SELECT public.reserve_cells(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 41, 41, 1, 1, 1, 
        1000, 1, -- worker says 1 cent, but client says 1000
        '{}'::jsonb, 'v1', null) $q$,
  NULL,
  NULL,
  'a Worker/DB price disagreement aborts loudly'
);

-- ---------------------------------------------------------------------------
-- Email Verification Requirement
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Carol has unverified email
  v_result := public.reserve_cells(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 50, 50, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  
  PERFORM set_config('test.unverified_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.unverified_code'),
  'email_unverified',
  'unverified email cannot reserve'
);

-- ---------------------------------------------------------------------------
-- Unknown Owner
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.reserve_cells(
    '99999999-9999-4999-8999-999999999999', 51, 51, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  
  PERFORM set_config('test.unknown_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.unknown_code'),
  'owner_not_found',
  'unknown owner cannot reserve'
);

-- ---------------------------------------------------------------------------
-- Inactive Pricing Version
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 52, 52, 1, 1, 999, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  
  PERFORM set_config('test.inactive_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.inactive_code'),
  'pricing_version_inactive',
  'an inactive pricing version is refused'
);

-- ---------------------------------------------------------------------------
-- Out of Bounds
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 99, 99, 5, 5, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  
  PERFORM set_config('test.oob_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.oob_code'),
  'invalid_rect',
  'out-of-bounds rectangle is refused'
);

-- ---------------------------------------------------------------------------
-- Concurrent Reservation Cap (3 per buyer)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Alice already has 1 reservation. Add 2 more (should succeed).
  v_result := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 60, 60, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  PERFORM set_config('test.cap2_ok', (v_result ->> 'ok')::text, true);
  
  v_result := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 61, 61, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  PERFORM set_config('test.cap3_ok', (v_result ->> 'ok')::text, true);
  
  -- The 4th should fail (cap is 3)
  v_result := public.reserve_cells(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 62, 62, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  PERFORM set_config('test.cap4_code', v_result ->> 'code', true);
END;
$$;

SELECT ok(
  (current_setting('test.cap2_ok'))::boolean,
  'second open reservation allowed'
);

SELECT ok(
  (current_setting('test.cap3_ok'))::boolean,
  'third open reservation allowed'
);

SELECT is(
  current_setting('test.cap4_code'),
  'too_many_open_reservations',
  'fourth concurrent reservation is refused'
);

-- ---------------------------------------------------------------------------
-- Immutability Triggers
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ UPDATE public.reservations SET quoted_total_cents = 1
      WHERE id = (SELECT id FROM public.reservations ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'reservation total cannot be edited'
);

SELECT throws_ok(
  $q$ UPDATE public.reservations SET cell_x = cell_x + 1
      WHERE id = (SELECT id FROM public.reservations ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'reservation geometry cannot be edited'
);

SELECT throws_ok(
  $q$ UPDATE public.reservations SET owner_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      WHERE id = (SELECT id FROM public.reservations ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'reservation owner cannot be transferred'
);

SELECT throws_ok(
  $q$ UPDATE public.reservations SET expires_at = now() + interval '30 days'
      WHERE id = (SELECT id FROM public.reservations ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'reservation hold cannot be extended'
);

-- ---------------------------------------------------------------------------
-- State Machine Enforcement
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ UPDATE public.reservations SET state = 'active'
      WHERE id = (SELECT id FROM public.reservations ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'reserved cannot jump straight to active'
);

SELECT throws_ok(
  $q$ UPDATE public.reservations SET state = 'paid_pending_review'
      WHERE id = (SELECT id FROM public.reservations ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'reserved cannot jump straight to paid_pending_review'
);

-- ---------------------------------------------------------------------------
-- Placement Immutability
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ UPDATE public.placements SET cell_x = cell_x + 1
      WHERE id = (SELECT id FROM public.placements ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'placement cannot be moved'
);

-- ---------------------------------------------------------------------------
-- Cell Outside Reservation Prevention
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  format(
    $q$ UPDATE public.pixel_cells SET cell_x = 0
        WHERE cell_x = 10 AND cell_y = 10 
          AND reservation_id = %L::uuid $q$,
    current_setting('test.res_id')
  ),
  NULL,
  NULL,
  'a cell cannot be placed outside its reservation'
);

-- ---------------------------------------------------------------------------
-- Incomplete Placement Cannot Be Activated
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ UPDATE public.placements SET status = 'active'
      WHERE id = (SELECT id FROM public.placements ORDER BY created_at LIMIT 1) $q$,
  NULL,
  NULL,
  'an incomplete placement cannot be marked active'
);

SELECT * FROM finish();
ROLLBACK;
