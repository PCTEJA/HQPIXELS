-- =============================================================================
-- HQPixels — Development Seed Data
-- =============================================================================
--
-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║  ⚠️  DEVELOPMENT ONLY — DO NOT USE IN PRODUCTION  ⚠️                       ║
-- ╠════════════════════════════════════════════════════════════════════════════╣
-- ║  This file contains test data with:                                        ║
-- ║  - Deterministic UUIDs for reproducible tests                              ║
-- ║  - Fake emails and names                                                   ║
-- ║  - Sample reservations and placements in various states                    ║
-- ║                                                                            ║
-- ║  NEVER apply this to a production database.                                ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
--
-- Run with:
--   psql -d hqpixels -f supabase/seed.dev.sql
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Clear existing test data (idempotent re-runs)
-- ---------------------------------------------------------------------------
-- Note: We use deterministic UUIDs so we can clear and re-seed safely
DELETE FROM public.pixel_cells WHERE reservation_id IN (
  SELECT id FROM public.reservations WHERE owner_id IN (
    'aaaa0001-0001-4001-8001-000000000001'::uuid,
    'aaaa0002-0002-4002-8002-000000000002'::uuid,
    'aaaa0003-0003-4003-8003-000000000003'::uuid
  )
);
DELETE FROM public.placements WHERE owner_id IN (
  'aaaa0001-0001-4001-8001-000000000001'::uuid,
  'aaaa0002-0002-4002-8002-000000000002'::uuid,
  'aaaa0003-0003-4003-8003-000000000003'::uuid
);
DELETE FROM public.payments WHERE owner_id IN (
  'aaaa0001-0001-4001-8001-000000000001'::uuid,
  'aaaa0002-0002-4002-8002-000000000002'::uuid,
  'aaaa0003-0003-4003-8003-000000000003'::uuid
);
DELETE FROM public.reservations WHERE owner_id IN (
  'aaaa0001-0001-4001-8001-000000000001'::uuid,
  'aaaa0002-0002-4002-8002-000000000002'::uuid,
  'aaaa0003-0003-4003-8003-000000000003'::uuid
);
DELETE FROM public.profiles WHERE id IN (
  'aaaa0001-0001-4001-8001-000000000001'::uuid,
  'aaaa0002-0002-4002-8002-000000000002'::uuid,
  'aaaa0003-0003-4003-8003-000000000003'::uuid
);
DELETE FROM auth.users WHERE id IN (
  'aaaa0001-0001-4001-8001-000000000001'::uuid,
  'aaaa0002-0002-4002-8002-000000000002'::uuid,
  'aaaa0003-0003-4003-8003-000000000003'::uuid
);

-- ---------------------------------------------------------------------------
-- Test Users (via auth.users, triggers create profiles)
-- ---------------------------------------------------------------------------
-- User 1: Regular buyer with verified email
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('aaaa0001-0001-4001-8001-000000000001', 'alice.seed@example.com', now(), 
   '{"name":"Alice Developer","avatar_url":null}')
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  email_confirmed_at = EXCLUDED.email_confirmed_at,
  raw_user_meta_data = EXCLUDED.raw_user_meta_data;

-- User 2: Regular buyer with verified email  
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('aaaa0002-0002-4002-8002-000000000002', 'bob.seed@example.com', now(),
   '{"name":"Bob Tester","avatar_url":null}')
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  email_confirmed_at = EXCLUDED.email_confirmed_at,
  raw_user_meta_data = EXCLUDED.raw_user_meta_data;

-- User 3: Admin user
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('aaaa0003-0003-4003-8003-000000000003', 'admin.seed@example.com', now(),
   '{"name":"Admin User","avatar_url":null}')
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  email_confirmed_at = EXCLUDED.email_confirmed_at,
  raw_user_meta_data = EXCLUDED.raw_user_meta_data;

-- Promote admin user
SELECT public.grant_admin('admin.seed@example.com');

-- ---------------------------------------------------------------------------
-- Sample Reservations and Placements
-- ---------------------------------------------------------------------------

-- Reservation 1: Active placement (Alice) - fully complete lifecycle
DO $$
DECLARE
  v_result jsonb;
  v_res_id uuid;
  v_placement_id uuid;
BEGIN
  -- Reserve cells at (5,5) - 3x2 block
  v_result := public.reserve_cells(
    'aaaa0001-0001-4001-8001-000000000001',
    5, 5, 3, 2, 1, 6000, 6000,
    '{"lines":[{"label":"Base","cells":6,"logicalPixels":600,"multiplierBp":10000,"amountCents":6000}]}'::jsonb,
    'v1', '192.0.2.1/32'
  );
  v_res_id := (v_result -> 'reservation' ->> 'id')::uuid;
  
  -- Set placement details
  v_result := public.set_placement_details(
    v_res_id, 'aaaa0001-0001-4001-8001-000000000001',
    'Alice Dev Shop', 'A colorful development tools banner',
    'https://example.com/alice-shop', 'example.com',
    'asset_seed_001', '/img/seed/asset_001.png', 300, 200, 45000, 'image/png',
    'auto_pass', '[{"check":"magic_bytes","result":"pass","detail":"png"}]'::jsonb
  );
  v_placement_id := (v_result ->> 'placementId')::uuid;
  
  -- Create checkout and settle payment
  PERFORM public.open_checkout(
    v_res_id, 'aaaa0001-0001-4001-8001-000000000001',
    'cs_seed_001', 6000, now() + interval '31 minutes'
  );
  PERFORM public.settle_payment(
    v_res_id, 'cs_seed_001', 6000, 'usd', 'pi_seed_001', 'ch_seed_001', 'cus_seed_001', true
  );
  
  -- Approve the placement
  PERFORM public.approve_placement(
    v_placement_id, 'aaaa0003-0003-4003-8003-000000000003', 'Seed data - auto approved'
  );
  
  RAISE NOTICE 'Created active placement for Alice at (5,5) 3x2';
END;
$$;

-- Reservation 2: Pending review (Bob) - paid but awaiting moderation
DO $$
DECLARE
  v_result jsonb;
  v_res_id uuid;
BEGIN
  -- Reserve cells at (15,15) - 2x2 block
  v_result := public.reserve_cells(
    'aaaa0002-0002-4002-8002-000000000002',
    15, 15, 2, 2, 1, 4000, 4000,
    '{"lines":[{"label":"Base","cells":4,"logicalPixels":400,"multiplierBp":10000,"amountCents":4000}]}'::jsonb,
    'v1', '198.51.100.1/32'
  );
  v_res_id := (v_result -> 'reservation' ->> 'id')::uuid;
  
  -- Set placement details
  v_result := public.set_placement_details(
    v_res_id, 'aaaa0002-0002-4002-8002-000000000002',
    'Bob Test Site', 'A simple test placement awaiting review',
    'https://example.org/bob-test', 'example.org',
    'asset_seed_002', '/img/seed/asset_002.jpg', 200, 200, 32000, 'image/jpeg',
    'auto_pass', '[{"check":"magic_bytes","result":"pass","detail":"jpeg"}]'::jsonb
  );
  
  -- Create checkout and settle payment (but don't approve)
  PERFORM public.open_checkout(
    v_res_id, 'aaaa0002-0002-4002-8002-000000000002',
    'cs_seed_002', 4000, now() + interval '31 minutes'
  );
  PERFORM public.settle_payment(
    v_res_id, 'cs_seed_002', 4000, 'usd', 'pi_seed_002', 'ch_seed_002', 'cus_seed_002', true
  );
  
  RAISE NOTICE 'Created pending_review placement for Bob at (15,15) 2x2';
END;
$$;

-- Reservation 3: Reserved but not yet paid (Alice's second)
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Reserve cells at (25,5) - 1x1 block
  v_result := public.reserve_cells(
    'aaaa0001-0001-4001-8001-000000000001',
    25, 5, 1, 1, 1, 1000, 1000,
    '{"lines":[{"label":"Base","cells":1,"logicalPixels":100,"multiplierBp":10000,"amountCents":1000}]}'::jsonb,
    'v1', '192.0.2.1/32'
  );
  
  RAISE NOTICE 'Created reserved (unpaid) placement for Alice at (25,5) 1x1';
END;
$$;

-- ---------------------------------------------------------------------------
-- Sample Moderation Actions
-- ---------------------------------------------------------------------------
INSERT INTO public.moderation_actions (
  placement_id, actor_kind, actor_id, decision, reason
)
SELECT 
  p.id,
  'admin',
  'aaaa0003-0003-4003-8003-000000000003',
  'approve',
  'Seed data - content meets guidelines'
FROM public.placements p
WHERE p.status = 'active' 
  AND p.owner_id = 'aaaa0001-0001-4001-8001-000000000001'
LIMIT 1
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sample Audit Log Entries (these are created automatically by triggers)
-- ---------------------------------------------------------------------------
-- The audit log is append-only and populated by triggers, so entries for:
-- - admin.grant (when we promoted the admin)
-- - reservation.created (when we created reservations)
-- - payment.settled (when payments were settled)
-- - placement.approved (when we approved Alice's placement)
-- ...should already exist from the operations above.

-- ---------------------------------------------------------------------------
-- Sample Analytics Data
-- ---------------------------------------------------------------------------
-- Ingest some view data for the wall
SELECT public.ingest_view_aggregates(format(
  '[{"bucketStart":"%s","surface":"wall","views":150,"filtered":5},
    {"bucketStart":"%s","surface":"home","views":75,"filtered":2}]',
  (now() - interval '1 hour')::text, 
  (now() - interval '1 hour')::text
)::jsonb);

-- Ingest click data for active placements
DO $$
DECLARE
  v_active_placement_id uuid;
BEGIN
  SELECT id INTO v_active_placement_id
  FROM public.placements
  WHERE status = 'active'
  LIMIT 1;
  
  IF v_active_placement_id IS NOT NULL THEN
    PERFORM public.ingest_click_aggregates(format(
      '[{"bucketStart":"%s","placementId":"%s","clicks":12,"filtered":1,"distinctVisitors":8}]',
      (now() - interval '1 hour')::text,
      v_active_placement_id::text
    )::jsonb);
  END IF;
END;
$$;

-- Rebuild leaderboards with seed data
SELECT public.rebuild_leaderboards();

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_user_count integer;
  v_res_count integer;
  v_placement_count integer;
  v_active_count integer;
  v_pending_count integer;
BEGIN
  SELECT count(*)::integer INTO v_user_count FROM public.profiles
  WHERE id IN (
    'aaaa0001-0001-4001-8001-000000000001',
    'aaaa0002-0002-4002-8002-000000000002',
    'aaaa0003-0003-4003-8003-000000000003'
  );
  
  SELECT count(*)::integer INTO v_res_count FROM public.reservations
  WHERE owner_id IN (
    'aaaa0001-0001-4001-8001-000000000001',
    'aaaa0002-0002-4002-8002-000000000002'
  );
  
  SELECT count(*)::integer INTO v_placement_count FROM public.placements
  WHERE owner_id IN (
    'aaaa0001-0001-4001-8001-000000000001',
    'aaaa0002-0002-4002-8002-000000000002'
  );
  
  SELECT count(*)::integer INTO v_active_count FROM public.placements WHERE status = 'active';
  SELECT count(*)::integer INTO v_pending_count FROM public.placements WHERE status = 'pending_review';
  
  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';
  RAISE NOTICE '  HQPixels Development Seed Data Applied Successfully';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';
  RAISE NOTICE '  Users created:          %', v_user_count;
  RAISE NOTICE '  Reservations created:   %', v_res_count;
  RAISE NOTICE '  Placements created:     %', v_placement_count;
  RAISE NOTICE '  Active placements:      %', v_active_count;
  RAISE NOTICE '  Pending review:         %', v_pending_count;
  RAISE NOTICE '══════════════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE '  Test accounts:';
  RAISE NOTICE '    alice.seed@example.com  - Regular buyer (founding)';
  RAISE NOTICE '    bob.seed@example.com    - Regular buyer';
  RAISE NOTICE '    admin.seed@example.com  - Admin user';
  RAISE NOTICE '';
END;
$$;

COMMIT;
