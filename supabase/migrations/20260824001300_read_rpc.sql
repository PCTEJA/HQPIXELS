-- =============================================================================
-- HQPixels 0013 — read paths (dashboard, admin, redirects, status)
-- =============================================================================
-- Each of these is a single round trip that returns exactly the shape the Worker
-- serialises. Building them in SQL rather than as N queries in the Worker keeps
-- the transactional API within its latency budget and makes the "no N+1" rule
-- structural.

-- -----------------------------------------------------------------------------
-- build_redirect_map
-- -----------------------------------------------------------------------------
-- placementId -> destination URL, for every active placement.
--
-- This is the reason /go/:placementId does not query the database. The map is
-- written to KV (a PRIVATE key, never served to a browser) alongside each
-- manifest rebuild, so a click costs one KV read and one in-memory counter
-- increment. Full destination URLs must never appear in the public manifest.
create or replace function public.build_redirect_map()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(
      p.id::text,
      jsonb_build_object('url', p.destination_url, 'host', p.destination_host)
    ),
    '{}'::jsonb
  )
  from public.placements p
  where p.status = 'active' and p.destination_url is not null;
$$;

revoke all on function public.build_redirect_map() from public;
grant execute on function public.build_redirect_map() to service_role;

-- -----------------------------------------------------------------------------
-- resolve_destination — cold-path fallback for /go/:id
-- -----------------------------------------------------------------------------
-- Used only when the KV redirect map is missing or stale (fresh deploy, KV
-- eviction). Rate limited at the edge like every other click.
create or replace function public.resolve_destination(p_placement_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object('ok', true, 'url', p.destination_url, 'host', p.destination_host)
    into v_result
  from public.placements p
  where p.id = p_placement_id
    and p.status = 'active'
    and p.destination_url is not null;

  -- A disabled, rejected or unknown placement is indistinguishable to the
  -- caller: /go/:id must not tell a prober which ids exist.
  return coalesce(v_result, jsonb_build_object('ok', false, 'code', 'not_found'));
end;
$$;

revoke all on function public.resolve_destination(uuid) from public;
grant execute on function public.resolve_destination(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- buyer_dashboard
-- -----------------------------------------------------------------------------
-- Ownership is a WHERE clause on owner_id, not a filter applied afterwards in
-- the Worker. Metrics are summed from the aggregate tables, so a buyer with a
-- popular placement does not cause an expensive scan.
create or replace function public.buyer_dashboard(p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_placements jsonb;
  v_totals jsonb;
begin
  select * into v_profile from public.profiles where id = p_owner_id;
  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into v_placements
  from (
    select
      p.id                as "placementId",
      r.id                as "reservationId",
      r.state,
      p.status            as "placementStatus",
      p.cell_x as x, p.cell_y as y, p.cell_w as w, p.cell_h as h,
      (p.cell_w * p.cell_h * 100) as "logicalPixels",
      p.title,
      p.alt_text          as "altText",
      p.destination_url   as "destinationUrl",
      p.destination_host  as "destinationHost",
      p.image_public_path as "imagePath",
      coalesce(pay.amount_cents - pay.amount_refunded_cents, 0) as "amountPaidCents",
      r.quoted_total_cents as "quotedTotalCents",
      r.currency,
      r.created_at        as "createdAt",
      r.expires_at        as "expiresAt",
      p.activated_at      as "activatedAt",
      p.moderation_note   as "moderationNote",
      jsonb_build_object(
        'impressions', coalesce(imp.total, 0),
        'clicks', coalesce(clk.total, 0),
        'clicks7d', coalesce(clk.total_7d, 0),
        'lastClickAt', clk.last_at
      ) as metrics,
      r.created_at
    from public.placements p
    join public.reservations r on r.id = p.reservation_id
    left join lateral (
      select sum(ia.impressions) as total
      from public.impression_aggregates ia where ia.placement_id = p.id
    ) imp on true
    left join lateral (
      select
        sum(ca.clicks) as total,
        sum(ca.clicks) filter (where ca.bucket_start > now() - interval '7 days') as total_7d,
        max(ca.bucket_start) filter (where ca.clicks > 0) as last_at
      from public.click_aggregates ca where ca.placement_id = p.id
    ) clk on true
    left join lateral (
      select pay2.amount_cents, pay2.amount_refunded_cents
      from public.payments pay2
      where pay2.reservation_id = r.id
        and pay2.status in ('succeeded', 'partially_refunded', 'refunded', 'disputed')
      order by pay2.created_at desc
      limit 1
    ) pay on true
    where p.owner_id = p_owner_id
  ) t;

  select jsonb_build_object(
    'activePlacements', count(*) filter (where p.status = 'active'),
    'logicalPixelsOwned',
      coalesce(sum(p.cell_w * p.cell_h * 100) filter (where p.status = 'active'), 0),
    'lifetimeSpendCents', coalesce((
      select sum(pay.amount_cents - pay.amount_refunded_cents)
      from public.payments pay
      where pay.owner_id = p_owner_id and pay.status in ('succeeded', 'partially_refunded')
    ), 0),
    'impressions', coalesce((
      select sum(ia.impressions) from public.impression_aggregates ia
      join public.placements pp on pp.id = ia.placement_id
      where pp.owner_id = p_owner_id
    ), 0),
    'clicks', coalesce((
      select sum(ca.clicks) from public.click_aggregates ca
      join public.placements pp on pp.id = ca.placement_id
      where pp.owner_id = p_owner_id
    ), 0)
  ) into v_totals
  from public.placements p
  where p.owner_id = p_owner_id;

  return jsonb_build_object(
    'ok', true,
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'displayName', v_profile.display_name,
      'handle', v_profile.handle,
      'email', v_profile.email,
      'emailVerified', v_profile.email_verified,
      'foundingBuyer', v_profile.founding_buyer,
      'isAdmin', v_profile.is_admin
    ),
    'totals', v_totals,
    'placements', v_placements
  );
end;
$$;

revoke all on function public.buyer_dashboard(uuid) from public;
grant execute on function public.buyer_dashboard(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- reservation_status — what the checkout success page may read
-- -----------------------------------------------------------------------------
-- Read-only by construction. There is no code path from this function to
-- publication, which is why refreshing the success page cannot fulfil a payment.
create or replace function public.reservation_status(p_reservation_id uuid, p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
  v_payment public.payments;
  v_placement public.placements;
begin
  select * into v_res
  from public.reservations
  where id = p_reservation_id and owner_id = p_owner_id;

  -- Not found rather than forbidden: do not confirm that someone else's
  -- reservation id exists.
  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_payment
  from public.payments
  where reservation_id = p_reservation_id
  order by created_at desc
  limit 1;

  select * into v_placement from public.placements where reservation_id = p_reservation_id;

  return jsonb_build_object(
    'ok', true,
    'reservationId', v_res.id,
    'reservationState', v_res.state,
    'paymentStatus', coalesce(v_payment.status::text, 'requires_payment'),
    'placementStatus', coalesce(v_placement.status::text, 'draft'),
    'placementId', v_placement.id,
    'amountCents', v_res.quoted_total_cents,
    'currency', v_res.currency,
    'expiresAt', v_res.expires_at,
    'fulfilled', v_res.state in ('paid_pending_review', 'active'),
    'moderationNote', v_placement.moderation_note
  );
end;
$$;

revoke all on function public.reservation_status(uuid, uuid) from public;
grant execute on function public.reservation_status(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- reservation_detail — the claim wizard's own view of its reservation
-- -----------------------------------------------------------------------------
create or replace function public.reservation_detail(p_reservation_id uuid, p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
  v_placement public.placements;
  v_version integer;
begin
  select * into v_res
  from public.reservations where id = p_reservation_id and owner_id = p_owner_id;
  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_placement from public.placements where reservation_id = p_reservation_id;
  select pv.version into v_version
  from public.pricing_versions pv where pv.id = v_res.pricing_version_id;

  return jsonb_build_object(
    'ok', true,
    'reservation', jsonb_build_object(
      'id', v_res.id,
      'state', v_res.state,
      'x', v_res.cell_x, 'y', v_res.cell_y, 'w', v_res.cell_w, 'h', v_res.cell_h,
      'cells', v_res.cell_count,
      'logicalPixels', v_res.logical_pixel_count,
      'totalCents', v_res.quoted_total_cents,
      'currency', v_res.currency,
      'pricingVersion', v_version,
      'quoteBreakdown', v_res.quote_breakdown,
      'expiresAt', v_res.expires_at,
      'createdAt', v_res.created_at,
      'checkoutAttempt', v_res.checkout_attempt,
      'acceptedTermsVersion', v_res.accepted_terms_version
    ),
    'placement', jsonb_build_object(
      'id', v_placement.id,
      'status', v_placement.status,
      'title', v_placement.title,
      'altText', v_placement.alt_text,
      'destinationUrl', v_placement.destination_url,
      'destinationHost', v_placement.destination_host,
      'imagePath', v_placement.image_public_path,
      'imageWidth', v_placement.image_width,
      'imageHeight', v_placement.image_height,
      'moderationState', v_placement.moderation_state
    )
  );
end;
$$;

revoke all on function public.reservation_detail(uuid, uuid) from public;
grant execute on function public.reservation_detail(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- admin_moderation_queue
-- -----------------------------------------------------------------------------
-- Keyset pagination on created_at, so the queue stays O(limit) however long it
-- gets. Admin identity is verified by assert_admin, not by the caller's word.
create or replace function public.admin_moderation_queue(
  p_admin_id uuid,
  p_status text default 'pending_review',
  p_limit integer default 25,
  p_cursor timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_limit integer := greatest(least(coalesce(p_limit, 25), 100), 1);
begin
  perform public.assert_admin(p_admin_id);

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at), '[]'::jsonb)
    into v_items
  from (
    select
      p.id as "placementId",
      r.id as "reservationId",
      p.status as "placementStatus",
      r.state as "reservationState",
      p.cell_x as x, p.cell_y as y, p.cell_w as w, p.cell_h as h,
      p.title,
      p.alt_text as "altText",
      p.destination_url as "destinationUrl",
      p.destination_host as "destinationHost",
      p.image_asset_id as "imageAssetId",
      p.image_public_path as "imagePath",
      p.image_width as "imageWidth",
      p.image_height as "imageHeight",
      p.moderation_state as "moderationState",
      p.moderation_note as "moderationNote",
      p.link_last_status as "linkLastStatus",
      p.link_consecutive_failures as "linkFailures",
      jsonb_build_object(
        'id', pr.id, 'email', pr.email, 'handle', pr.handle,
        'displayName', pr.display_name, 'foundingBuyer', pr.founding_buyer,
        'previousPlacements', (
          select count(*) from public.placements pp
          where pp.owner_id = pr.id and pp.status = 'active'
        ),
        'previousRejections', (
          select count(*) from public.placements pp
          where pp.owner_id = pr.id and pp.status in ('rejected', 'chargeback_disabled')
        )
      ) as buyer,
      jsonb_build_object(
        'status', coalesce(pay.status::text, 'requires_payment'),
        'amountCents', coalesce(pay.amount_cents, r.quoted_total_cents),
        'amountRefundedCents', coalesce(pay.amount_refunded_cents, 0),
        'stripeCheckoutSessionId', pay.stripe_checkout_session_id,
        'stripePaymentIntentId', pay.stripe_payment_intent_id,
        'paidAt', pay.paid_at
      ) as payment,
      -- Flattened: one entry per individual check, not one array per action row.
      coalesce((
        select jsonb_agg(chk)
        from public.moderation_actions ma
        cross join lateral jsonb_array_elements(ma.checks) as chk
        where ma.placement_id = p.id and ma.actor_kind = 'system'
      ), '[]'::jsonb) as "automatedChecks",
      (
        select count(*) from public.abuse_reports ar
        where ar.placement_id = p.id and ar.handled_at is null
      ) as "openReports",
      p.created_at as "createdAt",
      p.created_at
    from public.placements p
    join public.reservations r on r.id = p.reservation_id
    join public.profiles pr on pr.id = p.owner_id
    left join lateral (
      select * from public.payments pay2
      where pay2.reservation_id = r.id
      order by pay2.created_at desc limit 1
    ) pay on true
    where (p_status = 'all' or p.status::text = p_status)
      and (p_cursor is null or p.created_at > p_cursor)
    order by p.created_at
    limit v_limit
  ) t;

  return jsonb_build_object(
    'ok', true,
    'items', v_items,
    'nextCursor', (
      select max((item ->> 'createdAt')::timestamptz)
      from jsonb_array_elements(v_items) as item
    )
  );
end;
$$;

revoke all on function public.admin_moderation_queue(uuid, text, integer, timestamptz) from public;
grant execute on function public.admin_moderation_queue(uuid, text, integer, timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- admin_health
-- -----------------------------------------------------------------------------
create or replace function public.admin_health(p_admin_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin(p_admin_id);

  return jsonb_build_object(
    'ok', true,
    'manifestVersion', (select manifest_version from public.wall_state where id),
    'manifestUpdatedAt', (select updated_at from public.wall_state where id),
    'totalPageViews', (select total_page_views from public.wall_state where id),
    'pendingReview', (select count(*) from public.placements where status = 'pending_review'),
    'activePlacements', (select count(*) from public.placements where status = 'active'),
    'claimedCells', (select count(*) from public.pixel_cells),
    'openCheckouts', (
      select count(*) from public.payments where status in ('requires_payment', 'processing')
    ),
    'expiredAwaitingRelease', (
      select count(*) from public.reservations r
      where r.state in ('draft', 'reserved', 'ready_for_checkout', 'checkout_created')
        and r.expires_at < now() - interval '2 minutes'
    ),
    'unprocessedStripeEvents', (
      select count(*) from public.stripe_events where processed_at is null
    ),
    'stripeEventFailures', (
      select count(*) from public.stripe_events
      where outcome like 'error:%' and received_at > now() - interval '24 hours'
    ),
    'openAbuseReports', (select count(*) from public.abuse_reports where handled_at is null),
    'linkChecksFailing', (
      select count(*) from public.placements
      where status = 'active' and link_consecutive_failures > 0
    ),
    'settledRevenueCents', (
      select coalesce(sum(amount_cents - amount_refunded_cents), 0)
      from public.payments where status in ('succeeded', 'partially_refunded')
    ),
    'disputedPayments', (select count(*) from public.payments where status = 'disputed'),
    'jobs', coalesce((
      select jsonb_object_agg(j.job, jsonb_build_object(
        'lastRunAt', j.started_at, 'ok', j.ok, 'items', j.items_processed, 'note', j.note
      ))
      from (
        select distinct on (job) job, started_at, ok, items_processed, note
        from public.job_runs order by job, started_at desc
      ) j
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.admin_health(uuid) from public;
grant execute on function public.admin_health(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- admin_audit_page
-- -----------------------------------------------------------------------------
create or replace function public.admin_audit_page(
  p_admin_id uuid,
  p_limit integer default 50,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  perform public.assert_admin(p_admin_id);

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.at desc), '[]'::jsonb) into v_items
  from (
    select a.id, a.at, a.actor_id as "actorId", a.actor_label as "actorLabel",
           a.action, a.target_type as "targetType", a.target_id as "targetId",
           a.detail, a.request_id as "requestId"
    from public.audit_logs a
    where p_before is null or a.at < p_before
    order by a.at desc
    limit greatest(least(coalesce(p_limit, 50), 200), 1)
  ) t;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

revoke all on function public.admin_audit_page(uuid, integer, timestamptz) from public;
grant execute on function public.admin_audit_page(uuid, integer, timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- record_job_run
-- -----------------------------------------------------------------------------
create or replace function public.record_job_run(
  p_job text, p_ok boolean, p_items integer, p_note text default null
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.job_runs (job, finished_at, ok, items_processed, note)
  values (left(p_job, 60), now(), p_ok, greatest(coalesce(p_items, 0), 0), left(p_note, 1000));
$$;

revoke all on function public.record_job_run(text, boolean, integer, text) from public;
grant execute on function public.record_job_run(text, boolean, integer, text) to service_role;

-- -----------------------------------------------------------------------------
-- links_due_for_check
-- -----------------------------------------------------------------------------
create or replace function public.links_due_for_check(p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'placementId', t.id, 'url', t.destination_url, 'host', t.destination_host
  )), '[]'::jsonb)
  from (
    select p.id, p.destination_url, p.destination_host
    from public.placements p
    where p.status = 'active'
      and p.destination_url is not null
      and (p.link_last_checked_at is null or p.link_last_checked_at < now() - interval '7 days')
    order by p.link_last_checked_at nulls first
    limit greatest(least(coalesce(p_limit, 50), 200), 1)
  ) t;
$$;

revoke all on function public.links_due_for_check(integer) from public;
grant execute on function public.links_due_for_check(integer) to service_role;

-- -----------------------------------------------------------------------------
-- open_payments_for_reconciliation
-- -----------------------------------------------------------------------------
-- Feeds the scheduled reconciler: local payments that never reached a terminal
-- state and are old enough that a webhook should already have arrived.
create or replace function public.open_payments_for_reconciliation(p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'paymentId', t.id,
    'reservationId', t.reservation_id,
    'sessionId', t.stripe_checkout_session_id,
    'amountCents', t.amount_cents,
    'status', t.status,
    'createdAt', t.created_at,
    'checkoutExpiresAt', t.checkout_expires_at
  )), '[]'::jsonb)
  from (
    select p.*
    from public.payments p
    where p.status in ('requires_payment', 'processing')
      and p.stripe_checkout_session_id is not null
      -- Give webhooks a few minutes before we go asking Stripe directly.
      and p.created_at < now() - interval '5 minutes'
    order by p.created_at
    limit greatest(least(coalesce(p_limit, 50), 200), 1)
  ) t;
$$;

revoke all on function public.open_payments_for_reconciliation(integer) from public;
grant execute on function public.open_payments_for_reconciliation(integer) to service_role;
