-- =============================================================================
-- HQPixels — pgTAP Audit Log Tests
-- =============================================================================
-- Verifies the append-only audit log and moderation history.
-- Run with: psql -d hqpixels -f supabase/tests/006_audit.sql
-- =============================================================================

BEGIN;
SELECT plan(15);

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES
  ('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'audit.user@test.com', now(), '{"name":"Audit User"}'),
  ('bbbbbbbb-bbbb-4bbb-aaaa-bbbbbbbbbbbb', 'audit.admin@test.com', now(), '{"name":"Audit Admin"}')
ON CONFLICT (id) DO NOTHING;

SELECT public.grant_admin('audit.admin@test.com');

-- ---------------------------------------------------------------------------
-- Audit Log Append-Only
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ UPDATE public.audit_logs SET action = 'tampered' $q$,
  NULL,
  NULL,
  'audit log rows cannot be updated'
);

SELECT throws_ok(
  $q$ DELETE FROM public.audit_logs $q$,
  NULL,
  NULL,
  'audit log rows cannot be deleted'
);

-- ---------------------------------------------------------------------------
-- Grant Admin Creates Audit Record
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'admin.grant'),
  'grant_admin writes an audit record'
);

-- ---------------------------------------------------------------------------
-- Moderation History Append-Only
-- ---------------------------------------------------------------------------
-- First, create a moderation action to test against
DO $$
DECLARE
  v_placement_id uuid;
BEGIN
  -- Get or create a placement for testing
  SELECT id INTO v_placement_id FROM public.placements LIMIT 1;
  
  IF v_placement_id IS NOT NULL THEN
    INSERT INTO public.moderation_actions (placement_id, actor_kind, decision, reason)
    VALUES (v_placement_id, 'system', 'auto_flag', 'pgTAP test row')
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

SELECT ok(
  (SELECT count(*)::integer FROM public.moderation_actions) > 0,
  'moderation seed row exists so append-only is really tested'
);

SELECT throws_ok(
  $q$ UPDATE public.moderation_actions SET reason = 'tampered' $q$,
  NULL,
  NULL,
  'moderation history cannot be rewritten'
);

SELECT throws_ok(
  $q$ DELETE FROM public.moderation_actions $q$,
  NULL,
  NULL,
  'moderation history cannot be deleted'
);

-- ---------------------------------------------------------------------------
-- Profile Privilege Protection
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ UPDATE public.profiles SET is_admin = true 
      WHERE email = 'audit.user@test.com' $q$,
  NULL,
  NULL,
  'is_admin cannot be set by an ordinary update'
);

SELECT throws_ok(
  $q$ UPDATE public.profiles SET founding_buyer = true 
      WHERE email = 'audit.user@test.com' $q$,
  NULL,
  NULL,
  'founding_buyer cannot be self-awarded'
);

SELECT throws_ok(
  $q$ UPDATE public.profiles SET email = 'attacker@example.com' 
      WHERE email = 'audit.user@test.com' $q$,
  NULL,
  NULL,
  'email cannot be changed through the profile'
);

-- ---------------------------------------------------------------------------
-- Grant Admin Restrictions
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT has_function_privilege('service_role', 'public.grant_admin(text)', 'execute'),
  'grant_admin is not executable by service_role'
);

SELECT ok(
  public.is_admin('bbbbbbbb-bbbb-4bbb-aaaa-bbbbbbbbbbbb'),
  'grant_admin promotes the account'
);

-- ---------------------------------------------------------------------------
-- Pricing Version Single Active Constraint
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $q$ UPDATE public.pricing_versions SET is_active = true 
      WHERE NOT is_active LIMIT 1 $q$,
  NULL,
  NULL,
  'a second pricing version cannot also be active'
);

-- ---------------------------------------------------------------------------
-- Audit Log Contains Expected Actions
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT count(*)::integer FROM public.audit_logs) > 0,
  'audit_logs has entries'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_logs 
    WHERE action IN ('admin.grant', 'reservation.created', 'payment.settled', 'placement.approved')
  ),
  'audit log contains expected action types'
);

-- ---------------------------------------------------------------------------
-- Audit Logs Have Timestamps
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.audit_logs WHERE created_at IS NULL
  ),
  'all audit entries have timestamps'
);

SELECT * FROM finish();
ROLLBACK;
