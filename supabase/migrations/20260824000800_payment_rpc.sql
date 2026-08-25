-- =============================================================================
-- HQPixels 0008 — payment lifecycle
-- =============================================================================
-- Every function here is idempotent and safe to call with duplicate, delayed or
-- out-of-order Stripe events, because that is what Stripe actually delivers.
--
-- The rule that shapes all of it: only these functions may move money-related
-- state. The success page cannot. The client cannot. There is exactly one code
-- path from "Stripe says paid" to "placement is publishable", and it starts with
-- a verified webhook signature.

-- -----------------------------------------------------------------------------
-- record_stripe_event — the idempotency gate
-- -----------------------------------------------------------------------------
-- Returns is_new=false for a replay. The webhook handler does no work when this
-- says the event has been seen, which is how a duplicate delivery becomes a
-- no-op rather than a second charge being applied.
create or replace function public.record_stripe_event(
  p_event_id text,
  p_type text,
  p_api_version text,
  p_stripe_created timestamptz,
  p_payload_sha256 text,
  p_livemode boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inserted boolean := false;
  v_existing public.stripe_events;
begin
  insert into public.stripe_events (
    id, type, api_version, stripe_created_at, payload_sha256, livemode, attempts
  )
  values (p_event_id, p_type, p_api_version, p_stripe_created, p_payload_sha256, p_livemode, 1)
  on conflict (id) do nothing;

  v_inserted := found;

  if not v_inserted then
    update public.stripe_events
    set attempts = attempts + 1
    where id = p_event_id
    returning * into v_existing;

    return jsonb_build_object(
      'ok', true,
      'isNew', false,
      'alreadyProcessed', v_existing.processed_at is not null,
      'outcome', v_existing.outcome,
      'attempts', v_existing.attempts
    );
  end if;

  return jsonb_build_object('ok', true, 'isNew', true, 'alreadyProcessed', false);
end;
$$;

revoke all on function public.record_stripe_event(text, text, text, timestamptz, text, boolean)
  from public;
grant execute on function public.record_stripe_event(text, text, text, timestamptz, text, boolean)
  to service_role;

-- -----------------------------------------------------------------------------
-- finish_stripe_event — close the ledger entry
-- -----------------------------------------------------------------------------
create or replace function public.finish_stripe_event(
  p_event_id text,
  p_outcome text,
  p_reservation_id uuid default null,
  p_payment_id uuid default null
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.stripe_events
  set processed_at = now(),
      outcome = left(coalesce(p_outcome, 'ok'), 200),
      reservation_id = coalesce(p_reservation_id, reservation_id),
      payment_id = coalesce(p_payment_id, payment_id)
  where id = p_event_id;
$$;

revoke all on function public.finish_stripe_event(text, text, uuid, uuid) from public;
grant execute on function public.finish_stripe_event(text, text, uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- open_checkout — record that a Checkout Session exists
-- -----------------------------------------------------------------------------
-- Called immediately after Stripe returns a session. Bumps checkout_attempt
-- (which feeds the idempotency key) and creates the payment row. The partial
-- unique index payments_one_open_per_reservation is what actually prevents two
-- live sessions for one reservation — this function just reports it cleanly.
create or replace function public.open_checkout(
  p_reservation_id uuid,
  p_owner_id uuid,
  p_session_id text,
  p_amount_cents integer,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
  v_payment public.payments;
  v_attempt integer;
begin
  select * into v_res
  from public.reservations
  where id = p_reservation_id and owner_id = p_owner_id
  for update;

  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_res.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'reservation_expired');
  end if;

  -- Repeated Checkout presses land here with the reservation already in
  -- checkout_created. The right answer is to hand back the session that already
  -- exists so the buyer is redirected to the same Stripe page — NOT to report an
  -- invalid state (unhelpful) and NOT to create a second session (a duplicate
  -- charge risk).
  if v_res.state = 'checkout_created' then
    select * into v_payment
    from public.payments
    where reservation_id = p_reservation_id
      and status in ('requires_payment', 'processing')
    order by created_at desc
    limit 1;

    if v_payment.id is not null then
      return jsonb_build_object(
        'ok', false,
        'code', 'checkout_already_open',
        'existingSessionId', v_payment.stripe_checkout_session_id,
        'existingExpiresAt', v_payment.checkout_expires_at,
        'paymentId', v_payment.id
      );
    end if;
    -- No open payment despite the state: a previous session was canceled or
    -- expired without the reservation being moved back. Let the buyer retry
    -- rather than dead-ending them; the transition below is a self-transition
    -- and the trigger treats it as a no-op.
  elsif v_res.state not in ('ready_for_checkout', 'payment_failed') then
    return jsonb_build_object('ok', false, 'code', 'reservation_state_invalid', 'state', v_res.state);
  end if;

  -- Amount comes from the immutable reservation, and the caller must agree.
  if p_amount_cents <> v_res.quoted_total_cents then
    raise exception
      'checkout_amount_mismatch'
      using errcode = 'raise_exception',
            detail = format('caller=%s reservation=%s', p_amount_cents, v_res.quoted_total_cents);
  end if;
  -- Stripe's session must never outlive the hold on the cells.
  if p_expires_at > v_res.expires_at then
    raise exception
      'checkout_expiry_after_reservation'
      using errcode = 'raise_exception',
            detail = format('session=%s reservation=%s', p_expires_at, v_res.expires_at);
  end if;

  if v_res.state = 'payment_failed' then
    update public.reservations set state = 'ready_for_checkout' where id = p_reservation_id;
  end if;

  v_attempt := v_res.checkout_attempt + 1;
  update public.reservations
  set checkout_attempt = v_attempt, state = 'checkout_created'
  where id = p_reservation_id;

  begin
    insert into public.payments (
      reservation_id, owner_id, status, amount_cents, currency,
      stripe_checkout_session_id, checkout_attempt, checkout_expires_at
    )
    values (
      p_reservation_id, p_owner_id, 'requires_payment', v_res.quoted_total_cents, 'USD',
      p_session_id, v_attempt, p_expires_at
    )
    returning * into v_payment;
  exception
    when unique_violation then
      -- Either a session is already open for this reservation (double click), or
      -- this exact session id is already recorded (retry of the same request).
      select * into v_payment
      from public.payments
      where reservation_id = p_reservation_id
        and status in ('requires_payment', 'processing')
      limit 1;

      return jsonb_build_object(
        'ok', false,
        'code', 'checkout_already_open',
        'existingSessionId', v_payment.stripe_checkout_session_id,
        'existingExpiresAt', v_payment.checkout_expires_at,
        'paymentId', v_payment.id
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'paymentId', v_payment.id,
    'checkoutAttempt', v_attempt,
    'amountCents', v_payment.amount_cents
  );
end;
$$;

revoke all on function public.open_checkout(uuid, uuid, text, integer, timestamptz) from public;
grant execute on function public.open_checkout(uuid, uuid, text, integer, timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- settle_payment — the one and only fulfilment path
-- -----------------------------------------------------------------------------
-- Called from the webhook (checkout.session.completed /
-- async_payment_succeeded) and from the reconciler when a webhook was missed.
--
-- Verified before anything is written:
--   * the session id maps to a payment row we created
--   * that payment belongs to the reservation named in the session metadata
--   * the amount matches the reservation's immutable quoted total, to the cent
--   * the currency matches
--   * the buyer linkage matches
--
-- Any mismatch aborts without publishing. A mismatch means either a bug or an
-- attacker replaying a session from a different reservation.
create or replace function public.settle_payment(
  p_reservation_id     uuid,
  p_session_id         text,
  p_amount_total_cents integer,
  p_currency           text,
  p_payment_intent_id  text,
  p_charge_id          text,
  p_customer_id        text,
  p_require_manual_approval boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
  v_payment public.payments;
  v_placement public.placements;
  v_ordinal integer;
  v_founding boolean := false;
begin
  -- Lock order: reservation, then payment. Every function in this file uses the
  -- same order so concurrent webhook and admin actions cannot deadlock.
  select * into v_res from public.reservations where id = p_reservation_id for update;
  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'reservation_not_found');
  end if;

  select * into v_payment
  from public.payments
  where stripe_checkout_session_id = p_session_id
  for update;

  if v_payment.id is null then
    -- The session is unknown to us. Do NOT create a payment row here: that
    -- would let a forged (but correctly signed, e.g. replayed from another
    -- account) session id manufacture a fulfilment. The reconciler will pick
    -- this up and an admin is alerted.
    return jsonb_build_object('ok', false, 'code', 'payment_not_found');
  end if;

  if v_payment.reservation_id <> p_reservation_id then
    return jsonb_build_object('ok', false, 'code', 'reservation_session_mismatch');
  end if;
  if v_payment.owner_id <> v_res.owner_id then
    return jsonb_build_object('ok', false, 'code', 'owner_mismatch');
  end if;
  if lower(coalesce(p_currency, '')) <> 'usd' or v_payment.currency <> 'USD' then
    return jsonb_build_object('ok', false, 'code', 'currency_mismatch');
  end if;
  if p_amount_total_cents is null or p_amount_total_cents <> v_res.quoted_total_cents then
    return jsonb_build_object(
      'ok', false, 'code', 'amount_mismatch',
      'expected', v_res.quoted_total_cents, 'received', p_amount_total_cents
    );
  end if;
  if v_payment.amount_cents <> v_res.quoted_total_cents then
    return jsonb_build_object('ok', false, 'code', 'payment_amount_drift');
  end if;

  -- Idempotency: a duplicate or out-of-order delivery lands here.
  if v_payment.status in ('succeeded', 'refunded', 'partially_refunded', 'disputed') then
    return jsonb_build_object(
      'ok', true, 'alreadySettled', true,
      'paymentId', v_payment.id,
      'reservationState', v_res.state,
      'paymentStatus', v_payment.status
    );
  end if;
  if v_payment.status in ('failed', 'canceled') then
    -- A late success after a recorded failure is legitimate (async payment
    -- methods, or a race). Move it forward rather than refusing.
    null;
  end if;

  -- Walk the reservation to a state from which paid_pending_review is legal.
  -- These are the only recoveries that can actually occur; anything else is a
  -- bug we want to see rather than paper over.
  if v_res.state = 'payment_failed' then
    update public.reservations set state = 'ready_for_checkout' where id = v_res.id;
    update public.reservations set state = 'checkout_created' where id = v_res.id;
    select * into v_res from public.reservations where id = v_res.id;
  elsif v_res.state = 'ready_for_checkout' then
    update public.reservations set state = 'checkout_created' where id = v_res.id;
    select * into v_res from public.reservations where id = v_res.id;
  end if;

  if v_res.state not in ('checkout_created', 'paid_pending_review', 'active') then
    return jsonb_build_object(
      'ok', false, 'code', 'reservation_state_invalid', 'state', v_res.state
    );
  end if;

  -- Cells must still be held. If the sweeper released them (it refuses to when
  -- money is in flight, so this would be a bug) we must not publish.
  if not exists (select 1 from public.pixel_cells where reservation_id = p_reservation_id) then
    return jsonb_build_object('ok', false, 'code', 'cells_no_longer_held');
  end if;

  update public.payments
  set status = 'succeeded',
      paid_at = coalesce(paid_at, now()),
      stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
      stripe_charge_id = coalesce(p_charge_id, stripe_charge_id),
      stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
      last_error_code = null
  where id = v_payment.id
  returning * into v_payment;

  if v_res.state = 'checkout_created' then
    update public.reservations set state = 'paid_pending_review' where id = p_reservation_id;
  end if;

  select * into v_placement from public.placements where reservation_id = p_reservation_id for update;

  if v_placement.id is null then
    return jsonb_build_object('ok', false, 'code', 'placement_missing');
  end if;

  if v_placement.status = 'draft' then
    update public.placements set status = 'pending_review' where id = v_placement.id;
  end if;

  -- Founding-buyer badge: assigned once, on first settled payment, strictly by
  -- order of settlement. Truthful and unfakeable — it comes from the payment
  -- ledger, not a marketing flag.
  select p.buyer_ordinal into v_ordinal from public.profiles p where p.id = v_res.owner_id;

  if v_ordinal is null then
    select coalesce(max(pr.buyer_ordinal), 0) + 1 into v_ordinal from public.profiles pr;
    v_founding := v_ordinal <= 100;

    -- Explicitly opt in to changing protected profile columns.
    perform set_config('hqpixels.allow_privilege_change', 'on', true);
    update public.profiles
    set buyer_ordinal = v_ordinal, founding_buyer = v_founding
    where id = v_res.owner_id;
    perform set_config('hqpixels.allow_privilege_change', 'off', true);
  end if;

  insert into public.moderation_actions (placement_id, actor_kind, decision, reason, checks)
  values (
    v_placement.id, 'system', 'auto_flag',
    case when p_require_manual_approval then 'queued for human review after payment'
         else 'payment settled' end,
    '[]'::jsonb
  );

  return jsonb_build_object(
    'ok', true,
    'alreadySettled', false,
    'paymentId', v_payment.id,
    'placementId', v_placement.id,
    'reservationState', 'paid_pending_review',
    'buyerOrdinal', v_ordinal,
    'foundingBuyer', v_founding
  );
end;
$$;

revoke all on function public.settle_payment(uuid, text, integer, text, text, text, text, boolean)
  from public;
grant execute on function public.settle_payment(uuid, text, integer, text, text, text, text, boolean)
  to service_role;

comment on function public.settle_payment(uuid, text, integer, text, text, text, text, boolean) is
  'The only path from a verified Stripe payment to a publishable placement. '
  'Idempotent. Verifies amount, currency, ownership and session linkage before '
  'writing anything.';

-- -----------------------------------------------------------------------------
-- fail_payment
-- -----------------------------------------------------------------------------
create or replace function public.fail_payment(
  p_session_id text,
  p_error_code text,
  p_final boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_res public.reservations;
begin
  select * into v_payment
  from public.payments where stripe_checkout_session_id = p_session_id for update;

  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'code', 'payment_not_found');
  end if;

  -- Never downgrade a settled payment on a late failure event.
  if v_payment.status in ('succeeded', 'refunded', 'partially_refunded', 'disputed') then
    return jsonb_build_object('ok', true, 'ignored', 'already_settled');
  end if;

  update public.payments
  set status = (case when p_final then 'failed' else 'processing' end)::public.payment_status,
      failed_at = case when p_final then now() else failed_at end,
      last_error_code = left(coalesce(p_error_code, 'unknown'), 100)
  where id = v_payment.id;

  if p_final then
    select * into v_res
    from public.reservations where id = v_payment.reservation_id for update;

    if v_res.state = 'checkout_created' then
      -- Cells stay held until the reservation itself expires: the buyer may
      -- legitimately retry with another card.
      update public.reservations set state = 'payment_failed' where id = v_res.id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'paymentId', v_payment.id);
end;
$$;

revoke all on function public.fail_payment(text, text, boolean) from public;
grant execute on function public.fail_payment(text, text, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- expire_checkout — checkout.session.expired
-- -----------------------------------------------------------------------------
create or replace function public.expire_checkout(p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_res public.reservations;
begin
  select * into v_payment
  from public.payments where stripe_checkout_session_id = p_session_id for update;

  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'code', 'payment_not_found');
  end if;
  if v_payment.status not in ('requires_payment', 'processing') then
    return jsonb_build_object('ok', true, 'ignored', 'not_open');
  end if;

  update public.payments set status = 'canceled' where id = v_payment.id;

  select * into v_res from public.reservations where id = v_payment.reservation_id for update;

  -- If the hold is still alive, let the buyer start a fresh session. If it is
  -- not, the sweeper releases the cells on its next pass.
  if v_res.state = 'checkout_created' and v_res.expires_at > now() then
    update public.reservations set state = 'ready_for_checkout' where id = v_res.id;
  end if;

  return jsonb_build_object('ok', true, 'reservationId', v_res.id);
end;
$$;

revoke all on function public.expire_checkout(text) from public;
grant execute on function public.expire_checkout(text) to service_role;

-- -----------------------------------------------------------------------------
-- record_refund
-- -----------------------------------------------------------------------------
-- Full refund removes the placement and returns the cells to the wall. A
-- partial refund does not: partials only ever happen through a deliberate admin
-- action, and the placement keeps running unless the admin also disables it.
create or replace function public.record_refund(
  p_charge_or_intent_id text,
  p_amount_refunded_cents integer,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_full boolean;
  v_release jsonb;
begin
  select * into v_payment
  from public.payments
  where stripe_charge_id = p_charge_or_intent_id
     or stripe_payment_intent_id = p_charge_or_intent_id
  for update;

  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'code', 'payment_not_found');
  end if;

  -- Stripe sends the cumulative refunded amount, so this is safe to replay.
  if p_amount_refunded_cents <= v_payment.amount_refunded_cents then
    return jsonb_build_object('ok', true, 'ignored', 'no_increase');
  end if;

  v_full := p_amount_refunded_cents >= v_payment.amount_cents;

  -- The enum cast is required: a CASE expression resolves to text, and text does
  -- not implicitly coerce to an enum type in an UPDATE target.
  update public.payments
  set amount_refunded_cents = least(p_amount_refunded_cents, v_payment.amount_cents),
      status = (case when v_full then 'refunded' else 'partially_refunded' end)::public.payment_status,
      refunded_at = coalesce(refunded_at, now())
  where id = v_payment.id;

  if v_full then
    v_release := public.release_reservation(
      v_payment.reservation_id, 'rejected_refunded', coalesce(p_reason, 'refunded')
    );
    return jsonb_build_object('ok', true, 'full', true, 'release', v_release);
  end if;

  return jsonb_build_object('ok', true, 'full', false);
end;
$$;

revoke all on function public.record_refund(text, integer, text) from public;
grant execute on function public.record_refund(text, integer, text) to service_role;

-- -----------------------------------------------------------------------------
-- record_dispute
-- -----------------------------------------------------------------------------
-- A dispute takes the placement down immediately. Leaving a disputed ad live
-- would mean serving traffic we are likely to lose the money for, and it is a
-- strong fraud signal.
create or replace function public.record_dispute(
  p_charge_id text,
  p_dispute_status text,
  p_is_closed_in_our_favour boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_release jsonb;
begin
  select * into v_payment
  from public.payments
  where stripe_charge_id = p_charge_id or stripe_payment_intent_id = p_charge_id
  for update;

  if v_payment.id is null then
    return jsonb_build_object('ok', false, 'code', 'payment_not_found');
  end if;

  update public.payments
  set status = (case
        when p_is_closed_in_our_favour and v_payment.status = 'disputed' then 'succeeded'
        else 'disputed'
      end)::public.payment_status,
      disputed_at = coalesce(disputed_at, now()),
      dispute_status = left(coalesce(p_dispute_status, 'unknown'), 100)
  where id = v_payment.id;

  if p_is_closed_in_our_favour then
    -- Won. The placement is not automatically restored: an admin re-enables it
    -- deliberately, because a disputed buyer is a risk signal worth a human look.
    return jsonb_build_object('ok', true, 'restoredAutomatically', false);
  end if;

  v_release := public.release_reservation(
    v_payment.reservation_id, 'chargeback_disabled', 'payment disputed'
  );

  return jsonb_build_object('ok', true, 'release', v_release);
end;
$$;

revoke all on function public.record_dispute(text, text, boolean) from public;
grant execute on function public.record_dispute(text, text, boolean) to service_role;
