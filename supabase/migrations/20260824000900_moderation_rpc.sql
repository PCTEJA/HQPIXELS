-- =============================================================================
-- HQPixels 0009 — moderation, audit, abuse response
-- =============================================================================

-- -----------------------------------------------------------------------------
-- write_audit
-- -----------------------------------------------------------------------------
-- Redaction happens in the Worker (worker/lib/audit.ts) before the call; this
-- function is the append-only sink. It is deliberately permissive about the
-- `detail` shape and strict about its size, because an audit write must never
-- be the thing that fails a security-relevant operation.
create or replace function public.write_audit(
  p_actor_id uuid,
  p_actor_label text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_detail jsonb default '{}'::jsonb,
  p_request_id text default null,
  p_ip_prefix text default null,
  p_user_agent_family text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
begin
  if jsonb_typeof(v_detail) <> 'object' then
    v_detail := jsonb_build_object('value', v_detail);
  end if;
  if char_length(v_detail::text) > 8192 then
    v_detail := jsonb_build_object('truncated', true, 'bytes', char_length(v_detail::text));
  end if;

  insert into public.audit_logs (
    actor_id, actor_label, action, target_type, target_id, detail,
    request_id, ip_prefix, user_agent_family
  )
  values (
    p_actor_id,
    left(coalesce(p_actor_label, 'system'), 100),
    left(p_action, 100),
    left(p_target_type, 60),
    left(p_target_id, 200),
    v_detail,
    left(p_request_id, 64),
    left(p_ip_prefix, 45),
    left(p_user_agent_family, 60)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.write_audit(uuid, text, text, text, text, jsonb, text, text, text)
  from public;
grant execute on function public.write_audit(uuid, text, text, text, text, jsonb, text, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- assert_admin
-- -----------------------------------------------------------------------------
-- Second, independent admin check. The Worker checks the role before routing;
-- this refuses to act if that check was somehow wrong. Defence in depth for the
-- highest-privilege operations in the product.
create or replace function public.assert_admin(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor_id is null or not coalesce(
    (select p.is_admin from public.profiles p where p.id = p_actor_id), false
  ) then
    raise exception 'admin_required' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke all on function public.assert_admin(uuid) from public;
grant execute on function public.assert_admin(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- approve_placement
-- -----------------------------------------------------------------------------
create or replace function public.approve_placement(
  p_placement_id uuid,
  p_admin_id uuid,
  p_note text default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_placement public.placements;
  v_res public.reservations;
  v_settled boolean;
begin
  perform public.assert_admin(p_admin_id);

  select * into v_placement from public.placements where id = p_placement_id for update;
  if v_placement.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_res
  from public.reservations where id = v_placement.reservation_id for update;

  -- Publication requires settled money. This is the check that makes
  -- "only paid placements are published" true even if an admin clicks approve
  -- on something that has not been paid for.
  select exists (
    select 1 from public.payments pay
    where pay.reservation_id = v_res.id and pay.status in ('succeeded', 'partially_refunded')
  ) into v_settled;

  if not v_settled then
    return jsonb_build_object('ok', false, 'code', 'payment_not_settled');
  end if;

  if v_placement.status not in ('pending_review', 'disabled') then
    return jsonb_build_object('ok', false, 'code', 'placement_state_invalid', 'status', v_placement.status);
  end if;

  -- Cells must still be held, or we would publish a plot someone else owns.
  if not exists (select 1 from public.pixel_cells where reservation_id = v_res.id) then
    return jsonb_build_object('ok', false, 'code', 'cells_no_longer_held');
  end if;

  update public.placements
  set status = 'active',
      moderation_state = 'approved',
      moderation_note = coalesce(p_note, moderation_note),
      moderated_by = p_admin_id,
      moderated_at = now(),
      disabled_at = null,
      disabled_reason = null,
      activated_at = coalesce(activated_at, now())
  where id = p_placement_id
  returning * into v_placement;

  if v_res.state in ('paid_pending_review', 'disabled') then
    update public.reservations set state = 'active' where id = v_res.id;
  end if;

  insert into public.moderation_actions (placement_id, actor_id, actor_kind, decision, reason)
  values (p_placement_id, p_admin_id, 'admin', 'approved', p_note);

  perform public.write_audit(
    p_admin_id, 'admin', 'placement.approve', 'placement', p_placement_id::text,
    jsonb_build_object(
      'reservationId', v_res.id,
      'host', v_placement.destination_host,
      'cells', v_res.cell_count
    ),
    p_request_id
  );

  return jsonb_build_object(
    'ok', true,
    'placementId', p_placement_id,
    'manifestVersion', (select manifest_version from public.wall_state where id)
  );
end;
$$;

revoke all on function public.approve_placement(uuid, uuid, text, text) from public;
grant execute on function public.approve_placement(uuid, uuid, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- reject_placement
-- -----------------------------------------------------------------------------
-- Does NOT talk to Stripe. It records the decision and returns the identifiers
-- the Worker needs to issue the refund, and the Worker then calls record_refund
-- with Stripe's answer. Keeping the database out of the network path means a
-- Stripe outage cannot leave this function half-applied.
create or replace function public.reject_placement(
  p_placement_id uuid,
  p_admin_id uuid,
  p_reason text,
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_placement public.placements;
  v_res public.reservations;
  v_payment public.payments;
begin
  perform public.assert_admin(p_admin_id);

  if p_reason is null or char_length(trim(p_reason)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;

  select * into v_placement from public.placements where id = p_placement_id for update;
  if v_placement.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_placement.status in ('rejected', 'chargeback_disabled') then
    return jsonb_build_object('ok', true, 'alreadyRejected', true);
  end if;

  select * into v_res from public.reservations where id = v_placement.reservation_id for update;

  select * into v_payment
  from public.payments
  where reservation_id = v_res.id and status in ('succeeded', 'partially_refunded')
  order by created_at desc
  limit 1;

  -- Take it off the wall immediately; the refund follows asynchronously.
  update public.placements
  set status = 'rejected',
      moderation_state = 'rejected',
      moderation_note = p_reason,
      moderated_by = p_admin_id,
      moderated_at = now(),
      disabled_reason = p_reason,
      disabled_at = now()
  where id = p_placement_id;

  insert into public.moderation_actions (placement_id, actor_id, actor_kind, decision, reason)
  values (p_placement_id, p_admin_id, 'admin', 'rejected', p_reason);

  perform public.write_audit(
    p_admin_id, 'admin', 'placement.reject', 'placement', p_placement_id::text,
    jsonb_build_object(
      'reservationId', v_res.id,
      'reason', left(p_reason, 500),
      'refundNeeded', v_payment.id is not null,
      'amountCents', v_payment.amount_cents
    ),
    p_request_id
  );

  return jsonb_build_object(
    'ok', true,
    'reservationId', v_res.id,
    'paymentId', v_payment.id,
    'stripePaymentIntentId', v_payment.stripe_payment_intent_id,
    'stripeChargeId', v_payment.stripe_charge_id,
    'refundAmountCents', v_payment.amount_cents - coalesce(v_payment.amount_refunded_cents, 0),
    'refundRequired', v_payment.id is not null
  );
end;
$$;

revoke all on function public.reject_placement(uuid, uuid, text, text) from public;
grant execute on function public.reject_placement(uuid, uuid, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- disable_placement / reenable_placement
-- -----------------------------------------------------------------------------
-- Disable is the fast lever for a malicious or dead link. It keeps the cells
-- held (the buyer still owns the plot) and keeps the money. Use reject+refund if
-- the buyer is entitled to their money back.
create or replace function public.disable_placement(
  p_placement_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_actor_kind text default 'admin',
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_placement public.placements;
  v_res public.reservations;
begin
  if p_actor_kind = 'admin' then
    perform public.assert_admin(p_actor_id);
  end if;

  if p_reason is null or char_length(trim(p_reason)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;

  select * into v_placement from public.placements where id = p_placement_id for update;
  if v_placement.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_placement.status = 'disabled' then
    return jsonb_build_object('ok', true, 'alreadyDisabled', true);
  end if;
  if v_placement.status not in ('active', 'pending_review') then
    return jsonb_build_object('ok', false, 'code', 'placement_state_invalid', 'status', v_placement.status);
  end if;

  update public.placements
  set status = 'disabled',
      moderation_state = 'disabled',
      disabled_reason = p_reason,
      disabled_at = now(),
      moderated_by = case when p_actor_kind = 'admin' then p_actor_id else moderated_by end,
      moderated_at = now()
  where id = p_placement_id;

  select * into v_res from public.reservations where id = v_placement.reservation_id for update;
  if v_res.state = 'active' then
    update public.reservations set state = 'disabled' where id = v_res.id;
  end if;

  insert into public.moderation_actions (placement_id, actor_id, actor_kind, decision, reason)
  values (p_placement_id, p_actor_id, p_actor_kind, 'disabled', p_reason);

  perform public.write_audit(
    p_actor_id, p_actor_kind, 'placement.disable', 'placement', p_placement_id::text,
    jsonb_build_object('reason', left(p_reason, 500), 'host', v_placement.destination_host),
    p_request_id
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.disable_placement(uuid, uuid, text, text, text) from public;
grant execute on function public.disable_placement(uuid, uuid, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- disable_placements_by_host — bulk abuse response
-- -----------------------------------------------------------------------------
-- When a destination domain turns out to be malicious, every placement pointing
-- at it must come down in one action, not one at a time.
create or replace function public.disable_placements_by_host(
  p_host text,
  p_admin_id uuid,
  p_reason text,
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  perform public.assert_admin(p_admin_id);

  if p_host is null or char_length(p_host) < 3 then
    return jsonb_build_object('ok', false, 'code', 'host_required');
  end if;

  for v_id in
    select p.id from public.placements p
    where p.status in ('active', 'pending_review')
      and (p.destination_host = lower(p_host) or p.destination_host like '%.' || lower(p_host))
  loop
    perform public.disable_placement(v_id, p_admin_id, p_reason, 'admin', p_request_id);
    v_count := v_count + 1;
  end loop;

  perform public.write_audit(
    p_admin_id, 'admin', 'placement.disable_by_host', 'host', lower(p_host),
    jsonb_build_object('count', v_count, 'reason', left(coalesce(p_reason, ''), 500)),
    p_request_id
  );

  return jsonb_build_object('ok', true, 'disabled', v_count);
end;
$$;

revoke all on function public.disable_placements_by_host(text, uuid, text, text) from public;
grant execute on function public.disable_placements_by_host(text, uuid, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- reenable_placement
-- -----------------------------------------------------------------------------
create or replace function public.reenable_placement(
  p_placement_id uuid,
  p_admin_id uuid,
  p_note text default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_placement public.placements;
begin
  perform public.assert_admin(p_admin_id);

  select * into v_placement from public.placements where id = p_placement_id for update;
  if v_placement.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_placement.status <> 'disabled' then
    return jsonb_build_object('ok', false, 'code', 'placement_state_invalid', 'status', v_placement.status);
  end if;

  insert into public.moderation_actions (placement_id, actor_id, actor_kind, decision, reason)
  values (p_placement_id, p_admin_id, 'admin', 'reenabled', p_note);

  -- Reuses approve_placement so the settled-payment and cells-held checks are
  -- applied identically on the way back up.
  return public.approve_placement(p_placement_id, p_admin_id, p_note, p_request_id);
end;
$$;

revoke all on function public.reenable_placement(uuid, uuid, text, text) from public;
grant execute on function public.reenable_placement(uuid, uuid, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- file_abuse_report
-- -----------------------------------------------------------------------------
-- Auto-disable threshold: distinct reports from different network prefixes.
-- Deliberately conservative, and only for categories where a false positive is
-- cheap compared with leaving a live threat up.
create or replace function public.file_abuse_report(
  p_placement_id uuid,
  p_category text,
  p_details text,
  p_ip_prefix text default null,
  p_reporter_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_distinct integer;
  v_auto_disable boolean := false;
begin
  if not exists (
    select 1 from public.placements
    where id = p_placement_id and status in ('active', 'pending_review')
  ) then
    -- Do not confirm whether the id exists.
    return jsonb_build_object('ok', true, 'received', true);
  end if;

  insert into public.abuse_reports (placement_id, category, details, reporter_ip_prefix, reporter_id)
  values (p_placement_id, p_category, p_details, p_ip_prefix, p_reporter_id);

  if p_category in ('malware', 'phishing', 'illegal') then
    select count(distinct coalesce(reporter_ip_prefix, id::text))
      into v_distinct
    from public.abuse_reports
    where placement_id = p_placement_id
      and category in ('malware', 'phishing', 'illegal')
      and created_at > now() - interval '24 hours';

    if v_distinct >= 3 then
      v_auto_disable := true;
      perform public.disable_placement(
        p_placement_id, null,
        format('auto-disabled: %s independent %s reports pending review', v_distinct, p_category),
        'reporter', null
      );
    end if;
  end if;

  return jsonb_build_object('ok', true, 'received', true, 'autoDisabled', v_auto_disable);
end;
$$;

revoke all on function public.file_abuse_report(uuid, text, text, text, uuid) from public;
grant execute on function public.file_abuse_report(uuid, text, text, text, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- record_link_check
-- -----------------------------------------------------------------------------
-- Called by the daily link-health job. Three consecutive failures disables the
-- placement pending review: a dead or hijacked destination is both a bad buyer
-- experience and a security risk (expired domains get re-registered by
-- malware operators).
create or replace function public.record_link_check(
  p_placement_id uuid,
  p_status_code integer,
  p_ok boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_failures integer;
  v_disabled boolean := false;
begin
  update public.placements
  set link_last_checked_at = now(),
      link_last_status = p_status_code,
      link_consecutive_failures = case when p_ok then 0 else link_consecutive_failures + 1 end
  where id = p_placement_id
  returning link_consecutive_failures into v_failures;

  if v_failures is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if not p_ok and v_failures >= 3 then
    perform public.disable_placement(
      p_placement_id, null,
      format('auto-disabled: destination unreachable %s times (last status %s)', v_failures, p_status_code),
      'system', null
    );
    v_disabled := true;
  end if;

  return jsonb_build_object('ok', true, 'failures', v_failures, 'disabled', v_disabled);
end;
$$;

revoke all on function public.record_link_check(uuid, integer, boolean) from public;
grant execute on function public.record_link_check(uuid, integer, boolean) to service_role;
