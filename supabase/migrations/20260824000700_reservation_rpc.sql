-- =============================================================================
-- HQPixels 0007 — the reservation transaction
-- =============================================================================
-- This is the single most important function in the system. Read the whole thing
-- before changing any of it.
--
-- Contract: exactly one caller (the Worker, as service_role) may invoke it. It
-- either creates a complete reservation holding every requested cell, or it
-- changes nothing at all. There is no intermediate state in which some cells are
-- held and others are not, because all the writes happen inside one PL/pgSQL
-- block whose exception handler rolls the block back as a unit.
--
-- Concurrency: two callers requesting overlapping rectangles race on
-- pixel_cells' PRIMARY KEY. One wins, the other receives unique_violation, and
-- its whole block is rolled back. Cells are inserted in a deterministic
-- (y, x) order so two overlapping requests always take row locks in the same
-- sequence, which turns a potential deadlock into a plain serialisation wait.

create or replace function public.reserve_cells(
  p_owner_id                     uuid,
  p_x                            integer,
  p_y                            integer,
  p_w                            integer,
  p_h                            integer,
  p_pricing_version              integer,
  -- What the browser thinks the price is. Used only to detect disagreement and
  -- report `quote_changed`; never used as the price.
  p_expected_total_cents         integer,
  -- What the Worker computed with shared/pricing.ts. Cross-checked against this
  -- function's own computation; a mismatch is a bug, not a user error.
  p_worker_total_cents           integer,
  p_quote_breakdown              jsonb,
  p_terms_version                text,
  p_ip_prefix                    text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pricing         public.pricing_versions;
  v_db_total        integer;
  v_cells           integer := p_w * p_h;
  v_reservation_id  uuid;
  v_placement_id    uuid;
  v_expires_at      timestamptz;
  v_open_count      integer;
  v_held_cells      integer;
  v_email_verified  boolean;
  v_reservation     public.reservations;
begin
  -- ---------------------------------------------------------------------------
  -- 1. Authentication / authorisation preconditions
  -- ---------------------------------------------------------------------------
  -- The Worker has already checked the session. Re-checking here means a bug in
  -- one layer is not sufficient to allocate inventory.
  select p.email_verified into v_email_verified
  from public.profiles p where p.id = p_owner_id;

  if v_email_verified is null then
    return jsonb_build_object('ok', false, 'code', 'owner_not_found');
  end if;

  -- Verified email is required to hold inventory, not just to pay: an
  -- unverified account holding 25% of the wall is a denial-of-inventory attack.
  if not v_email_verified then
    return jsonb_build_object('ok', false, 'code', 'email_unverified');
  end if;

  -- ---------------------------------------------------------------------------
  -- 2. Geometry and pricing basis
  -- ---------------------------------------------------------------------------
  if p_x is null or p_y is null or p_w is null or p_h is null
     or p_x < 0 or p_y < 0 or p_w < 1 or p_h < 1
     or p_x + p_w > 100 or p_y + p_h > 100
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_rect');
  end if;

  select * into v_pricing
  from public.pricing_versions
  where version = p_pricing_version;

  if v_pricing.id is null then
    return jsonb_build_object('ok', false, 'code', 'pricing_version_not_found');
  end if;

  -- A reservation may only be created against the CURRENTLY active price book.
  -- Quoting an old version would let a buyer replay a cheaper price.
  if not v_pricing.is_active then
    return jsonb_build_object(
      'ok', false,
      'code', 'pricing_version_inactive',
      'activeVersion', (select pv.version from public.pricing_versions pv where pv.is_active)
    );
  end if;

  if v_cells < v_pricing.min_cells then
    return jsonb_build_object('ok', false, 'code', 'selection_too_small');
  end if;
  if v_cells > least(v_pricing.max_cells, 2500) then
    return jsonb_build_object('ok', false, 'code', 'selection_too_large');
  end if;

  -- ---------------------------------------------------------------------------
  -- 3. Price, computed here and cross-checked
  -- ---------------------------------------------------------------------------
  v_db_total := public.quote_total_cents(v_pricing.id, p_x, p_y, p_w, p_h);

  -- The two independent implementations must agree. If they do not, refuse to
  -- take money and surface it loudly — this is a code defect.
  if p_worker_total_cents is null or p_worker_total_cents <> v_db_total then
    raise exception
      'quote_engine_disagreement'
      using errcode = 'raise_exception',
            detail = format(
              'worker=%s db=%s rect=%s,%s,%s,%s pricing=%s',
              p_worker_total_cents, v_db_total, p_x, p_y, p_w, p_h, p_pricing_version
            );
  end if;

  -- The buyer saw a different number. Do not silently charge the new one.
  if p_expected_total_cents is distinct from v_db_total then
    return jsonb_build_object(
      'ok', false,
      'code', 'quote_changed',
      'totalCents', v_db_total,
      'expectedTotalCents', p_expected_total_cents
    );
  end if;

  -- ---------------------------------------------------------------------------
  -- 4. Per-buyer abuse limits
  -- ---------------------------------------------------------------------------
  -- Rate limiting at the edge stops floods; these limits stop a *patient*
  -- actor from parking inventory they never intend to buy.
  select count(*), coalesce(sum(r.cell_count), 0)
    into v_open_count, v_held_cells
  from public.reservations r
  where r.owner_id = p_owner_id
    and r.state in ('draft', 'reserved', 'ready_for_checkout', 'checkout_created')
    and r.expires_at > now();

  if v_open_count >= 3 then
    return jsonb_build_object('ok', false, 'code', 'too_many_open_reservations', 'openCount', v_open_count);
  end if;
  if v_held_cells + v_cells > 2500 then
    return jsonb_build_object('ok', false, 'code', 'held_cell_limit_exceeded', 'heldCells', v_held_cells);
  end if;

  v_expires_at := now() + make_interval(secs => v_pricing.reservation_ttl_seconds);

  -- ---------------------------------------------------------------------------
  -- 5. The atomic write
  -- ---------------------------------------------------------------------------
  -- Everything below either all happens or none of it does. The exception
  -- handler establishes a subtransaction boundary at the BEGIN.
  begin
    insert into public.reservations (
      owner_id, pricing_version_id, state,
      cell_x, cell_y, cell_w, cell_h, cell_count, logical_pixel_count,
      quoted_total_cents, currency, quote_breakdown,
      expires_at, accepted_terms_version, accepted_terms_at, created_ip_prefix
    )
    values (
      p_owner_id, v_pricing.id, 'reserved',
      p_x, p_y, p_w, p_h, v_cells, v_cells * 100,
      v_db_total, 'USD', coalesce(p_quote_breakdown, '{}'::jsonb),
      v_expires_at, p_terms_version, now(), p_ip_prefix
    )
    returning id into v_reservation_id;

    insert into public.placements (
      reservation_id, owner_id, status, cell_x, cell_y, cell_w, cell_h
    )
    values (v_reservation_id, p_owner_id, 'draft', p_x, p_y, p_w, p_h)
    returning id into v_placement_id;

    -- One statement, deterministic order. This is the anti-double-allocation
    -- mechanism: any conflict aborts the entire block.
    insert into public.pixel_cells (cell_x, cell_y, reservation_id, placement_id, owner_id)
    select gx, gy, v_reservation_id, v_placement_id, p_owner_id
    from generate_series(p_y, p_y + p_h - 1) as gy,
         generate_series(p_x, p_x + p_w - 1) as gx
    order by gy, gx;

  exception
    when unique_violation then
      -- Someone else claimed at least one of these cells first.
      return jsonb_build_object('ok', false, 'code', 'cells_unavailable');
    when deadlock_detected or serialization_failure then
      -- Two overlapping requests interleaved. Safe and correct to retry.
      return jsonb_build_object('ok', false, 'code', 'cells_contended');
  end;

  select * into v_reservation from public.reservations where id = v_reservation_id;

  return jsonb_build_object(
    'ok', true,
    'reservation', jsonb_build_object(
      'id', v_reservation.id,
      'state', v_reservation.state,
      'x', v_reservation.cell_x,
      'y', v_reservation.cell_y,
      'w', v_reservation.cell_w,
      'h', v_reservation.cell_h,
      'cells', v_reservation.cell_count,
      'logicalPixels', v_reservation.logical_pixel_count,
      'totalCents', v_reservation.quoted_total_cents,
      'currency', v_reservation.currency,
      'pricingVersion', v_pricing.version,
      'expiresAt', v_reservation.expires_at,
      'createdAt', v_reservation.created_at
    ),
    'placementId', v_placement_id
  );
end;
$$;

revoke all on function public.reserve_cells(
  uuid, integer, integer, integer, integer, integer, integer, integer, jsonb, text, text
) from public;
grant execute on function public.reserve_cells(
  uuid, integer, integer, integer, integer, integer, integer, integer, jsonb, text, text
) to service_role;

comment on function public.reserve_cells(
  uuid, integer, integer, integer, integer, integer, integer, integer, jsonb, text, text
) is
  'Atomically reserve a rectangle of cells. Returns {ok:true, reservation} or '
  '{ok:false, code}. Never partially succeeds.';


-- =============================================================================
-- release_reservation — return cells to the wall
-- =============================================================================
-- The ONLY path by which cells become available again. Called for expiry,
-- refund and chargeback. Never called because a browser closed.
create or replace function public.release_reservation(
  p_reservation_id uuid,
  p_new_state public.reservation_state,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
  v_deleted integer;
begin
  -- FOR UPDATE: serialise against a concurrent webhook fulfilling this same
  -- reservation. Whichever gets the lock first wins, and the loser re-reads.
  select * into v_res from public.reservations where id = p_reservation_id for update;

  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'reservation_not_found');
  end if;

  if not exists (
    select 1 from public.reservation_transitions t
    where t.from_state = v_res.state and t.to_state = p_new_state
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'illegal_transition',
      'from', v_res.state, 'to', p_new_state
    );
  end if;

  delete from public.pixel_cells where reservation_id = p_reservation_id;
  get diagnostics v_deleted = row_count;

  update public.reservations set state = p_new_state where id = p_reservation_id;

  update public.placements
  set status = (case p_new_state
        when 'expired' then 'draft'
        when 'payment_failed' then 'draft'
        when 'rejected_refunded' then 'rejected'
        when 'chargeback_disabled' then 'chargeback_disabled'
        else 'disabled'
      end)::public.placement_status,
      disabled_reason = coalesce(p_reason, 'released'),
      disabled_at = case when p_new_state = 'expired' then null else now() end
  where reservation_id = p_reservation_id;

  return jsonb_build_object('ok', true, 'cellsReleased', v_deleted, 'state', p_new_state);
end;
$$;

revoke all on function public.release_reservation(uuid, public.reservation_state, text) from public;
grant execute on function public.release_reservation(uuid, public.reservation_state, text) to service_role;


-- =============================================================================
-- expire_reservations — the scheduled sweeper
-- =============================================================================
-- Batched and idempotent, so running it twice concurrently is harmless.
-- SKIP LOCKED means two overlapping cron invocations divide the work instead of
-- blocking on each other.
create or replace function public.expire_reservations(
  p_grace_seconds integer default 60,
  p_limit integer default 200
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_expired integer := 0;
  v_cells integer := 0;
  v_result jsonb;
begin
  for v_id in
    select r.id
    from public.reservations r
    where r.state in ('draft', 'reserved', 'ready_for_checkout', 'checkout_created')
      and r.expires_at < now() - make_interval(secs => greatest(p_grace_seconds, 0))
      -- Never expire something with settled or in-flight money against it.
      -- Once Stripe has the payment, only a webhook or the reconciler decides.
      and not exists (
        select 1 from public.payments pay
        where pay.reservation_id = r.id
          and pay.status in ('succeeded', 'processing', 'refunded', 'partially_refunded', 'disputed')
      )
    order by r.expires_at
    limit greatest(least(p_limit, 1000), 1)
    for update skip locked
  loop
    v_result := public.release_reservation(v_id, 'expired', 'hold expired');
    if (v_result ->> 'ok')::boolean then
      v_expired := v_expired + 1;
      v_cells := v_cells + coalesce((v_result ->> 'cellsReleased')::integer, 0);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'reservationsExpired', v_expired, 'cellsReleased', v_cells);
end;
$$;

revoke all on function public.expire_reservations(integer, integer) from public;
grant execute on function public.expire_reservations(integer, integer) to service_role;


-- =============================================================================
-- set_placement_details — artwork, title, alt text, destination
-- =============================================================================
-- Ownership is re-verified here, not just in the Worker. `p_owner_id` is the
-- authenticated user; a mismatch is an IDOR attempt and returns not_found (not
-- forbidden) so the endpoint does not confirm the id exists.
create or replace function public.set_placement_details(
  p_reservation_id  uuid,
  p_owner_id        uuid,
  p_title           text,
  p_alt_text        text,
  p_destination_url text,
  p_destination_host text,
  p_image_asset_id  text default null,
  p_image_public_path text default null,
  p_image_width     integer default null,
  p_image_height    integer default null,
  p_image_bytes     integer default null,
  p_image_mime      text default null,
  p_moderation_state public.moderation_decision default 'auto_flag',
  p_checks          jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
  v_placement public.placements;
  v_ready boolean;
begin
  select * into v_res
  from public.reservations
  where id = p_reservation_id and owner_id = p_owner_id
  for update;

  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  -- Details may only be edited while the hold is live and unpaid. After payment
  -- the admin/moderation path owns the row.
  if v_res.state not in ('reserved', 'ready_for_checkout') then
    return jsonb_build_object('ok', false, 'code', 'reservation_state_invalid', 'state', v_res.state);
  end if;

  if v_res.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'reservation_expired');
  end if;

  update public.placements p
  set title = coalesce(p_title, p.title),
      alt_text = coalesce(p_alt_text, p.alt_text),
      destination_url = coalesce(p_destination_url, p.destination_url),
      destination_host = coalesce(p_destination_host, p.destination_host),
      image_asset_id = coalesce(p_image_asset_id, p.image_asset_id),
      image_public_path = coalesce(p_image_public_path, p.image_public_path),
      image_width = coalesce(p_image_width, p.image_width),
      image_height = coalesce(p_image_height, p.image_height),
      image_bytes = coalesce(p_image_bytes, p.image_bytes),
      image_mime = coalesce(p_image_mime, p.image_mime),
      image_uploaded_at = case
        when p_image_asset_id is not null then now() else p.image_uploaded_at
      end,
      moderation_state = p_moderation_state
  where p.reservation_id = p_reservation_id
  returning * into v_placement;

  if v_placement.id is null then
    return jsonb_build_object('ok', false, 'code', 'placement_missing');
  end if;

  if p_checks is not null and jsonb_array_length(p_checks) > 0 then
    insert into public.moderation_actions (placement_id, actor_kind, decision, checks)
    values (v_placement.id, 'system', p_moderation_state, p_checks);
  end if;

  -- Complete enough to pay for?
  v_ready :=
    v_placement.image_public_path is not null
    and char_length(v_placement.title) > 0
    and char_length(v_placement.alt_text) > 0
    and v_placement.destination_url is not null
    and v_placement.destination_host is not null
    and p_moderation_state <> 'auto_reject';

  if v_ready and v_res.state = 'reserved' then
    update public.reservations set state = 'ready_for_checkout' where id = p_reservation_id;
  elsif not v_ready and v_res.state = 'ready_for_checkout' then
    -- Edited back into an incomplete state: withdraw checkout eligibility.
    update public.reservations set state = 'reserved' where id = p_reservation_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'ready', v_ready,
    'placementId', v_placement.id,
    'state', (select r.state from public.reservations r where r.id = p_reservation_id)
  );
end;
$$;

revoke all on function public.set_placement_details(
  uuid, uuid, text, text, text, text, text, text, integer, integer, integer, text,
  public.moderation_decision, jsonb
) from public;
grant execute on function public.set_placement_details(
  uuid, uuid, text, text, text, text, text, text, integer, integer, integer, text,
  public.moderation_decision, jsonb
) to service_role;
