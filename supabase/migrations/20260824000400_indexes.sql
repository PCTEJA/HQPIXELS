-- =============================================================================
-- HQPixels 0004 — indexes
-- =============================================================================
-- Each index below exists for a named query. If you add an index, add the query
-- it serves in the comment; if you remove a query, remove its index.

-- --- reservations -------------------------------------------------------------

-- Buyer dashboard: "my reservations, newest first".
create index if not exists reservations_owner_created_idx
  on public.reservations (owner_id, created_at desc);

-- Expiry reconciler: "reservations past their hold, in a releasable state".
-- Partial, so the index stays tiny no matter how many settled reservations
-- accumulate — this is the hottest scheduled query in the system.
create index if not exists reservations_expiry_sweep_idx
  on public.reservations (expires_at)
  where state in ('draft', 'reserved', 'ready_for_checkout', 'checkout_created');

-- Admin queue and health checks: "everything in state X".
create index if not exists reservations_state_created_idx
  on public.reservations (state, created_at desc);

-- Abuse investigation: "other reservations from this network prefix".
create index if not exists reservations_ip_prefix_idx
  on public.reservations (created_ip_prefix, created_at desc)
  where created_ip_prefix is not null;

-- --- pixel_cells --------------------------------------------------------------

-- The PRIMARY KEY (cell_x, cell_y) already serves availability lookups.

-- Cascade deletes and "which cells does this reservation hold".
create index if not exists pixel_cells_reservation_idx
  on public.pixel_cells (reservation_id);

-- "Largest owners" leaderboard and per-owner totals.
create index if not exists pixel_cells_owner_idx
  on public.pixel_cells (owner_id);

create index if not exists pixel_cells_placement_idx
  on public.pixel_cells (placement_id) where placement_id is not null;

-- --- placements ---------------------------------------------------------------

-- THE manifest query: every active placement, in a stable render order.
-- Covering-ish: includes the columns the manifest actually serialises so the
-- rebuild can be an index-only-ish scan.
create index if not exists placements_active_manifest_idx
  on public.placements (cell_y, cell_x)
  include (id, cell_w, cell_h, title, alt_text, destination_host, image_public_path, activated_at)
  where status = 'active';

-- Moderation queue: oldest pending first (fair ordering).
create index if not exists placements_pending_review_idx
  on public.placements (created_at)
  where status = 'pending_review';

-- Buyer dashboard.
create index if not exists placements_owner_idx
  on public.placements (owner_id, created_at desc);

-- "Recently claimed" strip on the landing page.
create index if not exists placements_activated_at_idx
  on public.placements (activated_at desc)
  where status = 'active';

-- Link health job: least recently checked active placements first.
create index if not exists placements_link_check_idx
  on public.placements (link_last_checked_at nulls first)
  where status = 'active';

-- Abuse response: "every placement pointing at this host".
create index if not exists placements_destination_host_idx
  on public.placements (destination_host)
  where destination_host is not null;

-- Image asset lookup during upload completion.
create unique index if not exists placements_image_asset_key
  on public.placements (image_asset_id) where image_asset_id is not null;

-- --- payments -----------------------------------------------------------------

create index if not exists payments_owner_idx
  on public.payments (owner_id, created_at desc);

create index if not exists payments_reservation_idx
  on public.payments (reservation_id, created_at desc);

-- Reconciler: "payments that never reached a terminal state", oldest first.
create index if not exists payments_open_idx
  on public.payments (created_at)
  where status in ('requires_payment', 'processing');

-- "Top supporters" leaderboard: settled spend by owner.
create index if not exists payments_settled_owner_idx
  on public.payments (owner_id, paid_at desc)
  where status in ('succeeded', 'partially_refunded');

-- --- stripe_events ------------------------------------------------------------

-- Reconciler + admin health: "events received but never processed".
create index if not exists stripe_events_unprocessed_idx
  on public.stripe_events (received_at)
  where processed_at is null;

create index if not exists stripe_events_type_idx
  on public.stripe_events (type, received_at desc);

create index if not exists stripe_events_reservation_idx
  on public.stripe_events (reservation_id) where reservation_id is not null;

-- --- analytics ----------------------------------------------------------------

-- Public total page views: sum over a bounded recent range.
create index if not exists view_aggregates_bucket_idx
  on public.view_aggregates (bucket_start desc);

-- Per-placement click totals and the "Rising" window query.
create index if not exists click_aggregates_placement_bucket_idx
  on public.click_aggregates (placement_id, bucket_start desc);

create index if not exists click_aggregates_bucket_idx
  on public.click_aggregates (bucket_start desc);

create index if not exists impression_aggregates_placement_bucket_idx
  on public.impression_aggregates (placement_id, bucket_start desc);

-- --- moderation / audit -------------------------------------------------------

create index if not exists moderation_actions_placement_idx
  on public.moderation_actions (placement_id, created_at desc);

create index if not exists abuse_reports_open_idx
  on public.abuse_reports (created_at) where handled_at is null;

create index if not exists abuse_reports_placement_idx
  on public.abuse_reports (placement_id, created_at desc);

-- Audit search patterns: by actor, by target, by time.
create index if not exists audit_logs_at_idx on public.audit_logs (at desc);
create index if not exists audit_logs_actor_idx on public.audit_logs (actor_id, at desc);
create index if not exists audit_logs_target_idx on public.audit_logs (target_type, target_id, at desc);
create index if not exists audit_logs_action_idx on public.audit_logs (action, at desc);

-- --- leaderboards / jobs ------------------------------------------------------

-- "Newest snapshot for each board" — DISTINCT ON (kind) ORDER BY computed_at DESC.
create index if not exists leaderboard_snapshots_kind_time_idx
  on public.leaderboard_snapshots (kind, computed_at desc);

create index if not exists job_runs_job_started_idx
  on public.job_runs (job, started_at desc);

-- --- profiles -----------------------------------------------------------------

create index if not exists profiles_admin_idx on public.profiles (id) where is_admin;
create index if not exists profiles_founding_idx on public.profiles (buyer_ordinal) where founding_buyer;
