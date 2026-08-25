-- =============================================================================
-- HQPixels 0011 — Row Level Security
-- =============================================================================
-- IMPORTANT CONTEXT, so nobody mistakes what this layer is for.
--
-- In this architecture the browser NEVER talks to Supabase. Every read and write
-- goes through the Cloudflare Worker, which authenticates the session itself and
-- uses the service role. So RLS is NOT the primary authorization mechanism.
--
-- RLS exists here as defence in depth against three specific scenarios:
--   1. the anon/publishable key leaks or is used from somewhere unexpected,
--   2. a future feature connects a client directly to Supabase,
--   3. a Worker bug forgets an ownership check on a query.
--
-- Posture: revoke everything by default, then grant the narrowest possible
-- column-level SELECT, and write policies that are correct on their own terms.
-- supabase/tests/04_rls.sql proves allow/deny for anon, owner, other user and
-- admin on every table.

-- -----------------------------------------------------------------------------
-- 1. Default deny
-- -----------------------------------------------------------------------------
-- Supabase grants broad table privileges to anon/authenticated by default and
-- sets DEFAULT PRIVILEGES for future tables. Undo both.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- The schema itself stays usable so grants below can resolve.
grant usage on schema public to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Enable RLS on every table
-- -----------------------------------------------------------------------------
-- ENABLE, deliberately NOT FORCE.
--
-- FORCE ROW LEVEL SECURITY subjects the table OWNER to policies too. Every RPC
-- in migrations 0005-0010 is SECURITY DEFINER and therefore executes as the
-- owner (postgres). With FORCE on and no policies granted to postgres, every
-- one of those functions would silently see zero rows — reservations would
-- appear to succeed while writing nothing. ENABLE gives us RLS for anon and
-- authenticated (the roles that could actually be reached with a leaked
-- publishable key) while leaving the audited definer functions working.
--
-- The Worker's service_role has BYPASSRLS. That is the documented trust
-- boundary: protecting the service key is a deployment control, not an RLS one.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles', 'pricing_versions', 'reservations', 'pixel_cells', 'placements',
    'payments', 'stripe_events', 'moderation_actions', 'abuse_reports',
    'audit_logs', 'view_aggregates', 'click_aggregates', 'impression_aggregates',
    'leaderboard_snapshots', 'wall_state', 'reservation_transitions', 'job_runs'
  ]
  loop
    execute format('alter table public.%I enable row level security', v_table);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. profiles
-- -----------------------------------------------------------------------------
-- A user may read their own row and update only two cosmetic fields. Column
-- grants are what stop `update profiles set is_admin = true` from even being a
-- syntactically valid statement for these roles; the trigger from 0006 is the
-- backstop.
grant select (id, display_name, handle, founding_buyer, created_at)
  on public.profiles to anon;
grant select on public.profiles to authenticated;
grant update (display_name, handle) on public.profiles to authenticated;

drop policy if exists profiles_public_read on public.profiles;
create policy profiles_public_read on public.profiles
  for select to anon
  -- Only profiles that actually own something live are publicly visible, so the
  -- table is not an enumerable user directory.
  using (
    exists (
      select 1 from public.placements p
      where p.owner_id = profiles.id and p.status = 'active'
    )
  );

drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No INSERT policy: rows are created by the auth.users trigger only.
-- No DELETE policy: account deletion cascades from auth.users.

-- -----------------------------------------------------------------------------
-- 4. pricing_versions
-- -----------------------------------------------------------------------------
-- Prices are public information. Only the active version is exposed, and only
-- the fields needed to render the pricing page.
grant select (
  id, version, currency, cents_per_logical_pixel, zone_multipliers,
  min_cells, max_cells, reservation_ttl_seconds, is_active, created_at
) on public.pricing_versions to anon, authenticated;

drop policy if exists pricing_active_public on public.pricing_versions;
create policy pricing_active_public on public.pricing_versions
  for select to anon, authenticated
  using (is_active or public.is_admin());

-- -----------------------------------------------------------------------------
-- 5. placements — the only table with meaningful public exposure
-- -----------------------------------------------------------------------------
-- Column grants matter more than the policy here. Note what anon CANNOT read
-- even for an active placement: destination_url (only the host), owner_id,
-- image_asset_id, moderation notes, link health, and anything about payment.
grant select (
  id, cell_x, cell_y, cell_w, cell_h, title, alt_text,
  destination_host, image_public_path, status, activated_at
) on public.placements to anon;

grant select on public.placements to authenticated;

drop policy if exists placements_active_public on public.placements;
create policy placements_active_public on public.placements
  for select to anon
  using (status = 'active');

drop policy if exists placements_owner_read on public.placements;
create policy placements_owner_read on public.placements
  for select to authenticated
  using (owner_id = auth.uid() or status = 'active' or public.is_admin());

-- Deliberately NO insert/update/delete policy for authenticated. Every mutation
-- goes through a SECURITY DEFINER function called by the Worker, which is how
-- ownership, state machine and moderation rules stay in one place.

-- -----------------------------------------------------------------------------
-- 6. pixel_cells — availability is public, ownership is not
-- -----------------------------------------------------------------------------
grant select (cell_x, cell_y) on public.pixel_cells to anon;
grant select on public.pixel_cells to authenticated;

drop policy if exists pixel_cells_public_read on public.pixel_cells;
create policy pixel_cells_public_read on public.pixel_cells
  for select to anon
  using (true);

drop policy if exists pixel_cells_auth_read on public.pixel_cells;
create policy pixel_cells_auth_read on public.pixel_cells
  for select to authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- 7. reservations — strictly private
-- -----------------------------------------------------------------------------
grant select on public.reservations to authenticated;

drop policy if exists reservations_owner_read on public.reservations;
create policy reservations_owner_read on public.reservations
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- anon gets nothing at all: no grant, no policy.

-- -----------------------------------------------------------------------------
-- 8. payments — private, and narrower than the owner might expect
-- -----------------------------------------------------------------------------
-- Buyers see their own amounts and status. Stripe customer ids and internal
-- error codes are admin-only, because they are useful to an attacker probing
-- the payment flow and useless to the buyer.
grant select (
  id, reservation_id, owner_id, status, amount_cents, currency,
  amount_refunded_cents, paid_at, refunded_at, created_at
) on public.payments to authenticated;

drop policy if exists payments_owner_read on public.payments;
create policy payments_owner_read on public.payments
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- -----------------------------------------------------------------------------
-- 9. Admin-only tables
-- -----------------------------------------------------------------------------
-- No grants for anon. Authenticated admins may read; nobody may write through
-- this path.
grant select on public.moderation_actions to authenticated;
drop policy if exists moderation_admin_read on public.moderation_actions;
create policy moderation_admin_read on public.moderation_actions
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.placements p
      where p.id = moderation_actions.placement_id and p.owner_id = auth.uid()
    )
  );

grant select on public.abuse_reports to authenticated;
drop policy if exists abuse_admin_read on public.abuse_reports;
create policy abuse_admin_read on public.abuse_reports
  for select to authenticated
  using (public.is_admin());

grant select on public.audit_logs to authenticated;
drop policy if exists audit_admin_read on public.audit_logs;
create policy audit_admin_read on public.audit_logs
  for select to authenticated
  using (public.is_admin());

grant select on public.stripe_events to authenticated;
drop policy if exists stripe_events_admin_read on public.stripe_events;
create policy stripe_events_admin_read on public.stripe_events
  for select to authenticated
  using (public.is_admin());

grant select on public.job_runs to authenticated;
drop policy if exists job_runs_admin_read on public.job_runs;
create policy job_runs_admin_read on public.job_runs
  for select to authenticated
  using (public.is_admin());

-- -----------------------------------------------------------------------------
-- 10. Aggregates
-- -----------------------------------------------------------------------------
-- Site-wide view totals are public (they are published on /stats anyway).
grant select on public.view_aggregates to anon, authenticated;
drop policy if exists view_aggregates_public_read on public.view_aggregates;
create policy view_aggregates_public_read on public.view_aggregates
  for select to anon, authenticated using (true);

-- Per-placement click and impression data is NOT public: it is competitive
-- information belonging to the buyer. Aggregated click counts reach the public
-- only through the leaderboard snapshots.
grant select on public.click_aggregates to authenticated;
drop policy if exists click_owner_read on public.click_aggregates;
create policy click_owner_read on public.click_aggregates
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.placements p
      where p.id = click_aggregates.placement_id and p.owner_id = auth.uid()
    )
  );

grant select on public.impression_aggregates to authenticated;
drop policy if exists impression_owner_read on public.impression_aggregates;
create policy impression_owner_read on public.impression_aggregates
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.placements p
      where p.id = impression_aggregates.placement_id and p.owner_id = auth.uid()
    )
  );

grant select on public.leaderboard_snapshots to anon, authenticated;
drop policy if exists leaderboard_public_read on public.leaderboard_snapshots;
create policy leaderboard_public_read on public.leaderboard_snapshots
  for select to anon, authenticated using (true);

grant select (manifest_version, last_activated_at, total_page_views, updated_at)
  on public.wall_state to anon, authenticated;
drop policy if exists wall_state_public_read on public.wall_state;
create policy wall_state_public_read on public.wall_state
  for select to anon, authenticated using (true);

-- -----------------------------------------------------------------------------
-- 11. Reference data
-- -----------------------------------------------------------------------------
grant select on public.reservation_transitions to authenticated;
drop policy if exists transitions_read on public.reservation_transitions;
create policy transitions_read on public.reservation_transitions
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- 12. No function is callable by anon or authenticated
-- -----------------------------------------------------------------------------
-- Belt and braces: 0005-0010 each revoke individually, this catches anything
-- added later without its own revoke. is_admin() is re-granted because RLS
-- policies evaluate it as the calling role.
revoke all on all functions in schema public from anon, authenticated;
grant execute on function public.is_admin(uuid) to authenticated;

comment on schema public is
  'All application access is via the Cloudflare Worker using the service role. '
  'RLS here is defence in depth, not the primary authorization layer. See '
  'SECURITY.md.';
