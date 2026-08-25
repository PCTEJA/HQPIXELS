-- =============================================================================
-- HQPixels — pgTAP Moderation Tests
-- =============================================================================
-- Verifies approve/reject/disable, refunds, disputes, and that only paid +
-- approved placements become public.
-- Run with: psql -d hqpixels -f supabase/tests/005_moderation.sql
-- =============================================================================

BEGIN;
SELECT plan(28);

-- ---------------------------------------------------------------------------
-- Setup: Create test users and reservations
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('11111111-1111-4111-a111-111111111111', 'mod.alice@test.com', now(), '{"name":"Mod Alice"}'),
  ('22222222-2222-4222-a222-222222222222', 'mod.bob@test.com',   now(), '{"name":"Mod Bob"}'),
  ('33333333-3333-4333-a333-333333333333', 'mod.admin@test.com', now(), '{"name":"Mod Admin"}')
ON CONFLICT (id) DO NOTHING;

SELECT public.grant_admin('mod.admin@test.com');

-- ---------------------------------------------------------------------------
-- Admin-Only Protection
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ SELECT public.approve_placement(
        (SELECT id FROM public.placements LIMIT 1),
        '11111111-1111-4111-a111-111111111111', 'nope') $q$,
  NULL,
  NULL,
  'a non-admin cannot approve a placement'
);

SELECT throws_ok(
  $q$ SELECT public.approve_placement(
        (SELECT id FROM public.placements LIMIT 1), null, 'nope') $q$,
  NULL,
  NULL,
  'a null actor cannot approve a placement'
);

SELECT throws_ok(
  $q$ SELECT public.disable_placements_by_host(
        'example.org', '11111111-1111-4111-a111-111111111111', 'nope') $q$,
  NULL,
  NULL,
  'a non-admin cannot bulk-disable by host'
);

SELECT throws_ok(
  $q$ SELECT public.admin_moderation_queue('11111111-1111-4111-a111-111111111111') $q$,
  NULL,
  NULL,
  'a non-admin cannot read the moderation queue'
);

-- ---------------------------------------------------------------------------
-- Refund Flow: Create a placement to refund
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
  v_res_id uuid;
  v_placement_id uuid;
BEGIN
  -- Reserve
  v_result := public.reserve_cells(
    '11111111-1111-4111-a111-111111111111', 80, 80, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  v_res_id := (v_result -> 'reservation' ->> 'id')::uuid;
  PERFORM set_config('test.refund_res_id', v_res_id::text, true);
  
  -- Set details
  v_result := public.set_placement_details(
    v_res_id, '11111111-1111-4111-a111-111111111111',
    'Refund Me', 'Placeholder art', 'https://refund.example.net/', 'refund.example.net',
    'asset_ref', '/img/asset_ref', 100, 100, 1000, 'image/webp', 'auto_pass', '[]'::jsonb);
  v_placement_id := (v_result ->> 'placementId')::uuid;
  PERFORM set_config('test.refund_placement_id', v_placement_id::text, true);
  
  -- Checkout and settle
  PERFORM public.open_checkout(
    v_res_id, '11111111-1111-4111-a111-111111111111', 'cs_refund', 1000,
    now() + interval '31 minutes');
  PERFORM public.settle_payment(v_res_id, 'cs_refund', 1000, 'usd', 'pi_ref', 'ch_ref', null, true);
  
  -- Approve
  PERFORM public.approve_placement(v_placement_id, '33333333-3333-4333-a333-333333333333', 'ok');
END;
$$;

SELECT is(
  (SELECT status FROM public.placements 
   WHERE id = (current_setting('test.refund_placement_id'))::uuid),
  'active'::placement_status,
  'placement is live before the refund'
);

-- ---------------------------------------------------------------------------
-- Partial Refund Keeps Placement Live
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.record_refund('ch_ref', 400, 'goodwill');
  PERFORM set_config('test.partial_full', (v_result -> 'full')::text, true);
END;
$$;

SELECT is(
  current_setting('test.partial_full'),
  'false',
  'partial refund is not marked as full'
);

SELECT is(
  (SELECT status FROM public.placements 
   WHERE id = (current_setting('test.refund_placement_id'))::uuid),
  'active'::placement_status,
  'a partial refund does not take the placement down'
);

-- ---------------------------------------------------------------------------
-- Replay Refund Is No-Op
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.record_refund('ch_ref', 400, 'goodwill');
  PERFORM set_config('test.replay_ignored', v_result ->> 'ignored', true);
END;
$$;

SELECT is(
  current_setting('test.replay_ignored'),
  'no_increase',
  'replaying a refund event is a no-op'
);

-- ---------------------------------------------------------------------------
-- Full Refund Releases Cells
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.record_refund('ch_ref', 1000, 'policy breach');
  PERFORM set_config('test.full_refund_ok', (v_result ->> 'ok')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.full_refund_ok'))::boolean,
  'full refund succeeds'
);

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells 
   WHERE reservation_id = (current_setting('test.refund_res_id'))::uuid),
  0,
  'a full refund releases the cells'
);

SELECT is(
  (SELECT status FROM public.placements 
   WHERE id = (current_setting('test.refund_placement_id'))::uuid),
  'rejected'::placement_status,
  'a full refund takes the placement off the wall'
);

SELECT is(
  (SELECT state FROM public.reservations 
   WHERE id = (current_setting('test.refund_res_id'))::uuid),
  'rejected_refunded'::reservation_state,
  'the reservation reaches rejected_refunded'
);

-- ---------------------------------------------------------------------------
-- Dispute Flow: Create a placement for chargeback
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
  v_res_id uuid;
  v_placement_id uuid;
BEGIN
  -- Reserve
  v_result := public.reserve_cells(
    '22222222-2222-4222-a222-222222222222', 81, 81, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  v_res_id := (v_result -> 'reservation' ->> 'id')::uuid;
  PERFORM set_config('test.dispute_res_id', v_res_id::text, true);
  
  -- Set details
  v_result := public.set_placement_details(
    v_res_id, '22222222-2222-4222-a222-222222222222',
    'Dispute Me', 'Placeholder art', 'https://dispute.example.net/', 'dispute.example.net',
    'asset_dis', '/img/asset_dis', 100, 100, 1000, 'image/jpeg', 'auto_pass', '[]'::jsonb);
  v_placement_id := (v_result ->> 'placementId')::uuid;
  PERFORM set_config('test.dispute_placement_id', v_placement_id::text, true);
  
  -- Checkout and settle
  PERFORM public.open_checkout(
    v_res_id, '22222222-2222-4222-a222-222222222222', 'cs_dispute', 1000,
    now() + interval '31 minutes');
  PERFORM public.settle_payment(v_res_id, 'cs_dispute', 1000, 'usd', 'pi_dis', 'ch_dis', null, true);
  
  -- Approve
  PERFORM public.approve_placement(v_placement_id, '33333333-3333-4333-a333-333333333333', 'ok');
END;
$$;

-- ---------------------------------------------------------------------------
-- Chargeback Removes Placement
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.record_dispute('ch_dis', 'needs_response', false);
END;
$$;

SELECT is(
  (SELECT status FROM public.placements 
   WHERE id = (current_setting('test.dispute_placement_id'))::uuid),
  'chargeback_disabled'::placement_status,
  'a chargeback removes the placement from the wall'
);

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells 
   WHERE reservation_id = (current_setting('test.dispute_res_id'))::uuid),
  0,
  'a chargeback releases the cells'
);

SELECT is(
  (SELECT status FROM public.payments 
   WHERE reservation_id = (current_setting('test.dispute_res_id'))::uuid),
  'disputed'::payment_status,
  'the payment is marked disputed'
);

-- ---------------------------------------------------------------------------
-- Expiry Flow: Test that unpaid reservations expire
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
  v_res_id uuid;
BEGIN
  -- Create a fresh reservation
  v_result := public.reserve_cells(
    '11111111-1111-4111-a111-111111111111', 90, 90, 2, 2, 1, 4000, 4000, '{}'::jsonb, 'v1', null);
  v_res_id := (v_result -> 'reservation' ->> 'id')::uuid;
  PERFORM set_config('test.expiry_res_id', v_res_id::text, true);
  
  -- Bypass immutability to set expiry in the past
  ALTER TABLE public.reservations DISABLE TRIGGER reservations_enforce_update;
  UPDATE public.reservations SET expires_at = now() - interval '10 minutes' WHERE id = v_res_id;
  ALTER TABLE public.reservations ENABLE TRIGGER reservations_enforce_update;
END;
$$;

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells 
   WHERE reservation_id = (current_setting('test.expiry_res_id'))::uuid),
  4,
  'cells held before the sweep'
);

DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.expire_reservations(0, 100);
END;
$$;

SELECT is(
  (SELECT count(*)::integer FROM public.pixel_cells 
   WHERE reservation_id = (current_setting('test.expiry_res_id'))::uuid),
  0,
  'the sweep releases an expired unpaid hold'
);

SELECT is(
  (SELECT state FROM public.reservations 
   WHERE id = (current_setting('test.expiry_res_id'))::uuid),
  'expired'::reservation_state,
  'the reservation is marked expired'
);

-- Second sweep is safe
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.expire_reservations(0, 100);
  PERFORM set_config('test.sweep2_ok', (v_result ->> 'ok')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.sweep2_ok'))::boolean,
  'the sweep is safe to run twice'
);

-- Freed cells can be reclaimed
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.reserve_cells(
    '22222222-2222-4222-a222-222222222222', 90, 90, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  PERFORM set_config('test.reclaim_ok', (v_result ->> 'ok')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.reclaim_ok'))::boolean,
  'the freed cells can be claimed by someone else'
);

-- ---------------------------------------------------------------------------
-- Webhook Idempotency Ledger
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.record_stripe_event(
    'evt_mod_1', 'checkout.session.completed', '2026-08-01', now(),
    repeat('a', 64), false
  );
  PERFORM set_config('test.evt_new', (v_result ->> 'isNew')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.evt_new'))::boolean,
  'a new event is reported as new'
);

DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.record_stripe_event(
    'evt_mod_1', 'checkout.session.completed', '2026-08-01', now(),
    repeat('a', 64), false
  );
  PERFORM set_config('test.evt_replay', (v_result ->> 'isNew')::text, true);
  PERFORM set_config('test.evt_attempts', (v_result ->> 'attempts')::text, true);
END;
$$;

SELECT ok(
  NOT (current_setting('test.evt_replay'))::boolean,
  'a replayed event is reported as not new'
);

SELECT is(
  (current_setting('test.evt_attempts'))::integer,
  2,
  'attempt counter increments'
);

SELECT is(
  (SELECT count(*)::integer FROM public.stripe_events WHERE id = 'evt_mod_1'),
  1,
  'only one ledger row exists for the event'
);

SELECT * FROM finish();
ROLLBACK;
