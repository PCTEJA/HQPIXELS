-- =============================================================================
-- HQPixels 0010 — analytics ingest, manifest build, stats, leaderboards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Cumulative counters
-- -----------------------------------------------------------------------------
-- The public "Total page views" number must never go DOWN. Bucketed rows age
-- out after 400 days (data minimisation), so the published total is kept as a
-- monotonic counter alongside them rather than being a SUM over rows that get
-- deleted.
alter table public.wall_state
  add column if not exists total_page_views bigint not null default 0;

-- ADD CONSTRAINT has no IF NOT EXISTS, so guard it for repeatable runs.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wall_state_views_nonneg'
  ) then
    alter table public.wall_state
      add constraint wall_state_views_nonneg check (total_page_views >= 0);
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- bucket_start — normalise any timestamp to its 5 minute bucket
-- -----------------------------------------------------------------------------
-- Normalising rather than rejecting is the safer design: a caller cannot invent
-- overlapping windows to inflate a total, because every timestamp collapses onto
-- the same grid.
create or replace function public.analytics_bucket(p_ts timestamptz)
returns timestamptz
language sql
immutable
security invoker
set search_path = ''
as $$
  select to_timestamp(floor(extract(epoch from p_ts) / 300) * 300);
$$;

comment on function public.analytics_bucket(timestamptz) is
  'Floors a timestamp to a 5 minute boundary. The only way bucket_start values '
  'are produced.';

-- -----------------------------------------------------------------------------
-- ingest_view_aggregates
-- -----------------------------------------------------------------------------
-- Input: [{ "bucketStart": "...", "surface": "wall", "views": 120, "filtered": 4 }]
-- Called by the AnalyticsBufferDO flush and by the cron safety net. Additive and
-- idempotent-by-design in the sense that re-flushing the same batch would double
-- count, so the DO clears its buffer only after a successful call — see
-- worker/do/analytics-buffer.ts for the ordering.
create or replace function public.ingest_view_aggregates(p_batch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_count integer := 0;
  v_views bigint := 0;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'batch_must_be_array');
  end if;
  if jsonb_array_length(p_batch) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'batch_too_large');
  end if;

  for v_row in select jsonb_array_elements(p_batch) loop
    insert into public.view_aggregates (bucket_start, surface, views, filtered, updated_at)
    values (
      public.analytics_bucket((v_row ->> 'bucketStart')::timestamptz),
      coalesce(nullif(v_row ->> 'surface', ''), 'other'),
      greatest(coalesce((v_row ->> 'views')::bigint, 0), 0),
      greatest(coalesce((v_row ->> 'filtered')::bigint, 0), 0),
      now()
    )
    on conflict (bucket_start, surface) do update
    set views = public.view_aggregates.views + excluded.views,
        filtered = public.view_aggregates.filtered + excluded.filtered,
        updated_at = now();

    v_count := v_count + 1;
    v_views := v_views + greatest(coalesce((v_row ->> 'views')::bigint, 0), 0);
  end loop;

  -- Monotonic public counter, updated once per batch rather than once per row.
  if v_views > 0 then
    update public.wall_state
    set total_page_views = total_page_views + v_views, updated_at = now()
    where id;
  end if;

  return jsonb_build_object('ok', true, 'rows', v_count, 'views', v_views);
end;
$$;

revoke all on function public.ingest_view_aggregates(jsonb) from public;
grant execute on function public.ingest_view_aggregates(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- ingest_click_aggregates
-- -----------------------------------------------------------------------------
create or replace function public.ingest_click_aggregates(p_batch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_count integer := 0;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'batch_must_be_array');
  end if;
  if jsonb_array_length(p_batch) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'batch_too_large');
  end if;

  for v_row in select jsonb_array_elements(p_batch) loop
    -- Skip rows for placements that no longer exist rather than failing the
    -- whole batch: a placement can be deleted between a click and its flush.
    if exists (select 1 from public.placements where id = (v_row ->> 'placementId')::uuid) then
      insert into public.click_aggregates (
        bucket_start, placement_id, clicks, filtered, distinct_visitors_est, updated_at
      )
      values (
        public.analytics_bucket((v_row ->> 'bucketStart')::timestamptz),
        (v_row ->> 'placementId')::uuid,
        greatest(coalesce((v_row ->> 'clicks')::bigint, 0), 0),
        greatest(coalesce((v_row ->> 'filtered')::bigint, 0), 0),
        greatest(coalesce((v_row ->> 'distinctVisitors')::integer, 0), 0),
        now()
      )
      on conflict (bucket_start, placement_id) do update
      set clicks = public.click_aggregates.clicks + excluded.clicks,
          filtered = public.click_aggregates.filtered + excluded.filtered,
          distinct_visitors_est = greatest(
            public.click_aggregates.distinct_visitors_est,
            excluded.distinct_visitors_est
          ),
          updated_at = now();
      v_count := v_count + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'rows', v_count);
end;
$$;

revoke all on function public.ingest_click_aggregates(jsonb) from public;
grant execute on function public.ingest_click_aggregates(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- ingest_impression_aggregates
-- -----------------------------------------------------------------------------
create or replace function public.ingest_impression_aggregates(p_batch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_count integer := 0;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'batch_must_be_array');
  end if;
  if jsonb_array_length(p_batch) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'batch_too_large');
  end if;

  for v_row in select jsonb_array_elements(p_batch) loop
    if exists (select 1 from public.placements where id = (v_row ->> 'placementId')::uuid) then
      insert into public.impression_aggregates (bucket_start, placement_id, impressions, updated_at)
      values (
        public.analytics_bucket((v_row ->> 'bucketStart')::timestamptz),
        (v_row ->> 'placementId')::uuid,
        greatest(coalesce((v_row ->> 'impressions')::bigint, 0), 0),
        now()
      )
      on conflict (bucket_start, placement_id) do update
      set impressions = public.impression_aggregates.impressions + excluded.impressions,
          updated_at = now();
      v_count := v_count + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'rows', v_count);
end;
$$;

revoke all on function public.ingest_impression_aggregates(jsonb) from public;
grant execute on function public.ingest_impression_aggregates(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- build_wall_manifest
-- -----------------------------------------------------------------------------
-- Produces the entire public payload in one round trip. Called only by the
-- manifest rebuild path (webhook fulfilment, admin approval, cron safety net) —
-- never on a page view. The result is written to KV and served from the edge.
--
-- `imagePath` is a provider-relative path; the Worker prefixes the delivery
-- hostname. Keeping the hostname out of the database means rotating the image
-- provider does not require a data migration.
create or replace function public.build_wall_manifest()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_version bigint;
  v_placements jsonb;
  v_claimed integer;
  v_bitmap text;
begin
  select w.manifest_version into v_version from public.wall_state w where w.id;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.cell_y, t.cell_x), '[]'::jsonb)
    into v_placements
  from (
    select
      p.id,
      p.cell_x  as x,
      p.cell_y  as y,
      p.cell_w  as w,
      p.cell_h  as h,
      p.title,
      p.alt_text as "altText",
      p.destination_host as host,
      p.image_public_path as "imagePath",
      -- Public label only. Never the email.
      coalesce(nullif(pr.display_name, ''), pr.handle) as owner,
      pr.handle as "ownerHandle",
      pr.founding_buyer as "foundingBuyer",
      p.activated_at as "activatedAt",
      p.cell_x, p.cell_y
    from public.placements p
    join public.profiles pr on pr.id = p.owner_id
    where p.status = 'active'
  ) t;

  select count(*) into v_claimed from public.pixel_cells;

  -- PostgreSQL's encode(...,'base64') wraps at 76 characters; strip the
  -- newlines so the value is a single JSON string token.
  select replace(encode(public.occupancy_bitmap(), 'base64'), chr(10), '') into v_bitmap;

  return jsonb_build_object(
    'manifestVersion', v_version,
    'generatedAt', now(),
    'grid', jsonb_build_object('size', 100, 'cellLogicalSize', 10),
    'placements', v_placements,
    'occupancyBitmap', v_bitmap,
    'counts', jsonb_build_object(
      'activePlacements', jsonb_array_length(v_placements),
      'claimedCells', v_claimed,
      'availableCells', 10000 - v_claimed
    )
  );
end;
$$;

revoke all on function public.build_wall_manifest() from public;
grant execute on function public.build_wall_manifest() to service_role;

-- -----------------------------------------------------------------------------
-- manifest_version — the cheap freshness probe
-- -----------------------------------------------------------------------------
create or replace function public.manifest_version()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select w.manifest_version from public.wall_state w where w.id;
$$;

revoke all on function public.manifest_version() from public;
grant execute on function public.manifest_version() to service_role;

-- -----------------------------------------------------------------------------
-- public_stats_payload
-- -----------------------------------------------------------------------------
-- Every number here is defined precisely, because the UI states the definition
-- next to the number:
--   * totalPageViews  — successful human-facing page loads after bot filtering.
--                       NOT unique visitors, NOT people.
--   * settledPurchases— payments in 'succeeded' or 'partially_refunded'. Refunded,
--                       disputed, failed and admin-seeded rows are excluded.
--   * outboundClicks30d — fraud-filtered clicks through /go/:id in 30 days.
create or replace function public.public_stats_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_views bigint;
  v_claimed integer;
  v_pricing public.pricing_versions;
  v_settled integer;
  v_owners integer;
  v_clicks bigint;
  v_founding_used integer;
  v_recent jsonb;
begin
  select w.total_page_views into v_views from public.wall_state w where w.id;
  select count(*) into v_claimed from public.pixel_cells;
  select * into v_pricing from public.pricing_versions where is_active limit 1;

  select count(*) into v_settled
  from public.payments
  where status in ('succeeded', 'partially_refunded');

  select count(distinct p.owner_id) into v_owners
  from public.placements p where p.status = 'active';

  select coalesce(sum(c.clicks), 0) into v_clicks
  from public.click_aggregates c
  where c.bucket_start > now() - interval '30 days';

  select count(*) into v_founding_used from public.profiles where founding_buyer;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.activated_at desc), '[]'::jsonb)
    into v_recent
  from (
    select p.cell_x as x, p.cell_y as y, p.cell_w as w, p.cell_h as h,
           p.title, p.activated_at as "activatedAt", p.activated_at
    from public.placements p
    where p.status = 'active' and p.activated_at is not null
    order by p.activated_at desc
    limit 12
  ) t;

  return jsonb_build_object(
    'generatedAt', now(),
    'totalPageViews', v_views,
    'countersLagSeconds', 180,
    'inventory', jsonb_build_object(
      'totalCells', 10000,
      'claimedCells', v_claimed,
      'availableCells', 10000 - v_claimed,
      -- Basis points, integer: the client never divides. claimed * 10000 /
      -- TOTAL_CELLS; with TOTAL_CELLS = 10000 those cancel, so this is written
      -- out in full rather than simplified, to stay correct if the grid changes.
      'percentSoldBp', (v_claimed::bigint * 10000) / 10000,
      'totalLogicalPixels', 1000000,
      'claimedLogicalPixels', v_claimed::bigint * 100
    ),
    'pricing', jsonb_build_object(
      'version', coalesce(v_pricing.version, 0),
      'currency', 'USD',
      'centsPerLogicalPixel', coalesce(v_pricing.cents_per_logical_pixel, 0),
      'minimumPurchaseCents', coalesce(v_pricing.cents_per_logical_pixel, 0) * 100
    ),
    'activity', jsonb_build_object(
      'settledPurchases', v_settled,
      'distinctOwners', v_owners,
      'outboundClicks30d', v_clicks,
      'foundingBuyersRemaining', greatest(100 - v_founding_used, 0)
    ),
    'recentlyClaimed', v_recent
  );
end;
$$;

revoke all on function public.public_stats_payload() from public;
grant execute on function public.public_stats_payload() to service_role;

-- -----------------------------------------------------------------------------
-- rebuild_leaderboards
-- -----------------------------------------------------------------------------
-- Four independent boards, each with an explicit methodology string that is
-- rendered next to it. No composite score, because a composite score cannot be
-- explained honestly.
--
-- Excluded everywhere: unpaid, refunded, disputed, rejected and disabled rows.
create or replace function public.rebuild_leaderboards()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entries jsonb;
  v_written integer := 0;
begin
  -- 1. Largest owners — active logical-pixel area.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.rank), '[]'::jsonb) into v_entries
  from (
    select
      row_number() over (order by sum(p.cell_w * p.cell_h) desc, min(p.activated_at)) as rank,
      coalesce(nullif(pr.display_name, ''), pr.handle, 'Anonymous owner') as label,
      pr.handle,
      null::uuid as "placementId",
      sum(p.cell_w * p.cell_h) * 100 as value,
      'logical_pixels' as "valueUnit",
      pr.founding_buyer as "foundingBuyer"
    from public.placements p
    join public.profiles pr on pr.id = p.owner_id
    where p.status = 'active'
    group by pr.id, pr.display_name, pr.handle, pr.founding_buyer
    order by sum(p.cell_w * p.cell_h) desc, min(p.activated_at)
    limit 25
  ) t;

  insert into public.leaderboard_snapshots (kind, payload)
  values ('largest_owners', jsonb_build_object(
    'entries', v_entries,
    'methodology', 'Total logical pixels across every placement that is currently live on the wall.',
    'windowDescription', 'Current state, all time'
  ));
  v_written := v_written + 1;

  -- 2. Top supporters — settled lifetime spend, net of refunds, disputes excluded.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.rank), '[]'::jsonb) into v_entries
  from (
    select
      row_number() over (order by sum(pay.amount_cents - pay.amount_refunded_cents) desc, min(pay.paid_at)) as rank,
      coalesce(nullif(pr.display_name, ''), pr.handle, 'Anonymous supporter') as label,
      pr.handle,
      null::uuid as "placementId",
      sum(pay.amount_cents - pay.amount_refunded_cents) as value,
      'cents' as "valueUnit",
      pr.founding_buyer as "foundingBuyer"
    from public.payments pay
    join public.profiles pr on pr.id = pay.owner_id
    where pay.status in ('succeeded', 'partially_refunded')
    group by pr.id, pr.display_name, pr.handle, pr.founding_buyer
    having sum(pay.amount_cents - pay.amount_refunded_cents) > 0
    order by sum(pay.amount_cents - pay.amount_refunded_cents) desc, min(pay.paid_at)
    limit 25
  ) t;

  insert into public.leaderboard_snapshots (kind, payload)
  values ('top_supporters', jsonb_build_object(
    'entries', v_entries,
    'methodology',
      'Settled payments minus refunds, in USD. Disputed, failed and pending payments are excluded.',
    'windowDescription', 'All time'
  ));
  v_written := v_written + 1;

  -- 3. Most visited — fraud-filtered outbound clicks, 30 days.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.rank), '[]'::jsonb) into v_entries
  from (
    select
      row_number() over (order by sum(c.clicks) desc, p.activated_at) as rank,
      p.title as label,
      pr.handle,
      p.id as "placementId",
      sum(c.clicks) as value,
      'clicks' as "valueUnit",
      pr.founding_buyer as "foundingBuyer"
    from public.click_aggregates c
    join public.placements p on p.id = c.placement_id
    join public.profiles pr on pr.id = p.owner_id
    where p.status = 'active'
      and c.bucket_start > now() - interval '30 days'
    group by p.id, p.title, p.activated_at, pr.handle, pr.founding_buyer
    having sum(c.clicks) > 0
    order by sum(c.clicks) desc, p.activated_at
    limit 25
  ) t;

  insert into public.leaderboard_snapshots (kind, payload)
  values ('most_visited', jsonb_build_object(
    'entries', v_entries,
    'methodology',
      'Outbound clicks through hqpixels.com/go that passed our duplicate and bot filters.',
    'windowDescription', 'Last 30 days'
  ));
  v_written := v_written + 1;

  -- 4. Rising — clicks in the last 48 hours, above an anti-abuse floor.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.rank), '[]'::jsonb) into v_entries
  from (
    select
      row_number() over (order by sum(c.clicks) desc, p.activated_at desc) as rank,
      p.title as label,
      pr.handle,
      p.id as "placementId",
      sum(c.clicks) as value,
      'clicks' as "valueUnit",
      pr.founding_buyer as "foundingBuyer"
    from public.click_aggregates c
    join public.placements p on p.id = c.placement_id
    join public.profiles pr on pr.id = p.owner_id
    where p.status = 'active'
      and c.bucket_start > now() - interval '48 hours'
    group by p.id, p.title, p.activated_at, pr.handle, pr.founding_buyer
    -- Floor of 25 clicks: below that, a handful of clicks would dominate the
    -- board and it would be trivial to game.
    having sum(c.clicks) >= 25
    order by sum(c.clicks) desc, p.activated_at desc
    limit 25
  ) t;

  insert into public.leaderboard_snapshots (kind, payload)
  values ('rising', jsonb_build_object(
    'entries', v_entries,
    'methodology',
      'Filtered outbound clicks in the last 48 hours. A placement needs at least '
      '25 clicks in the window to appear, so a small burst cannot top the board.',
    'windowDescription', 'Last 48 hours'
  ));
  v_written := v_written + 1;

  -- Keep a short history for trend debugging, not forever.
  delete from public.leaderboard_snapshots
  where computed_at < now() - interval '30 days';

  return jsonb_build_object('ok', true, 'boards', v_written);
end;
$$;

revoke all on function public.rebuild_leaderboards() from public;
grant execute on function public.rebuild_leaderboards() to service_role;

-- -----------------------------------------------------------------------------
-- latest_leaderboards
-- -----------------------------------------------------------------------------
create or replace function public.latest_leaderboards()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_boards jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', s.kind,
    'computedAt', s.computed_at,
    'payload', s.payload
  ) order by array_position(
    array['largest_owners', 'top_supporters', 'most_visited', 'rising'], s.kind
  )), '[]'::jsonb)
  into v_boards
  from (
    select distinct on (kind) kind, computed_at, payload
    from public.leaderboard_snapshots
    order by kind, computed_at desc
  ) s;

  return jsonb_build_object('generatedAt', now(), 'boards', v_boards);
end;
$$;

revoke all on function public.latest_leaderboards() from public;
grant execute on function public.latest_leaderboards() to service_role;

-- -----------------------------------------------------------------------------
-- purge_expired_privacy_data
-- -----------------------------------------------------------------------------
-- Data minimisation, enforced by a job rather than by good intentions.
-- Retention windows are documented in the privacy policy and must match.
create or replace function public.purge_expired_privacy_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res integer;
  v_abuse integer;
  v_audit integer;
  v_views integer;
begin
  -- Reservation IP prefixes: 30 days (abuse correlation only).
  update public.reservations
  set created_ip_prefix = null
  where created_ip_prefix is not null and created_at < now() - interval '30 days';
  get diagnostics v_res = row_count;

  -- Abuse-report reporter prefixes: 7 days.
  update public.abuse_reports
  set reporter_ip_prefix = null
  where reporter_ip_prefix is not null and created_at < now() - interval '7 days';
  get diagnostics v_abuse = row_count;

  -- Audit IP prefixes: 90 days. The audit RECORD itself is permanent; only the
  -- network identifier ages out.
  update public.audit_logs
  set ip_prefix = null
  where ip_prefix is not null and at < now() - interval '90 days';
  get diagnostics v_audit = row_count;

  -- Analytics buckets older than 400 days are rolled off. Totals shown publicly
  -- are cumulative counters maintained separately, so this does not rewrite
  -- history that has already been published.
  delete from public.view_aggregates where bucket_start < now() - interval '400 days';
  get diagnostics v_views = row_count;

  return jsonb_build_object(
    'ok', true,
    'reservationPrefixesCleared', v_res,
    'abusePrefixesCleared', v_abuse,
    'auditPrefixesCleared', v_audit,
    'viewBucketsDeleted', v_views
  );
end;
$$;

revoke all on function public.purge_expired_privacy_data() from public;
grant execute on function public.purge_expired_privacy_data() to service_role;
