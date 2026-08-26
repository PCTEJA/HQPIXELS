-- =============================================================================
-- HQPixels — pgTAP RLS (Row Level Security) Tests
-- =============================================================================
-- Verifies RLS policies for anon/authenticated/admin roles.
-- Run with: psql -d hqpixels -f supabase/tests/007_rls.sql
-- =============================================================================

BEGIN;
SELECT plan(32);

-- ---------------------------------------------------------------------------
-- Setup: Create test users
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('11111111-1111-4111-b111-111111111111', 'rls.alice@test.com', now(), '{"name":"RLS Alice"}'),
  ('22222222-2222-4222-b222-222222222222', 'rls.bob@test.com',   now(), '{"name":"RLS Bob"}'),
  ('33333333-3333-4333-b333-333333333333', 'rls.admin@test.com', now(), '{"name":"RLS Admin"}')
ON CONFLICT (id) DO NOTHING;

SELECT public.grant_admin('rls.admin@test.com');

-- Create reservations for each user
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.reserve_cells(
    '11111111-1111-4111-b111-111111111111', 30, 30, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  v_result := public.reserve_cells(
    '22222222-2222-4222-b222-222222222222', 31, 31, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS Is Enabled On All Application Tables
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_class c 
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' 
      AND c.relkind = 'r' 
      AND NOT c.relrowsecurity
      AND c.relname NOT IN ('results')
  ),
  'RLS is enabled on every application table'
);

-- ---------------------------------------------------------------------------
-- Anon Role Restrictions
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT has_table_privilege('anon', 'public.reservations', 'select'),
  'anon has no privilege on reservations'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.payments', 'select'),
  'anon has no privilege on payments'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.audit_logs', 'select'),
  'anon has no privilege on audit_logs'
);

SELECT ok(
  NOT has_column_privilege('anon', 'public.placements', 'destination_url', 'select'),
  'anon cannot read destination_url even on placements'
);

SELECT ok(
  has_column_privilege('anon', 'public.placements', 'destination_host', 'select'),
  'anon can read destination_host on placements'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.placements', 'insert')
    AND NOT has_table_privilege('anon', 'public.reservations', 'insert')
    AND NOT has_table_privilege('anon', 'public.pixel_cells', 'insert'),
  'anon cannot insert into any application table'
);

-- ---------------------------------------------------------------------------
-- Authenticated Role Restrictions
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'update'),
  'authenticated cannot update is_admin'
);

SELECT ok(
  has_column_privilege('authenticated', 'public.profiles', 'display_name', 'update'),
  'authenticated can update display_name'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.placements', 'update')
    AND NOT has_table_privilege('authenticated', 'public.placements', 'insert'),
  'authenticated cannot write placements directly'
);

-- ---------------------------------------------------------------------------
-- Function Execution Privileges
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.reserve_cells(uuid,integer,integer,integer,integer,integer,integer,integer,jsonb,text,text)',
    'execute'
  ),
  'anon cannot execute reserve_cells'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.reserve_cells(uuid,integer,integer,integer,integer,integer,integer,integer,jsonb,text,text)',
    'execute'
  ),
  'authenticated cannot execute reserve_cells'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.settle_payment(uuid,text,integer,text,text,text,text,boolean)',
    'execute'
  ),
  'authenticated cannot execute settle_payment'
);

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER Functions Have Empty Search Path
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, array[]::text[])) cfg
        WHERE cfg IN ('search_path=', 'search_path=""', 'search_path=''''')
      )
  ),
  'every SECURITY DEFINER function pins an empty search_path'
);

-- ---------------------------------------------------------------------------
-- Policy Behaviour: Authenticated User Sees Only Own Data
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_res_count integer;
  v_pay_count integer;
  v_audit_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"11111111-1111-4111-b111-111111111111","role":"authenticated"}', true
  );
  
  SELECT count(*)::integer INTO v_res_count FROM public.reservations;
  SELECT count(*)::integer INTO v_pay_count FROM public.payments;
  SELECT count(*)::integer INTO v_audit_count FROM public.audit_logs;
  
  PERFORM set_config('test.rls_res_count', v_res_count::text, true);
  PERFORM set_config('test.rls_pay_count', v_pay_count::text, true);
  PERFORM set_config('test.rls_audit_count', v_audit_count::text, true);
  
  RESET ROLE;
EXCEPTION
  WHEN OTHERS THEN
    RESET ROLE;
    RAISE;
END;
$$;

SELECT is(
  (current_setting('test.rls_res_count'))::integer,
  (SELECT count(*)::integer FROM public.reservations 
   WHERE owner_id = '11111111-1111-4111-b111-111111111111'),
  'a signed-in buyer sees only their own reservations'
);

SELECT is(
  (current_setting('test.rls_pay_count'))::integer,
  (SELECT count(*)::integer FROM public.payments 
   WHERE owner_id = '11111111-1111-4111-b111-111111111111'),
  'a signed-in buyer sees only their own payments'
);

SELECT is(
  (current_setting('test.rls_audit_count'))::integer,
  0,
  'a non-admin sees no audit log rows'
);

-- ---------------------------------------------------------------------------
-- Policy Behaviour: Anon Sees Only Active Placements
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_placement_count integer;
  v_active_count integer;
BEGIN
  -- Get actual active count first
  SELECT count(*)::integer INTO v_active_count 
  FROM public.placements WHERE status = 'active';
  PERFORM set_config('test.rls_active_count', v_active_count::text, true);
  
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true);
  
  SELECT count(*)::integer INTO v_placement_count FROM public.placements;
  PERFORM set_config('test.rls_anon_placements', v_placement_count::text, true);
  
  RESET ROLE;
EXCEPTION
  WHEN OTHERS THEN
    RESET ROLE;
    RAISE;
END;
$$;

SELECT is(
  (current_setting('test.rls_anon_placements'))::integer,
  (current_setting('test.rls_active_count'))::integer,
  'anon sees only active placements'
);

-- ---------------------------------------------------------------------------
-- IDOR Protection: Other User's Data Returns "Not Found"
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
  v_bob_res_id uuid;
BEGIN
  -- Get Bob's reservation
  SELECT id INTO v_bob_res_id 
  FROM public.reservations 
  WHERE owner_id = '22222222-2222-4222-b222-222222222222' 
  LIMIT 1;
  
  -- Alice tries to access Bob's reservation
  v_result := public.reservation_status(
    v_bob_res_id,
    '11111111-1111-4111-b111-111111111111'
  );
  PERFORM set_config('test.idor_status_code', v_result ->> 'code', true);
  
  v_result := public.reservation_detail(
    v_bob_res_id,
    '11111111-1111-4111-b111-111111111111'
  );
  PERFORM set_config('test.idor_detail_code', v_result ->> 'code', true);
  
  v_result := public.set_placement_details(
    v_bob_res_id,
    '11111111-1111-4111-b111-111111111111',
    'Hijacked', 'nope', 'https://evil.example.net/', 'evil.example.net',
    null, null, null, null, null, null, 'auto_pass', '[]'::jsonb
  );
  PERFORM set_config('test.idor_edit_code', v_result ->> 'code', true);
END;
$$;

SELECT is(
  current_setting('test.idor_status_code'),
  'not_found',
  'reservation_status hides another buyer reservation'
);

SELECT is(
  current_setting('test.idor_detail_code'),
  'not_found',
  'reservation_detail hides another buyer reservation'
);

SELECT is(
  current_setting('test.idor_edit_code'),
  'not_found',
  'another buyer cannot edit a placement they do not own'
);

-- ---------------------------------------------------------------------------
-- Manifest/Stats Privacy
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_manifest jsonb;
  v_stats jsonb;
  v_dashboard jsonb;
BEGIN
  v_manifest := public.build_wall_manifest();
  v_stats := public.public_stats_payload();
  v_dashboard := public.buyer_dashboard('22222222-2222-4222-b222-222222222222');
  
  PERFORM set_config('test.manifest_no_full_url', 
    (v_manifest::text NOT LIKE '%https://%.example%')::text, true);
  PERFORM set_config('test.manifest_has_host', 
    (v_manifest::text LIKE '%example%')::text, true);
  PERFORM set_config('test.manifest_no_email', 
    (v_manifest::text NOT LIKE '%@test.com%')::text, true);
  PERFORM set_config('test.stats_no_email', 
    (v_stats::text NOT LIKE '%@test.com%')::text, true);
END;
$$;

SELECT ok(
  (current_setting('test.manifest_no_full_url'))::boolean,
  'manifest never exposes a full destination URL'
);

SELECT ok(
  (current_setting('test.manifest_no_email'))::boolean,
  'manifest never exposes a buyer email'
);

SELECT ok(
  (current_setting('test.stats_no_email'))::boolean,
  'stats never exposes an email'
);

-- ---------------------------------------------------------------------------
-- Stats Consistency
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_stats jsonb;
  v_claimed integer;
  v_available integer;
BEGIN
  v_stats := public.public_stats_payload();
  v_claimed := (v_stats -> 'inventory' ->> 'claimedCells')::integer;
  v_available := (v_stats -> 'inventory' ->> 'availableCells')::integer;
  
  PERFORM set_config('test.stats_claimed', v_claimed::text, true);
  PERFORM set_config('test.stats_sum', (v_claimed + v_available)::text, true);
  PERFORM set_config('test.pixel_count', 
    (SELECT count(*)::integer FROM public.pixel_cells)::text, true);
END;
$$;

SELECT is(
  (current_setting('test.stats_claimed'))::integer,
  (current_setting('test.pixel_count'))::integer,
  'stats reports claimed cells consistently'
);

SELECT is(
  (current_setting('test.stats_sum'))::integer,
  10000,
  'available + claimed = 10000'
);

-- ---------------------------------------------------------------------------
-- Dashboard Returns Only Caller's Placements
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dashboard jsonb;
  v_dashboard_count integer;
  v_actual_count integer;
BEGIN
  v_dashboard := public.buyer_dashboard('22222222-2222-4222-b222-222222222222');
  
  SELECT count(*)::integer INTO v_dashboard_count 
  FROM jsonb_array_elements(v_dashboard -> 'placements');
  
  SELECT count(*)::integer INTO v_actual_count 
  FROM public.placements 
  WHERE owner_id = '22222222-2222-4222-b222-222222222222';
  
  PERFORM set_config('test.dash_count', v_dashboard_count::text, true);
  PERFORM set_config('test.actual_count', v_actual_count::text, true);
END;
$$;

SELECT is(
  (current_setting('test.dash_count'))::integer,
  (current_setting('test.actual_count'))::integer,
  'dashboard returns only the caller placements'
);

-- ---------------------------------------------------------------------------
-- Occupancy Bitmap Layout
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bitmap bytea;
BEGIN
  v_bitmap := public.occupancy_bitmap();
  PERFORM set_config('test.bitmap_len', length(v_bitmap)::text, true);
END;
$$;

SELECT is(
  (current_setting('test.bitmap_len'))::integer,
  1250,
  'occupancy bitmap is exactly 1250 bytes'
);

SELECT * FROM finish();
ROLLBACK;
