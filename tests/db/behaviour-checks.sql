-- =============================================================================
-- HQPixels — database behaviour checks (no pgTAP required)
-- =============================================================================
-- Runs against a throwaway cluster with the shim + all migrations applied:
--
--   powershell -File scripts/pg-verify.ps1            # create cluster
--   powershell -File scripts/pg-apply.ps1 -Behaviour  # apply + run this file
--
-- Every check records pass/fail in hqtest.results instead of aborting, so one
-- run reports every problem. The file RAISEs at the end if anything failed, so
-- it is usable as a CI gate.
--
-- The pgTAP versions of these same assertions live in supabase/tests/ and run
-- via `supabase test db` when Docker is available. This file exists so the
-- transactional guarantees can be verified with nothing but psql.
-- =============================================================================

\set ON_ERROR_STOP on

drop schema if exists hqtest cascade;
create schema hqtest;

create table hqtest.results (
  id serial primary key,
  suite text not null,
  name text not null,
  ok boolean not null,
  detail text
);

-- The RLS suite below does `set local role anon` / `authenticated` and then
-- records results, so those roles need to be able to write to the results table.
-- Without this the probes fail with "permission denied for schema hqtest" and we
-- would be measuring the harness, not the policies.
grant usage on schema hqtest to anon, authenticated;
grant insert, select on hqtest.results to anon, authenticated;
grant usage, select on all sequences in schema hqtest to anon, authenticated;

-- A NULL assertion counts as a FAILURE, never a pass. Three-valued logic is the
-- classic way a SQL test suite silently stops testing anything.
create or replace function hqtest.check(
  p_suite text, p_name text, p_ok boolean, p_detail text default null
) returns void language plpgsql as $$
begin
  insert into hqtest.results (suite, name, ok, detail)
  values (
    p_suite,
    p_name,
    coalesce(p_ok, false),
    case
      when p_ok is null then concat('ASSERTION EVALUATED TO NULL; ', coalesce(p_detail, ''))
      else p_detail
    end
  );
end;
$$;

-- Records a pass when the block raises, a fail when it does not.
create or replace function hqtest.check_raises(
  p_suite text, p_name text, p_sql text, p_expect_substring text default null
) returns void language plpgsql as $$
declare
  v_msg text;
begin
  execute p_sql;
  perform hqtest.check(p_suite, p_name, false, 'expected an exception, none raised');
exception
  when others then
    v_msg := sqlerrm;
    if p_expect_substring is null or position(lower(p_expect_substring) in lower(v_msg)) > 0 then
      perform hqtest.check(p_suite, p_name, true, v_msg);
    else
      perform hqtest.check(
        p_suite, p_name, false,
        format('raised %L but expected it to mention %L', v_msg, p_expect_substring)
      );
    end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------
-- Verified buyers, one unverified buyer, one admin. Profiles are created by the
-- auth.users trigger, which is itself part of what we are testing.
--
-- Dave and Erin exist so the refund and dispute suites start from a clean buyer:
-- reserve_cells caps a buyer at 3 concurrent open holds (tested below), and
-- reusing Alice there would hit that cap rather than the behaviour under test.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com', now(), '{"name":"Alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com',   now(), '{"name":"Bob"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com', null,  '{"name":"Carol"}'),
  ('44444444-4444-4444-8444-444444444444', 'admin@example.com', now(), '{"name":"Root"}'),
  ('55555555-5555-4555-8555-555555555555', 'dave@example.com',  now(), '{"name":"Dave"}'),
  ('66666666-6666-4666-8666-666666666666', 'erin@example.com',  now(), '{"name":"Erin"}');

do $$
begin
  perform hqtest.check(
    'bootstrap', 'auth.users insert creates a profile',
    (select count(*) from public.profiles) = 6,
    format('profiles=%s', (select count(*) from public.profiles))
  );
  perform hqtest.check(
    'bootstrap', 'email_verified mirrors email_confirmed_at',
    (select email_verified from public.profiles where email = 'alice@example.com')
      and not (select email_verified from public.profiles where email = 'carol@example.com')
  );
  perform hqtest.check(
    'bootstrap', 'display name copied from provider metadata',
    (select display_name from public.profiles where email = 'alice@example.com') = 'Alice'
  );
  perform hqtest.check(
    'bootstrap', 'launch pricing version is active and priced at 10 cents/px',
    (select cents_per_logical_pixel from public.pricing_versions where is_active) = 10
  );
end
$$;

-- grant_admin is intentionally not callable by the application roles; here we
-- call it as the superuser, exactly as an operator would.
select public.grant_admin('admin@example.com');

do $$
begin
  perform hqtest.check(
    'bootstrap', 'grant_admin promotes the account',
    public.is_admin('44444444-4444-4444-8444-444444444444')
  );
  perform hqtest.check(
    'bootstrap', 'grant_admin is not executable by service_role',
    not has_function_privilege('service_role', 'public.grant_admin(text)', 'execute')
  );
  perform hqtest.check(
    'bootstrap', 'grant_admin writes an audit record',
    exists (select 1 from public.audit_logs where action = 'admin.grant')
  );
end
$$;

-- =============================================================================
-- PRICING
-- =============================================================================
do $$
declare
  v_pv uuid := (select id from public.pricing_versions where is_active);
begin
  -- 1 cell = 100 logical px * 10 cents = 1000 cents = $10.00
  perform hqtest.check(
    'pricing', 'one unit costs exactly 1000 cents',
    public.quote_total_cents(v_pv, 0, 0, 1, 1) = 1000,
    format('got %s', public.quote_total_cents(v_pv, 0, 0, 1, 1))
  );
  -- 10x10 cells = 100 cells = 100_000 cents = $1,000.00
  perform hqtest.check(
    'pricing', '10x10 units cost 100000 cents',
    public.quote_total_cents(v_pv, 5, 5, 10, 10) = 100000,
    format('got %s', public.quote_total_cents(v_pv, 5, 5, 10, 10))
  );
  -- Price must not depend on position when there are no zone multipliers.
  perform hqtest.check(
    'pricing', 'flat pricing is position independent',
    public.quote_total_cents(v_pv, 0, 0, 3, 4) = public.quote_total_cents(v_pv, 90, 80, 3, 4)
  );
end
$$;

select hqtest.check_raises(
  'pricing', 'rectangle past the right edge is rejected',
  $q$ select public.quote_total_cents(
        (select id from public.pricing_versions where is_active), 99, 0, 2, 1) $q$,
  'out_of_bounds'
);
select hqtest.check_raises(
  'pricing', 'rectangle past the bottom edge is rejected',
  $q$ select public.quote_total_cents(
        (select id from public.pricing_versions where is_active), 0, 99, 1, 2) $q$,
  'out_of_bounds'
);
select hqtest.check_raises(
  'pricing', 'zero-size rectangle is rejected',
  $q$ select public.quote_total_cents(
        (select id from public.pricing_versions where is_active), 0, 0, 0, 1) $q$,
  'bad_dimensions'
);
select hqtest.check_raises(
  'pricing', 'oversized rectangle is rejected',
  $q$ select public.quote_total_cents(
        (select id from public.pricing_versions where is_active), 0, 0, 60, 60) $q$,
  'too_large'
);

-- Zone multipliers: verify the SQL engine matches the documented integer maths.
do $$
declare
  v_id uuid;
  v_total integer;
begin
  insert into public.pricing_versions (
    version, cents_per_logical_pixel, zone_multipliers, is_active, notes
  ) values (
    999, 10,
    '[{"label":"Center","x":0,"y":0,"w":1,"h":1,"multiplierBp":15000}]'::jsonb,
    false, 'behaviour-check fixture'
  ) returning id into v_id;

  -- 4 cells: one at 1.5x (1500) + three at 1.0x (1000 each) = 4500
  v_total := public.quote_total_cents(v_id, 0, 0, 2, 2);
  perform hqtest.check(
    'pricing', 'zone multiplier applies to matching cells only',
    v_total = 4500, format('got %s, expected 4500', v_total)
  );
end
$$;

-- =============================================================================
-- RESERVATIONS — the anti-double-allocation guarantee
-- =============================================================================
do $$
declare
  v_a jsonb;
  v_b jsonb;
begin
  v_a := public.reserve_cells(
    '11111111-1111-4111-8111-111111111111', 10, 10, 2, 2, 1, 4000, 4000,
    '{"lines":[]}'::jsonb, 'v1', '203.0.113.0/24'
  );
  perform hqtest.check(
    'reserve', 'a valid reservation succeeds',
    (v_a ->> 'ok')::boolean, v_a::text
  );
  perform hqtest.check(
    'reserve', 'four cells are recorded',
    (select count(*) from public.pixel_cells
      where reservation_id = ((v_a -> 'reservation') ->> 'id')::uuid) = 4
  );
  perform hqtest.check(
    'reserve', 'a draft placement is created alongside',
    (select status from public.placements
      where reservation_id = ((v_a -> 'reservation') ->> 'id')::uuid) = 'draft'
  );

  -- Overlapping claim by a different buyer must fail entirely.
  v_b := public.reserve_cells(
    '22222222-2222-4222-8222-222222222222', 11, 11, 2, 2, 1, 4000, 4000,
    '{}'::jsonb, 'v1', null
  );
  perform hqtest.check(
    'reserve', 'an overlapping claim is refused',
    (v_b ->> 'code') = 'cells_unavailable', v_b::text
  );
  -- ...and leaves nothing behind. This is the "no partial reservation" gate.
  perform hqtest.check(
    'reserve', 'the refused claim created no reservation row',
    (select count(*) from public.reservations
      where owner_id = '22222222-2222-4222-8222-222222222222') = 0
  );
  perform hqtest.check(
    'reserve', 'the refused claim created no cells',
    (select count(*) from public.pixel_cells) = 4
  );
  perform hqtest.check(
    'reserve', 'the refused claim created no placement',
    (select count(*) from public.placements
      where owner_id = '22222222-2222-4222-8222-222222222222') = 0
  );

  -- Non-overlapping claim next door must still succeed.
  v_b := public.reserve_cells(
    '22222222-2222-4222-8222-222222222222', 12, 12, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  perform hqtest.check(
    'reserve', 'a non-overlapping neighbour succeeds',
    (v_b ->> 'ok')::boolean, v_b::text
  );
end
$$;

-- Price tampering
do $$
declare
  v jsonb;
begin
  v := public.reserve_cells(
    '11111111-1111-4111-8111-111111111111', 40, 40, 1, 1, 1,
    1, -- buyer claims it costs one cent
    1000, '{}'::jsonb, 'v1', null
  );
  perform hqtest.check(
    'reserve', 'client-supplied total that disagrees is refused',
    (v ->> 'code') = 'quote_changed' and (v ->> 'totalCents')::integer = 1000,
    v::text
  );
  perform hqtest.check(
    'reserve', 'the tampered request reserved nothing',
    (select count(*) from public.pixel_cells where cell_x = 40 and cell_y = 40) = 0
  );
end
$$;

select hqtest.check_raises(
  'reserve', 'a Worker/DB price disagreement aborts loudly',
  $q$ select public.reserve_cells(
        '11111111-1111-4111-8111-111111111111', 41, 41, 1, 1, 1, 1000, 1, '{}'::jsonb, 'v1', null) $q$,
  'quote_engine_disagreement'
);

do $$
declare
  v jsonb;
begin
  -- Unverified email cannot hold inventory.
  v := public.reserve_cells(
    '33333333-3333-4333-8333-333333333333', 50, 50, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  perform hqtest.check(
    'reserve', 'unverified email cannot reserve',
    (v ->> 'code') = 'email_unverified', v::text
  );

  -- Unknown owner.
  v := public.reserve_cells(
    '99999999-9999-4999-8999-999999999999', 51, 51, 1, 1, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  perform hqtest.check(
    'reserve', 'unknown owner cannot reserve',
    (v ->> 'code') = 'owner_not_found', v::text
  );

  -- Inactive pricing version cannot be replayed.
  v := public.reserve_cells(
    '11111111-1111-4111-8111-111111111111', 52, 52, 1, 1, 999, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  perform hqtest.check(
    'reserve', 'an inactive pricing version is refused',
    (v ->> 'code') = 'pricing_version_inactive', v::text
  );

  -- Out of bounds.
  v := public.reserve_cells(
    '11111111-1111-4111-8111-111111111111', 99, 99, 5, 5, 1, 1000, 1000,
    '{}'::jsonb, 'v1', null
  );
  perform hqtest.check(
    'reserve', 'out-of-bounds rectangle is refused',
    (v ->> 'code') = 'invalid_rect', v::text
  );
end
$$;

-- Concurrent-reservation cap per buyer
do $$
declare
  v jsonb;
begin
  -- Alice already holds 2 (10,10 block and the two tamper attempts failed).
  v := public.reserve_cells(
    '11111111-1111-4111-8111-111111111111', 60, 60, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  perform hqtest.check('reserve', 'second open reservation allowed', (v ->> 'ok')::boolean, v::text);

  v := public.reserve_cells(
    '11111111-1111-4111-8111-111111111111', 61, 61, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  perform hqtest.check('reserve', 'third open reservation allowed', (v ->> 'ok')::boolean, v::text);

  v := public.reserve_cells(
    '11111111-1111-4111-8111-111111111111', 62, 62, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  perform hqtest.check(
    'reserve', 'fourth concurrent reservation is refused',
    (v ->> 'code') = 'too_many_open_reservations', v::text
  );
end
$$;

-- =============================================================================
-- IMMUTABILITY AND THE STATE MACHINE
-- =============================================================================
select hqtest.check_raises(
  'invariants', 'reservation total cannot be edited',
  $q$ update public.reservations set quoted_total_cents = 1
      where id = (select id from public.reservations order by created_at limit 1) $q$,
  'reservation_immutable_field_changed'
);
select hqtest.check_raises(
  'invariants', 'reservation geometry cannot be edited',
  $q$ update public.reservations set cell_x = cell_x + 1
      where id = (select id from public.reservations order by created_at limit 1) $q$,
  'reservation_immutable_field_changed'
);
select hqtest.check_raises(
  'invariants', 'reservation owner cannot be transferred',
  $q$ update public.reservations set owner_id = '22222222-2222-4222-8222-222222222222'
      where id = (select id from public.reservations order by created_at limit 1) $q$,
  'reservation_immutable_field_changed'
);
select hqtest.check_raises(
  'invariants', 'reservation hold cannot be extended',
  $q$ update public.reservations set expires_at = now() + interval '30 days'
      where id = (select id from public.reservations order by created_at limit 1) $q$,
  'reservation_expiry_immutable'
);
select hqtest.check_raises(
  'invariants', 'reserved cannot jump straight to active',
  $q$ update public.reservations set state = 'active'
      where id = (select id from public.reservations order by created_at limit 1) $q$,
  'illegal_reservation_transition'
);
select hqtest.check_raises(
  'invariants', 'reserved cannot jump straight to paid_pending_review',
  $q$ update public.reservations set state = 'paid_pending_review'
      where id = (select id from public.reservations order by created_at limit 1) $q$,
  'illegal_reservation_transition'
);
select hqtest.check_raises(
  'invariants', 'placement cannot be moved',
  $q$ update public.placements set cell_x = cell_x + 1
      where id = (select id from public.placements order by created_at limit 1) $q$,
  'placement_immutable_field_changed'
);
select hqtest.check_raises(
  'invariants', 'a cell cannot be placed outside its reservation',
  $q$ update public.pixel_cells set cell_x = 0
      where cell_x = 10 and cell_y = 10 $q$,
  'cell_outside_reservation'
);
select hqtest.check_raises(
  'invariants', 'an incomplete placement cannot be marked active',
  $q$ update public.placements set status = 'active'
      where id = (select id from public.placements order by created_at limit 1) $q$,
  'illegal_placement_activation'
);
select hqtest.check_raises(
  'invariants', 'is_admin cannot be set by an ordinary update',
  $q$ update public.profiles set is_admin = true where email = 'alice@example.com' $q$,
  'privilege_change_not_allowed'
);
select hqtest.check_raises(
  'invariants', 'founding_buyer cannot be self-awarded',
  $q$ update public.profiles set founding_buyer = true where email = 'alice@example.com' $q$,
  'badge_change_not_allowed'
);
select hqtest.check_raises(
  'invariants', 'email cannot be changed through the profile',
  $q$ update public.profiles set email = 'attacker@example.com' where email = 'alice@example.com' $q$,
  'email_change_not_allowed'
);
select hqtest.check_raises(
  'invariants', 'audit log rows cannot be updated',
  $q$ update public.audit_logs set action = 'tampered' $q$,
  'append-only'
);
select hqtest.check_raises(
  'invariants', 'audit log rows cannot be deleted',
  $q$ delete from public.audit_logs $q$,
  'append-only'
);
-- An append-only trigger is FOR EACH ROW, so it never fires on an UPDATE that
-- matches zero rows. Seed a row first, otherwise this check would pass
-- vacuously at this point in the run.
insert into public.moderation_actions (placement_id, actor_kind, decision, reason)
select id, 'system', 'auto_flag', 'seed row for the append-only check'
from public.placements order by created_at limit 1;

do $$
begin
  perform hqtest.check(
    'invariants', 'moderation seed row exists so append-only is really tested',
    (select count(*) from public.moderation_actions) > 0
  );
end
$$;

select hqtest.check_raises(
  'invariants', 'moderation history cannot be rewritten',
  $q$ update public.moderation_actions set reason = 'tampered' $q$,
  'append-only'
);
select hqtest.check_raises(
  'invariants', 'moderation history cannot be deleted',
  $q$ delete from public.moderation_actions $q$,
  'append-only'
);
select hqtest.check_raises(
  'invariants', 'a second pricing version cannot also be active',
  $q$ update public.pricing_versions set is_active = true where version = 999 $q$,
  'pricing_versions_single_active'
);

-- =============================================================================
-- OCCUPANCY BITMAP LAYOUT
-- =============================================================================
-- Pins the exact byte layout that shared/occupancy.ts decodes. If this test and
-- tests/unit/occupancy.test.ts disagree, the wall renders wrong availability.
do $$
declare
  v_map bytea := public.occupancy_bitmap();
  v_index integer;
begin
  perform hqtest.check(
    'occupancy', 'bitmap is exactly 1250 bytes', length(v_map) = 1250,
    format('got %s', length(v_map))
  );

  -- Cell (10,10) is claimed: index = 10*100 + 10 = 1010, byte 126, bit 2.
  v_index := 10 * 100 + 10;
  perform hqtest.check(
    'occupancy', 'a claimed cell sets index y*100+x, LSB-first',
    (get_byte(v_map, v_index / 8) & (1 << (v_index % 8))) <> 0,
    format('byte %s = %s', v_index / 8, get_byte(v_map, v_index / 8))
  );

  -- Cell (0,0) was never claimed.
  perform hqtest.check(
    'occupancy', 'an unclaimed cell stays zero',
    (get_byte(v_map, 0) & 1) = 0
  );

  perform hqtest.check(
    'occupancy', 'set bit count equals claimed cell count',
    (select count(*) from public.pixel_cells) =
      (select sum(length(replace(to_hex_bits.bits, '0', '')))::integer
       from (
         select string_agg(
           lpad(to_hex(get_byte(v_map, g)), 2, '0'), ''
         ) as hexed,
         (select string_agg(
            (case when (get_byte(v_map, gg) & (1 << bb)) <> 0 then '1' else '0' end), ''
          ) from generate_series(0, 1249) gg, generate_series(0, 7) bb) as bits
         from generate_series(0, 1249) g
         limit 1
       ) to_hex_bits)
  );
end
$$;

-- =============================================================================
-- PAYMENT LIFECYCLE
-- =============================================================================
do $$
declare
  v_res_id uuid;
  v_placement_id uuid;
  v jsonb;
  v_first jsonb;
  v_second jsonb;
begin
  -- Fresh, complete reservation ready to pay for.
  v := public.reserve_cells(
    '22222222-2222-4222-8222-222222222222', 70, 70, 2, 1, 1, 2000, 2000,
    '{}'::jsonb, 'v1', null
  );
  v_res_id := ((v -> 'reservation') ->> 'id')::uuid;

  v := public.set_placement_details(
    v_res_id, '22222222-2222-4222-8222-222222222222',
    'Bob Widgets', 'A blue widget on a white background',
    'https://widgets.example.org/launch', 'widgets.example.org',
    'asset_abc123', '/img/asset_abc123', 600, 300, 45000, 'image/png',
    'auto_pass', '[{"check":"magic_bytes","result":"pass","detail":"png"}]'::jsonb
  );
  perform hqtest.check(
    'payment', 'complete details move the reservation to ready_for_checkout',
    (v ->> 'ok')::boolean and (v ->> 'state') = 'ready_for_checkout', v::text
  );
  v_placement_id := (v ->> 'placementId')::uuid;

  -- Amount must come from the reservation.
  perform hqtest.check_raises(
    'payment', 'opening checkout for the wrong amount aborts',
    format(
      $q$ select public.open_checkout(%L, '22222222-2222-4222-8222-222222222222',
            'cs_wrong', 1, now() + interval '31 minutes') $q$, v_res_id),
    'checkout_amount_mismatch'
  );

  -- Session must not outlive the hold.
  perform hqtest.check_raises(
    'payment', 'a Checkout Session cannot outlive the reservation',
    format(
      $q$ select public.open_checkout(%L, '22222222-2222-4222-8222-222222222222',
            'cs_late', 2000, now() + interval '10 days') $q$, v_res_id),
    'checkout_expiry_after_reservation'
  );

  v_first := public.open_checkout(
    v_res_id, '22222222-2222-4222-8222-222222222222', 'cs_test_001', 2000,
    now() + interval '31 minutes'
  );
  perform hqtest.check(
    'payment', 'opening checkout succeeds', (v_first ->> 'ok')::boolean, v_first::text
  );
  perform hqtest.check(
    'payment', 'reservation is now checkout_created',
    (select state from public.reservations where id = v_res_id) = 'checkout_created'
  );

  -- Double-click: a second session for the same reservation is refused.
  v_second := public.open_checkout(
    v_res_id, '22222222-2222-4222-8222-222222222222', 'cs_test_002', 2000,
    now() + interval '31 minutes'
  );
  perform hqtest.check(
    'payment', 'a second concurrent Checkout Session is refused',
    (v_second ->> 'code') = 'checkout_already_open'
      and (v_second ->> 'existingSessionId') = 'cs_test_001',
    v_second::text
  );
  perform hqtest.check(
    'payment', 'only one payment row exists for the reservation',
    (select count(*) from public.payments where reservation_id = v_res_id) = 1
  );

  -- Amount tampering at the webhook.
  v := public.settle_payment(v_res_id, 'cs_test_001', 1, 'usd', 'pi_1', 'ch_1', 'cus_1', true);
  perform hqtest.check(
    'payment', 'settling with the wrong amount is refused',
    (v ->> 'code') = 'amount_mismatch', v::text
  );
  -- Currency tampering.
  v := public.settle_payment(v_res_id, 'cs_test_001', 2000, 'eur', 'pi_1', 'ch_1', 'cus_1', true);
  perform hqtest.check(
    'payment', 'settling in the wrong currency is refused',
    (v ->> 'code') = 'currency_mismatch', v::text
  );
  -- Session belonging to a different reservation.
  v := public.settle_payment(
    (select id from public.reservations where cell_x = 10 and cell_y = 10),
    'cs_test_001', 2000, 'usd', 'pi_1', 'ch_1', 'cus_1', true
  );
  perform hqtest.check(
    'payment', 'a session cannot be applied to another reservation',
    (v ->> 'code') = 'reservation_session_mismatch', v::text
  );
  -- Unknown session must not manufacture a payment.
  v := public.settle_payment(v_res_id, 'cs_forged', 2000, 'usd', 'pi_x', 'ch_x', null, true);
  perform hqtest.check(
    'payment', 'an unknown session id cannot create a fulfilment',
    (v ->> 'code') = 'payment_not_found', v::text
  );
  perform hqtest.check(
    'payment', 'placement is still unpublished after the forged attempts',
    (select status from public.placements where id = v_placement_id) = 'draft'
  );

  -- The real thing.
  v := public.settle_payment(v_res_id, 'cs_test_001', 2000, 'usd', 'pi_1', 'ch_1', 'cus_1', true);
  perform hqtest.check(
    'payment', 'a correct settlement succeeds',
    (v ->> 'ok')::boolean and not (v ->> 'alreadySettled')::boolean, v::text
  );
  perform hqtest.check(
    'payment', 'reservation moves to paid_pending_review',
    (select state from public.reservations where id = v_res_id) = 'paid_pending_review'
  );
  perform hqtest.check(
    'payment', 'placement moves to pending_review, not active',
    (select status from public.placements where id = v_placement_id) = 'pending_review'
  );
  perform hqtest.check(
    'payment', 'founding-buyer badge is awarded from the payment ledger',
    (select founding_buyer from public.profiles where id = '22222222-2222-4222-8222-222222222222')
  );

  -- Duplicate webhook delivery.
  v := public.settle_payment(v_res_id, 'cs_test_001', 2000, 'usd', 'pi_1', 'ch_1', 'cus_1', true);
  perform hqtest.check(
    'payment', 'a duplicate settlement is idempotent',
    (v ->> 'ok')::boolean and (v ->> 'alreadySettled')::boolean, v::text
  );
  perform hqtest.check(
    'payment', 'still exactly one payment row',
    (select count(*) from public.payments where reservation_id = v_res_id) = 1
  );
  perform hqtest.check(
    'payment', 'payment is settled exactly once',
    (select count(*) from public.payments
      where reservation_id = v_res_id and status = 'succeeded') = 1
  );

  -- A late "expired" event must not undo a settled payment.
  v := public.expire_checkout('cs_test_001');
  perform hqtest.check(
    'payment', 'a late session-expired event is ignored after settlement',
    (v ->> 'ignored') = 'not_open', v::text
  );
  perform hqtest.check(
    'payment', 'settled payment survives the late expiry event',
    (select status from public.payments where reservation_id = v_res_id) = 'succeeded'
  );

  -- A late failure event must not undo it either.
  v := public.fail_payment('cs_test_001', 'card_declined', true);
  perform hqtest.check(
    'payment', 'a late failure event is ignored after settlement',
    (v ->> 'ignored') = 'already_settled', v::text
  );

  -- The sweeper must never release paid cells, even long past expiry.
  perform set_config('hqpixels.allow_privilege_change', 'off', true);
  v := public.expire_reservations(0, 100);
  perform hqtest.check(
    'payment', 'expiry sweep never releases a paid reservation',
    (select count(*) from public.pixel_cells where reservation_id = v_res_id) = 2,
    v::text
  );

  -- Approval publishes it.
  v := public.approve_placement(v_placement_id, '44444444-4444-4444-8444-444444444444', 'looks fine');
  perform hqtest.check(
    'payment', 'admin approval publishes the placement', (v ->> 'ok')::boolean, v::text
  );
  perform hqtest.check(
    'payment', 'placement is now active',
    (select status from public.placements where id = v_placement_id) = 'active'
  );
  perform hqtest.check(
    'payment', 'reservation is now active',
    (select state from public.reservations where id = v_res_id) = 'active'
  );
  perform hqtest.check(
    'payment', 'approval bumped the manifest version',
    (select manifest_version from public.wall_state where id) > 1
  );
end
$$;

-- Approval without settled payment must be impossible.
do $$
declare
  v jsonb;
  v_placement_id uuid;
begin
  select p.id into v_placement_id
  from public.placements p
  join public.reservations r on r.id = p.reservation_id
  where p.status = 'draft' and r.cell_x = 10
  limit 1;

  v := public.approve_placement(v_placement_id, '44444444-4444-4444-8444-444444444444', 'sneaky');
  perform hqtest.check(
    'payment', 'approving an unpaid placement is refused',
    (v ->> 'code') = 'payment_not_settled', v::text
  );
end
$$;

-- Non-admin cannot approve, even calling the function directly.
select hqtest.check_raises(
  'authz', 'a non-admin cannot approve a placement',
  $q$ select public.approve_placement(
        (select id from public.placements where status = 'active' limit 1),
        '11111111-1111-4111-8111-111111111111', 'nope') $q$,
  'admin_required'
);
select hqtest.check_raises(
  'authz', 'a null actor cannot approve a placement',
  $q$ select public.approve_placement(
        (select id from public.placements where status = 'active' limit 1), null, 'nope') $q$,
  'admin_required'
);
select hqtest.check_raises(
  'authz', 'a non-admin cannot bulk-disable by host',
  $q$ select public.disable_placements_by_host(
        'widgets.example.org', '11111111-1111-4111-8111-111111111111', 'nope') $q$,
  'admin_required'
);
select hqtest.check_raises(
  'authz', 'a non-admin cannot read the moderation queue',
  $q$ select public.admin_moderation_queue('11111111-1111-4111-8111-111111111111') $q$,
  'admin_required'
);

-- =============================================================================
-- IDEMPOTENCY LEDGER
-- =============================================================================
do $$
declare
  v1 jsonb;
  v2 jsonb;
begin
  v1 := public.record_stripe_event(
    'evt_1', 'checkout.session.completed', '2026-08-01', now(),
    repeat('a', 64), false
  );
  perform hqtest.check('webhook', 'a new event is reported as new', (v1 ->> 'isNew')::boolean, v1::text);

  v2 := public.record_stripe_event(
    'evt_1', 'checkout.session.completed', '2026-08-01', now(),
    repeat('a', 64), false
  );
  perform hqtest.check(
    'webhook', 'a replayed event is reported as not new',
    not (v2 ->> 'isNew')::boolean and (v2 ->> 'attempts')::integer = 2, v2::text
  );
  perform hqtest.check(
    'webhook', 'only one ledger row exists for the event',
    (select count(*) from public.stripe_events where id = 'evt_1') = 1
  );
end
$$;

-- =============================================================================
-- REFUND AND DISPUTE RELEASE CELLS
-- =============================================================================
do $$
declare
  v jsonb;
  v_res_id uuid;
  v_placement_id uuid;
begin
  v := public.reserve_cells(
    '55555555-5555-4555-8555-555555555555', 80, 80, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  perform hqtest.check('refund', 'refund fixture reserves', (v ->> 'ok')::boolean, v::text);
  v_res_id := ((v -> 'reservation') ->> 'id')::uuid;

  v := public.set_placement_details(
    v_res_id, '55555555-5555-4555-8555-555555555555',
    'Refund Me', 'Placeholder art', 'https://refund.example.net/', 'refund.example.net',
    'asset_ref', '/img/asset_ref', 100, 100, 1000, 'image/webp', 'auto_pass', '[]'::jsonb);
  perform hqtest.check('refund', 'refund fixture details set', (v ->> 'ok')::boolean, v::text);
  v_placement_id := (v ->> 'placementId')::uuid;

  perform public.open_checkout(
    v_res_id, '55555555-5555-4555-8555-555555555555', 'cs_refund', 1000,
    now() + interval '31 minutes');
  perform public.settle_payment(v_res_id, 'cs_refund', 1000, 'usd', 'pi_ref', 'ch_ref', null, true);
  perform public.approve_placement(v_placement_id, '44444444-4444-4444-8444-444444444444', 'ok');

  perform hqtest.check(
    'refund', 'placement is live before the refund',
    (select status from public.placements where id = v_placement_id) = 'active'
  );

  -- Partial refund keeps it live.
  v := public.record_refund('ch_ref', 400, 'goodwill');
  perform hqtest.check(
    'refund', 'a partial refund does not take the placement down',
    not (v -> 'full')::boolean
      and (select status from public.placements where id = v_placement_id) = 'active',
    v::text
  );
  -- Replaying the same cumulative amount is a no-op.
  v := public.record_refund('ch_ref', 400, 'goodwill');
  perform hqtest.check(
    'refund', 'replaying a refund event is a no-op', (v ->> 'ignored') = 'no_increase', v::text
  );

  -- Full refund releases the cells.
  v := public.record_refund('ch_ref', 1000, 'policy breach');
  perform hqtest.check(
    'refund', 'a full refund releases the cells',
    (select count(*) from public.pixel_cells where reservation_id = v_res_id) = 0, v::text
  );
  perform hqtest.check(
    'refund', 'a full refund takes the placement off the wall',
    (select status from public.placements where id = v_placement_id) = 'rejected'
  );
  perform hqtest.check(
    'refund', 'the reservation reaches rejected_refunded',
    (select state from public.reservations where id = v_res_id) = 'rejected_refunded'
  );
end
$$;

do $$
declare
  v jsonb;
  v_res_id uuid;
  v_placement_id uuid;
begin
  v := public.reserve_cells(
    '66666666-6666-4666-8666-666666666666', 81, 81, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null);
  perform hqtest.check('dispute', 'dispute fixture reserves', (v ->> 'ok')::boolean, v::text);
  v_res_id := ((v -> 'reservation') ->> 'id')::uuid;
  v := public.set_placement_details(
    v_res_id, '66666666-6666-4666-8666-666666666666',
    'Dispute Me', 'Placeholder art', 'https://dispute.example.net/', 'dispute.example.net',
    'asset_dis', '/img/asset_dis', 100, 100, 1000, 'image/jpeg', 'auto_pass', '[]'::jsonb);
  perform hqtest.check('dispute', 'dispute fixture details set', (v ->> 'ok')::boolean, v::text);
  v_placement_id := (v ->> 'placementId')::uuid;

  perform public.open_checkout(
    v_res_id, '66666666-6666-4666-8666-666666666666', 'cs_dispute', 1000,
    now() + interval '31 minutes');
  perform public.settle_payment(v_res_id, 'cs_dispute', 1000, 'usd', 'pi_dis', 'ch_dis', null, true);
  perform public.approve_placement(v_placement_id, '44444444-4444-4444-8444-444444444444', 'ok');

  v := public.record_dispute('ch_dis', 'needs_response', false);
  perform hqtest.check(
    'dispute', 'a chargeback removes the placement from the wall',
    (select status from public.placements where id = v_placement_id) = 'chargeback_disabled', v::text
  );
  perform hqtest.check(
    'dispute', 'a chargeback releases the cells',
    (select count(*) from public.pixel_cells where reservation_id = v_res_id) = 0
  );
  perform hqtest.check(
    'dispute', 'the payment is marked disputed',
    (select status from public.payments where reservation_id = v_res_id) = 'disputed'
  );
end
$$;

-- =============================================================================
-- EXPIRY
-- =============================================================================
do $$
declare
  v jsonb;
  v_res_id uuid;
  v_before integer;
begin
  -- Dave's earlier hold was released by the full refund above, so he is back to
  -- zero open reservations and the concurrent-hold cap is not in play here.
  v := public.reserve_cells(
    '55555555-5555-4555-8555-555555555555', 90, 90, 2, 2, 1, 4000, 4000, '{}'::jsonb, 'v1', null);
  perform hqtest.check('expiry', 'expiry fixture reserves', (v ->> 'ok')::boolean, v::text);
  v_res_id := ((v -> 'reservation') ->> 'id')::uuid;

  -- Fast-forward by editing expires_at directly. This is the ONE place the test
  -- has to bypass the immutability trigger, so it opts in explicitly.
  alter table public.reservations disable trigger reservations_enforce_update;
  update public.reservations set expires_at = now() - interval '10 minutes' where id = v_res_id;
  alter table public.reservations enable trigger reservations_enforce_update;

  select count(*) into v_before from public.pixel_cells where reservation_id = v_res_id;
  perform hqtest.check('expiry', 'cells held before the sweep', v_before = 4);

  v := public.expire_reservations(0, 100);
  perform hqtest.check(
    'expiry', 'the sweep releases an expired unpaid hold',
    (select count(*) from public.pixel_cells where reservation_id = v_res_id) = 0, v::text
  );
  perform hqtest.check(
    'expiry', 'the reservation is marked expired',
    (select state from public.reservations where id = v_res_id) = 'expired'
  );
  perform hqtest.check(
    'expiry', 'the sweep is safe to run twice',
    ((public.expire_reservations(0, 100)) ->> 'ok')::boolean
  );
  perform hqtest.check(
    'expiry', 'the freed cells can be claimed by someone else',
    ((public.reserve_cells(
      '22222222-2222-4222-8222-222222222222', 90, 90, 1, 1, 1, 1000, 1000, '{}'::jsonb, 'v1', null
    )) ->> 'ok')::boolean
  );
end
$$;

-- =============================================================================
-- READ PATHS
-- =============================================================================
do $$
declare
  v jsonb;
begin
  v := public.build_wall_manifest();
  perform hqtest.check(
    'manifest', 'manifest contains only active placements',
    jsonb_array_length(v -> 'placements') =
      (select count(*) from public.placements where status = 'active'),
    v::text
  );
  perform hqtest.check(
    'manifest', 'manifest never exposes a full destination URL',
    v::text not like '%https://widgets.example.org/launch%'
  );
  perform hqtest.check(
    'manifest', 'manifest exposes the destination hostname',
    v::text like '%widgets.example.org%'
  );
  perform hqtest.check(
    'manifest', 'manifest never exposes a buyer email',
    v::text not like '%@example.com%'
  );
  perform hqtest.check(
    'manifest', 'occupancy bitmap is present and base64 without newlines',
    (v ->> 'occupancyBitmap') is not null
      and position(chr(10) in (v ->> 'occupancyBitmap')) = 0
  );

  v := public.build_redirect_map();
  perform hqtest.check(
    'manifest', 'redirect map holds full URLs for active placements',
    v::text like '%https://widgets.example.org/launch%'
  );

  v := public.public_stats_payload();
  perform hqtest.check(
    'stats', 'stats reports claimed cells consistently',
    (v -> 'inventory' ->> 'claimedCells')::integer = (select count(*) from public.pixel_cells),
    v::text
  );
  perform hqtest.check(
    'stats', 'stats never exposes an email',
    v::text not like '%@example.com%'
  );
  perform hqtest.check(
    'stats', 'available + claimed = 10000',
    (v -> 'inventory' ->> 'claimedCells')::integer
      + (v -> 'inventory' ->> 'availableCells')::integer = 10000
  );

  v := public.buyer_dashboard('22222222-2222-4222-8222-222222222222');
  perform hqtest.check(
    'dashboard', 'dashboard returns only the caller placements',
    (select count(*) from jsonb_array_elements(v -> 'placements')) =
      (select count(*) from public.placements
        where owner_id = '22222222-2222-4222-8222-222222222222'),
    v::text
  );
  perform hqtest.check(
    'dashboard', 'dashboard reports lifetime spend net of refunds',
    (v -> 'totals' ->> 'lifetimeSpendCents')::integer = 2000, v::text
  );

  -- reservation_status must be read-only. STABLE volatility is what structurally
  -- prevents the success page from causing a write.
  perform hqtest.check(
    'success-page', 'reservation_status is declared STABLE (cannot write)',
    (select provolatile from pg_proc where proname = 'reservation_status') = 's'
  );
  perform hqtest.check(
    'success-page', 'reservation_detail is declared STABLE (cannot write)',
    (select provolatile from pg_proc where proname = 'reservation_detail') = 's'
  );
  perform hqtest.check(
    'success-page', 'buyer_dashboard is declared STABLE (cannot write)',
    (select provolatile from pg_proc where proname = 'buyer_dashboard') = 's'
  );

  -- IDOR: another buyer's reservation is "not found", not "forbidden".
  v := public.reservation_status(
    (select id from public.reservations where owner_id = '22222222-2222-4222-8222-222222222222' limit 1),
    '11111111-1111-4111-8111-111111111111'
  );
  perform hqtest.check(
    'authz', 'reservation_status hides another buyer reservation',
    (v ->> 'code') = 'not_found', v::text
  );
  v := public.reservation_detail(
    (select id from public.reservations where owner_id = '22222222-2222-4222-8222-222222222222' limit 1),
    '11111111-1111-4111-8111-111111111111'
  );
  perform hqtest.check(
    'authz', 'reservation_detail hides another buyer reservation',
    (v ->> 'code') = 'not_found', v::text
  );
  v := public.set_placement_details(
    (select id from public.reservations where owner_id = '22222222-2222-4222-8222-222222222222' limit 1),
    '11111111-1111-4111-8111-111111111111',
    'Hijacked', 'nope', 'https://evil.example.net/', 'evil.example.net',
    null, null, null, null, null, null, 'auto_pass', '[]'::jsonb
  );
  perform hqtest.check(
    'authz', 'another buyer cannot edit a placement they do not own',
    (v ->> 'code') = 'not_found', v::text
  );
end
$$;

-- =============================================================================
-- ANALYTICS
-- =============================================================================
do $$
declare
  v jsonb;
  v_before bigint;
  v_pid uuid := (select id from public.placements where status = 'active' limit 1);
begin
  select total_page_views into v_before from public.wall_state where id;

  v := public.ingest_view_aggregates(format(
    '[{"bucketStart":"%s","surface":"wall","views":10,"filtered":2},
      {"bucketStart":"%s","surface":"home","views":5,"filtered":0}]',
    now()::text, now()::text
  )::jsonb);
  perform hqtest.check('analytics', 'view batch ingests', (v ->> 'ok')::boolean, v::text);
  perform hqtest.check(
    'analytics', 'public total page views is monotonic and additive',
    (select total_page_views from public.wall_state where id) = v_before + 15
  );

  -- Unaligned timestamps must land on the same 5 minute bucket, not create a
  -- second overlapping one.
  perform public.ingest_view_aggregates(format(
    '[{"bucketStart":"%s","surface":"wall","views":1,"filtered":0}]',
    (public.analytics_bucket(now()) + interval '2 minutes 37 seconds')::text
  )::jsonb);
  perform hqtest.check(
    'analytics', 'unaligned timestamps collapse onto one bucket',
    (select count(*) from public.view_aggregates
      where surface = 'wall' and bucket_start = public.analytics_bucket(now())) = 1
  );

  v := public.ingest_click_aggregates(format(
    '[{"bucketStart":"%s","placementId":"%s","clicks":7,"filtered":3,"distinctVisitors":5}]',
    now()::text, v_pid::text
  )::jsonb);
  perform hqtest.check('analytics', 'click batch ingests', (v ->> 'rows')::integer = 1, v::text);

  v := public.ingest_click_aggregates(format(
    '[{"bucketStart":"%s","placementId":"%s","clicks":1,"filtered":0,"distinctVisitors":1}]',
    now()::text, '00000000-0000-4000-8000-000000000000'
  )::jsonb);
  perform hqtest.check(
    'analytics', 'clicks for an unknown placement are skipped, not fatal',
    (v ->> 'ok')::boolean and (v ->> 'rows')::integer = 0, v::text
  );

  v := public.rebuild_leaderboards();
  perform hqtest.check('rankings', 'leaderboards rebuild', (v ->> 'boards')::integer = 4, v::text);

  v := public.latest_leaderboards();
  perform hqtest.check(
    'rankings', 'four boards are published',
    jsonb_array_length(v -> 'boards') = 4, v::text
  );
  perform hqtest.check(
    'rankings', 'every board states its methodology',
    not exists (
      select 1 from jsonb_array_elements(v -> 'boards') b
      where coalesce(b -> 'payload' ->> 'methodology', '') = ''
    )
  );
  -- Dave's payment was refunded in full (net 0) and Erin's was charged back, so
  -- neither may appear. Bob's settled payment must.
  perform hqtest.check(
    'rankings', 'fully refunded spend is excluded from top supporters',
    not exists (
      select 1
      from jsonb_array_elements(v -> 'boards') b,
           jsonb_array_elements(b -> 'payload' -> 'entries') e
      where b ->> 'kind' = 'top_supporters' and (e ->> 'label') = 'Dave'
    )
  );
  perform hqtest.check(
    'rankings', 'disputed spend is excluded from top supporters',
    not exists (
      select 1
      from jsonb_array_elements(v -> 'boards') b,
           jsonb_array_elements(b -> 'payload' -> 'entries') e
      where b ->> 'kind' = 'top_supporters' and (e ->> 'label') = 'Erin'
    )
  );
  perform hqtest.check(
    'rankings', 'a settled purchaser does appear in top supporters',
    exists (
      select 1
      from jsonb_array_elements(v -> 'boards') b,
           jsonb_array_elements(b -> 'payload' -> 'entries') e
      where b ->> 'kind' = 'top_supporters' and (e ->> 'label') = 'Bob'
    )
  );

  v := public.purge_expired_privacy_data();
  perform hqtest.check('privacy', 'privacy purge runs', (v ->> 'ok')::boolean, v::text);
end
$$;

-- =============================================================================
-- RLS
-- =============================================================================
-- Exercised as the real anon/authenticated roles, with a simulated JWT.
do $$
begin
  perform hqtest.check(
    'rls', 'RLS is enabled on every application table',
    not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
        and c.relname not in ('results')
    ),
    (select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity)
  );
  perform hqtest.check(
    'rls', 'anon has no privilege on reservations',
    not has_table_privilege('anon', 'public.reservations', 'select')
  );
  perform hqtest.check(
    'rls', 'anon has no privilege on payments',
    not has_table_privilege('anon', 'public.payments', 'select')
  );
  perform hqtest.check(
    'rls', 'anon has no privilege on audit_logs',
    not has_table_privilege('anon', 'public.audit_logs', 'select')
  );
  perform hqtest.check(
    'rls', 'anon cannot read destination_url even on placements',
    not has_column_privilege('anon', 'public.placements', 'destination_url', 'select')
  );
  perform hqtest.check(
    'rls', 'anon can read destination_host on placements',
    has_column_privilege('anon', 'public.placements', 'destination_host', 'select')
  );
  perform hqtest.check(
    'rls', 'anon cannot insert into any application table',
    not has_table_privilege('anon', 'public.placements', 'insert')
      and not has_table_privilege('anon', 'public.reservations', 'insert')
      and not has_table_privilege('anon', 'public.pixel_cells', 'insert')
  );
  perform hqtest.check(
    'rls', 'authenticated cannot update is_admin',
    not has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'update')
  );
  perform hqtest.check(
    'rls', 'authenticated can update display_name',
    has_column_privilege('authenticated', 'public.profiles', 'display_name', 'update')
  );
  perform hqtest.check(
    'rls', 'authenticated cannot write placements directly',
    not has_table_privilege('authenticated', 'public.placements', 'update')
      and not has_table_privilege('authenticated', 'public.placements', 'insert')
  );
  perform hqtest.check(
    'rls', 'anon cannot execute reserve_cells',
    not has_function_privilege(
      'anon',
      'public.reserve_cells(uuid,integer,integer,integer,integer,integer,integer,integer,jsonb,text,text)',
      'execute'
    )
  );
  perform hqtest.check(
    'rls', 'authenticated cannot execute reserve_cells',
    not has_function_privilege(
      'authenticated',
      'public.reserve_cells(uuid,integer,integer,integer,integer,integer,integer,integer,jsonb,text,text)',
      'execute'
    )
  );
  perform hqtest.check(
    'rls', 'authenticated cannot execute settle_payment',
    not has_function_privilege(
      'authenticated',
      'public.settle_payment(uuid,text,integer,text,text,text,text,boolean)',
      'execute'
    )
  );
  -- PostgreSQL stores `set search_path = ''` in pg_proc.proconfig as the string
  -- `search_path=""` (quoted empty value), so the assertion must accept either
  -- spelling rather than an exact match on `search_path=`.
  perform hqtest.check(
    'rls', 'every SECURITY DEFINER function pins an empty search_path',
    not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
          where cfg in ('search_path=', 'search_path=""', 'search_path='''''  )
        )
    ),
    (select string_agg(p.proname || '=' || coalesce(array_to_string(p.proconfig, '|'), 'NULL'), ', ')
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
          where cfg in ('search_path=', 'search_path=""', 'search_path='''''  )
        ))
  );
end
$$;

-- Actual policy behaviour, as the roles themselves.
do $$
declare
  v_count integer;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true
  );

  select count(*) into v_count from public.reservations;
  perform hqtest.check(
    'rls', 'a signed-in buyer sees only their own reservations',
    v_count = (select count(*) from public.reservations r
               where r.owner_id = '11111111-1111-4111-8111-111111111111'),
    format('saw %s rows', v_count)
  );

  select count(*) into v_count from public.payments;
  perform hqtest.check(
    'rls', 'a signed-in buyer sees only their own payments',
    v_count = (select count(*) from public.payments p
               where p.owner_id = '11111111-1111-4111-8111-111111111111'),
    format('saw %s rows', v_count)
  );

  select count(*) into v_count from public.audit_logs;
  perform hqtest.check('rls', 'a non-admin sees no audit log rows', v_count = 0);

  reset role;
exception
  when others then
    reset role;
    perform hqtest.check('rls', 'authenticated policy probe', false, sqlerrm);
end
$$;

do $$
declare
  v_count integer;
begin
  set local role anon;
  perform set_config('request.jwt.claims', '', true);

  select count(*) into v_count from public.placements;
  perform hqtest.check(
    'rls', 'anon sees only active placements',
    v_count = (select count(*) from public.placements where status = 'active'),
    format('saw %s rows', v_count)
  );

  reset role;
exception
  when others then
    reset role;
    perform hqtest.check('rls', 'anon policy probe', false, sqlerrm);
end
$$;

-- =============================================================================
-- Report
-- =============================================================================
select suite,
       count(*) filter (where ok) as passed,
       count(*) filter (where not ok) as failed
from hqtest.results
group by suite
order by suite;

select name, coalesce(detail, '') as detail
from hqtest.results
where not ok
order by id;

do $$
declare
  v_failed integer;
  v_total integer;
begin
  select count(*) filter (where not ok), count(*) into v_failed, v_total from hqtest.results;
  raise notice 'HQPixels behaviour checks: % passed, % failed (of %)',
    v_total - v_failed, v_failed, v_total;
  if v_failed > 0 then
    raise exception '% behaviour check(s) failed', v_failed;
  end if;
end
$$;
