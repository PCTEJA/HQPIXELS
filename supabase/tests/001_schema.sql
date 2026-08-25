-- =============================================================================
-- HQPixels — pgTAP Schema Tests
-- =============================================================================
-- Verifies that all tables, columns, constraints, and indexes exist as expected.
-- Run with: psql -d hqpixels -f supabase/tests/001_schema.sql
-- =============================================================================

BEGIN;
SELECT plan(47);

-- ---------------------------------------------------------------------------
-- Core Tables Existence
-- ---------------------------------------------------------------------------
SELECT has_table('public', 'profiles', 'profiles table exists');
SELECT has_table('public', 'pricing_versions', 'pricing_versions table exists');
SELECT has_table('public', 'reservations', 'reservations table exists');
SELECT has_table('public', 'pixel_cells', 'pixel_cells table exists');
SELECT has_table('public', 'placements', 'placements table exists');
SELECT has_table('public', 'payments', 'payments table exists');
SELECT has_table('public', 'stripe_events', 'stripe_events table exists');
SELECT has_table('public', 'moderation_actions', 'moderation_actions table exists');
SELECT has_table('public', 'abuse_reports', 'abuse_reports table exists');
SELECT has_table('public', 'audit_logs', 'audit_logs table exists');
SELECT has_table('public', 'view_aggregates', 'view_aggregates table exists');
SELECT has_table('public', 'click_aggregates', 'click_aggregates table exists');
SELECT has_table('public', 'impression_aggregates', 'impression_aggregates table exists');
SELECT has_table('public', 'leaderboard_snapshots', 'leaderboard_snapshots table exists');
SELECT has_table('public', 'wall_state', 'wall_state table exists');
SELECT has_table('public', 'reservation_transitions', 'reservation_transitions table exists');
SELECT has_table('public', 'job_runs', 'job_runs table exists');

-- ---------------------------------------------------------------------------
-- Critical Columns
-- ---------------------------------------------------------------------------
SELECT has_column('public', 'profiles', 'id', 'profiles.id exists');
SELECT has_column('public', 'profiles', 'email', 'profiles.email exists');
SELECT has_column('public', 'profiles', 'is_admin', 'profiles.is_admin exists');
SELECT has_column('public', 'profiles', 'email_verified', 'profiles.email_verified exists');
SELECT has_column('public', 'profiles', 'founding_buyer', 'profiles.founding_buyer exists');

SELECT has_column('public', 'reservations', 'state', 'reservations.state exists');
SELECT has_column('public', 'reservations', 'owner_id', 'reservations.owner_id exists');
SELECT has_column('public', 'reservations', 'cell_x', 'reservations.cell_x exists');
SELECT has_column('public', 'reservations', 'cell_y', 'reservations.cell_y exists');
SELECT has_column('public', 'reservations', 'width', 'reservations.width exists');
SELECT has_column('public', 'reservations', 'height', 'reservations.height exists');
SELECT has_column('public', 'reservations', 'quoted_total_cents', 'reservations.quoted_total_cents exists');
SELECT has_column('public', 'reservations', 'expires_at', 'reservations.expires_at exists');

SELECT has_column('public', 'pixel_cells', 'cell_x', 'pixel_cells.cell_x exists');
SELECT has_column('public', 'pixel_cells', 'cell_y', 'pixel_cells.cell_y exists');
SELECT has_column('public', 'pixel_cells', 'reservation_id', 'pixel_cells.reservation_id exists');

SELECT has_column('public', 'placements', 'status', 'placements.status exists');
SELECT has_column('public', 'placements', 'destination_url', 'placements.destination_url exists');
SELECT has_column('public', 'placements', 'destination_host', 'placements.destination_host exists');

SELECT has_column('public', 'payments', 'status', 'payments.status exists');
SELECT has_column('public', 'payments', 'amount_cents', 'payments.amount_cents exists');
SELECT has_column('public', 'payments', 'stripe_session_id', 'payments.stripe_session_id exists');

-- ---------------------------------------------------------------------------
-- Primary Keys and Unique Constraints
-- ---------------------------------------------------------------------------
SELECT col_is_pk('public', 'pixel_cells', ARRAY['cell_x', 'cell_y'], 
  'pixel_cells has composite PK on (cell_x, cell_y) preventing double allocation');

SELECT col_is_pk('public', 'stripe_events', 'id',
  'stripe_events.id is PK for webhook idempotency');

-- ---------------------------------------------------------------------------
-- Column Types
-- ---------------------------------------------------------------------------
SELECT col_type_is('public', 'reservations', 'state', 'reservation_state',
  'reservations.state is reservation_state enum');
SELECT col_type_is('public', 'placements', 'status', 'placement_status',
  'placements.status is placement_status enum');
SELECT col_type_is('public', 'payments', 'status', 'payment_status',
  'payments.status is payment_status enum');
SELECT col_type_is('public', 'payments', 'amount_cents', 'integer',
  'payments.amount_cents is integer (not float)');
SELECT col_type_is('public', 'reservations', 'quoted_total_cents', 'integer',
  'reservations.quoted_total_cents is integer (not float)');

-- ---------------------------------------------------------------------------
-- Foreign Keys
-- ---------------------------------------------------------------------------
SELECT has_fk('public', 'reservations', 'reservations have FK constraints');
SELECT has_fk('public', 'pixel_cells', 'pixel_cells have FK constraints');
SELECT has_fk('public', 'placements', 'placements have FK constraints');
SELECT has_fk('public', 'payments', 'payments have FK constraints');

SELECT * FROM finish();
ROLLBACK;
