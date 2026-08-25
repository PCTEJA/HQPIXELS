-- =============================================================================
-- HQPixels — pgTAP Payment Flow Tests
-- =============================================================================
-- Verifies open_checkout(), settle_payment(), refunds, disputes, and expiry.
-- Run with: psql -d hqpixels -f supabase/tests/004_payment_flow.sql
-- =============================================================================

BEGIN;
SELECT plan(38);

-- ---------------------------------------------------------------------------
-- Setup: Create test users and a complete reservation
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dave.pay@test.com', now(), '{"name":"Dave Pay"}'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'erin.pay@test.com', now(), '{"name":"Erin Pay"}'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'admin.pay@test.com', now(), '{"name":"Admin Pay"}')
ON CONFLICT (id) DO NOTHING;

-- Make admin user an admin
SELECT public.grant_admin('admin.pay@test.com');

-- Create a reservation ready for checkout
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.reserve_cells(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 70, 70, 2, 1, 1, 2000, 2000,
    '{}'::jsonb, 'v1', null
  );
  PERFORM set_config('test.pay_res_id', (v_result -> 'reservation' ->> 'id'), true);
  
  -- Set placement details to move to ready_for_checkout
  v_result := public.set_placement_details(
    (current_setting('test.pay_res_id'))::uuid,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Dave Widgets', 'A blue widget on a white background',
    'https://widgets.example.org/launch', 'widgets.example.org',
    'asset_abc123', '/img/asset_abc123', 600, 300, 45000, 'image/png',
    'auto_pass', '[{"check":"magic_bytes","result":"pass","detail":"png"}]'::jsonb
  );
  PERFORM set_config('test.pay_placement_id', (v_result ->> 'placementId'), true);
  PERFORM set_config('test.details_ok', (v_result ->> 'ok')::text, true);
  PERFORM set_config('test.details_state', (v_result ->> 'state'), true);
END;
$$;

SELECT ok(
  (current_setting('test.details_ok'))::boolean,
  'complete details succeeds'
);

SELECT is(
  current_setting('test.details_state'),
  'ready_for_checkout',
  'complete details move the reservation to ready_for_checkout'
);

-- ---------------------------------------------------------------------------
-- Checkout Amount Validation
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  format(
    $q$ SELECT public.open_checkout(%L::uuid, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          'cs_wrong', 1, now() + interval '31 minutes') $q$,
    current_setting('test.pay_res_id')
  ),
  NULL,
  NULL,
  'opening checkout for the wrong amount aborts'
);

-- ---------------------------------------------------------------------------
-- Session Cannot Outlive Reservation
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  format(
    $q$ SELECT public.open_checkout(%L::uuid, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          'cs_late', 2000, now() + interval '10 days') $q$,
    current_setting('test.pay_res_id')
  ),
  NULL,
  NULL,
  'a Checkout Session cannot outlive the reservation'
);

-- ---------------------------------------------------------------------------
-- Successful Checkout Creation
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.open_checkout(
    (current_setting('test.pay_res_id'))::uuid,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'cs_test_001', 2000, now() + interval '31 minutes'
  );
  PERFORM set_config('test.checkout_ok', (v_result ->> 'ok')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.checkout_ok'))::boolean,
  'opening checkout succeeds'
);

SELECT is(
  (SELECT state FROM public.reservations 
   WHERE id = (current_setting('test.pay_res_id'))::uuid),
  'checkout_created'::reservation_state,
  'reservation is now checkout_created'
);

-- ---------------------------------------------------------------------------
-- Double-Click Prevention
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.open_checkout(
    (current_setting('test.pay_res_id'))::uuid,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'cs_test_002', 2000, now() + interval '31 minutes'
  );
  PERFORM set_config('test.double_code', v_result ->> 'code', true);
  PERFORM set_config('test.double_existing', v_result ->> 'existingSessionId', true);
END;
$$;

SELECT is(
  current_setting('test.double_code'),
  'checkout_already_open',
  'a second concurrent Checkout Session is refused'
);

SELECT is(
  current_setting('test.double_existing'),
  'cs_test_001',
  'existing session ID is returned'
);

SELECT is(
  (SELECT count(*)::integer FROM public.payments 
   WHERE reservation_id = (current_setting('test.pay_res_id'))::uuid),
  1,
  'only one payment row exists for the reservation'
);

-- ---------------------------------------------------------------------------
-- Settlement Validation
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Wrong amount
  v_result := public.settle_payment(
    (current_setting('test.pay_res_id'))::uuid,
    'cs_test_001', 1, 'usd', 'pi_1', 'ch_1', 'cus_1', true
  );
  PERFORM set_config('test.settle_wrong_amount', v_result ->> 'code', true);
  
  -- Wrong currency
  v_result := public.settle_payment(
    (current_setting('test.pay_res_id'))::uuid,
    'cs_test_001', 2000, 'eur', 'pi_1', 'ch_1', 'cus_1', true
  );
  PERFORM set_config('test.settle_wrong_currency', v_result ->> 'code', true);
  
  -- Forged session
  v_result := public.settle_payment(
    (current_setting('test.pay_res_id'))::uuid,
    'cs_forged', 2000, 'usd', 'pi_x', 'ch_x', null, true
  );
  PERFORM set_config('test.settle_forged', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.settle_wrong_amount'),
  'amount_mismatch',
  'settling with the wrong amount is refused'
);

SELECT is(
  current_setting('test.settle_wrong_currency'),
  'currency_mismatch',
  'settling in the wrong currency is refused'
);

SELECT is(
  current_setting('test.settle_forged'),
  'payment_not_found',
  'an unknown session id cannot create a fulfilment'
);

SELECT is(
  (SELECT status FROM public.placements 
   WHERE id = (current_setting('test.pay_placement_id'))::uuid),
  'draft'::placement_status,
  'placement is still unpublished after the forged attempts'
);

-- ---------------------------------------------------------------------------
-- Successful Settlement
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.settle_payment(
    (current_setting('test.pay_res_id'))::uuid,
    'cs_test_001', 2000, 'usd', 'pi_1', 'ch_1', 'cus_1', true
  );
  PERFORM set_config('test.settle_ok', (v_result ->> 'ok')::text, true);
  PERFORM set_config('test.settle_already', (v_result ->> 'alreadySettled')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.settle_ok'))::boolean,
  'a correct settlement succeeds'
);

SELECT ok(
  NOT (current_setting('test.settle_already'))::boolean,
  'first settlement is not marked as already settled'
);

SELECT is(
  (SELECT state FROM public.reservations 
   WHERE id = (current_setting('test.pay_res_id'))::uuid),
  'paid_pending_review'::reservation_state,
  'reservation moves to paid_pending_review'
);

SELECT is(
  (SELECT status FROM public.placements 
   WHERE id = (current_setting('test.pay_placement_id'))::uuid),
  'pending_review'::placement_status,
  'placement moves to pending_review, not active'
);

SELECT ok(
  (SELECT founding_buyer FROM public.profiles 
   WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  'founding-buyer badge is awarded from the payment ledger'
);

-- ---------------------------------------------------------------------------
-- Duplicate Webhook Idempotency
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.settle_payment(
    (current_setting('test.pay_res_id'))::uuid,
    'cs_test_001', 2000, 'usd', 'pi_1', 'ch_1', 'cus_1', true
  );
  PERFORM set_config('test.dup_ok', (v_result ->> 'ok')::text, true);
  PERFORM set_config('test.dup_already', (v_result ->> 'alreadySettled')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.dup_ok'))::boolean,
  'a duplicate settlement is idempotent'
);

SELECT ok(
  (current_setting('test.dup_already'))::boolean,
  'duplicate is marked as already settled'
);

SELECT is(
  (SELECT count(*)::integer FROM public.payments 
   WHERE reservation_id = (current_setting('test.pay_res_id'))::uuid),
  1,
  'still exactly one payment row'
);

-- ---------------------------------------------------------------------------
-- Late Events Don't Undo Settlement
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.expire_checkout('cs_test_001');
  PERFORM set_config('test.late_expire', v_result ->> 'ignored', true);
  
  v_result := public.fail_payment('cs_test_001', 'card_declined', true);
  PERFORM set_config('test.late_fail', v_result ->> 'ignored', true);
END;
$$;

SELECT is(
  current_setting('test.late_expire'),
  'not_open',
  'a late session-expired event is ignored after settlement'
);

SELECT is(
  current_setting('test.late_fail'),
  'already_settled',
  'a late failure event is ignored after settlement'
);

SELECT is(
  (SELECT status FROM public.payments 
   WHERE reservation_id = (current_setting('test.pay_res_id'))::uuid),
  'succeeded'::payment_status,
  'settled payment survives the late events'
);

-- ---------------------------------------------------------------------------
-- Approval Flow
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
  v_manifest_before integer;
BEGIN
  SELECT manifest_version INTO v_manifest_before FROM public.wall_state WHERE id;
  PERFORM set_config('test.manifest_before', v_manifest_before::text, true);
  
  v_result := public.approve_placement(
    (current_setting('test.pay_placement_id'))::uuid,
    'ffffffff-ffff-4fff-8fff-ffffffffffff', 'looks fine'
  );
  PERFORM set_config('test.approve_ok', (v_result ->> 'ok')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.approve_ok'))::boolean,
  'admin approval succeeds'
);

SELECT is(
  (SELECT status FROM public.placements 
   WHERE id = (current_setting('test.pay_placement_id'))::uuid),
  'active'::placement_status,
  'placement is now active'
);

SELECT is(
  (SELECT state FROM public.reservations 
   WHERE id = (current_setting('test.pay_res_id'))::uuid),
  'active'::reservation_state,
  'reservation is now active'
);

SELECT ok(
  (SELECT manifest_version FROM public.wall_state WHERE id) > 
    (current_setting('test.manifest_before'))::integer,
  'approval bumped the manifest version'
);

-- ---------------------------------------------------------------------------
-- Expiry Does NOT Release Paid Reservations
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
  v_cells_before integer;
BEGIN
  SELECT count(*)::integer INTO v_cells_before 
  FROM public.pixel_cells 
  WHERE reservation_id = (current_setting('test.pay_res_id'))::uuid;
  
  PERFORM set_config('test.cells_before_sweep', v_cells_before::text, true);
  
  v_result := public.expire_reservations(0, 100);
END;
$$;

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells 
   WHERE reservation_id = (current_setting('test.pay_res_id'))::uuid),
  (current_setting('test.cells_before_sweep'))::integer,
  'expiry sweep never releases a paid reservation'
);

-- ---------------------------------------------------------------------------
-- Approval Requires Payment
-- ---------------------------------------------------------------------------
-- Create an unpaid reservation
DO $$
DECLARE
  v_result jsonb;
  v_unpaid_res_id uuid;
BEGIN
  v_result := public.reserve_cells(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 75, 75, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  v_unpaid_res_id := (v_result -> 'reservation' ->> 'id')::uuid;
  
  SELECT id INTO v_unpaid_res_id 
  FROM public.placements 
  WHERE reservation_id = v_unpaid_res_id;
  
  PERFORM set_config('test.unpaid_placement_id', v_unpaid_res_id::text, true);
END;
$$;

DO $$
DECLARE
  v_result jsonb;
  v_draft_placement_id uuid;
BEGIN
  SELECT p.id INTO v_draft_placement_id
  FROM public.placements p
  JOIN public.reservations r ON r.id = p.reservation_id
  WHERE p.status = 'draft' AND r.owner_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  LIMIT 1;

  v_result := public.approve_placement(
    v_draft_placement_id,
    'ffffffff-ffff-4fff-8fff-ffffffffffff', 'sneaky'
  );
  PERFORM set_config('test.unpaid_approve_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.unpaid_approve_code'),
  'payment_not_settled',
  'approving an unpaid placement is refused'
);

-- ---------------------------------------------------------------------------
-- Read Functions Are STABLE (Cannot Write)
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT provolatile FROM pg_proc WHERE proname = 'reservation_status'),
  's',
  'reservation_status is declared STABLE (cannot write)'
);

SELECT is(
  (SELECT provolatile FROM pg_proc WHERE proname = 'reservation_detail'),
  's',
  'reservation_detail is declared STABLE (cannot write)'
);

SELECT is(
  (SELECT provolatile FROM pg_proc WHERE proname = 'buyer_dashboard'),
  's',
  'buyer_dashboard is declared STABLE (cannot write)'
);

SELECT * FROM finish();
ROLLBACK;
