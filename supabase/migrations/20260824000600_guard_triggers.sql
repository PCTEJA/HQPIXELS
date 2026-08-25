-- =============================================================================
-- HQPixels 0006 — invariant guards
-- =============================================================================
-- These triggers enforce rules that must hold even when the caller is the
-- service role. RLS can be bypassed by a privileged connection; triggers
-- cannot. Anything that would be catastrophic if application code had a bug
-- lives here.

-- -----------------------------------------------------------------------------
-- Reservation state machine + immutable fields
-- -----------------------------------------------------------------------------
create or replace function public.tg_enforce_reservation_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Money, geometry, ownership and pricing basis are immutable for the life of
  -- the reservation. This is what makes "the quoted total cannot change after
  -- reservation" a database guarantee.
  if new.owner_id <> old.owner_id
     or new.pricing_version_id <> old.pricing_version_id
     or new.cell_x <> old.cell_x
     or new.cell_y <> old.cell_y
     or new.cell_w <> old.cell_w
     or new.cell_h <> old.cell_h
     or new.cell_count <> old.cell_count
     or new.logical_pixel_count <> old.logical_pixel_count
     or new.quoted_total_cents <> old.quoted_total_cents
     or new.currency <> old.currency
     or new.created_at <> old.created_at
  then
    raise exception
      'reservation_immutable_field_changed'
      using errcode = 'check_violation',
            detail = 'owner, pricing version, geometry, total and currency are immutable';
  end if;

  -- The hold may only ever be extended by the pricing TTL rules, never
  -- shortened or lengthened arbitrarily by application code.
  if new.expires_at <> old.expires_at then
    raise exception
      'reservation_expiry_immutable'
      using errcode = 'check_violation',
            detail = 'reservation expiry is set once, at creation';
  end if;

  -- checkout_attempt is monotonic. It feeds the Stripe idempotency key, so
  -- going backwards could let a retry reuse a key that Stripe already
  -- associated with a different amount.
  if new.checkout_attempt < old.checkout_attempt then
    raise exception 'checkout_attempt_must_increase' using errcode = 'check_violation';
  end if;

  if new.state <> old.state then
    if not exists (
      select 1 from public.reservation_transitions t
      where t.from_state = old.state and t.to_state = new.state
    ) then
      raise exception
        'illegal_reservation_transition'
        using errcode = 'check_violation',
              detail = format('%s -> %s is not an allowed transition', old.state, new.state);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists reservations_enforce_update on public.reservations;
create trigger reservations_enforce_update
  before update on public.reservations
  for each row execute function public.tg_enforce_reservation_update();

-- -----------------------------------------------------------------------------
-- Placements: geometry and ownership are immutable
-- -----------------------------------------------------------------------------
-- A buyer may change artwork, title, alt text and destination. They may never
-- move or resize their plot, or transfer it. (There is no resale marketplace in
-- the MVP, and this trigger is why adding one later must be a deliberate,
-- reviewed schema change rather than an accident.)
create or replace function public.tg_enforce_placement_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.reservation_id <> old.reservation_id
     or new.owner_id <> old.owner_id
     or new.cell_x <> old.cell_x
     or new.cell_y <> old.cell_y
     or new.cell_w <> old.cell_w
     or new.cell_h <> old.cell_h
  then
    raise exception
      'placement_immutable_field_changed'
      using errcode = 'check_violation',
            detail = 'placement position, size, owner and reservation are immutable';
  end if;

  -- Going live must always stamp activated_at, and going live from nowhere is
  -- not allowed: the only legal predecessors are pending_review (first
  -- approval) and disabled (re-enable).
  if new.status = 'active' and old.status <> 'active' then
    if old.status not in ('pending_review', 'disabled') then
      raise exception
        'illegal_placement_activation'
        using errcode = 'check_violation',
              detail = format('cannot activate from %s', old.status);
    end if;
    new.activated_at := coalesce(new.activated_at, now());
  end if;

  if new.status in ('disabled', 'chargeback_disabled') and old.status <> new.status then
    new.disabled_at := coalesce(new.disabled_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists placements_enforce_update on public.placements;
create trigger placements_enforce_update
  before update on public.placements
  for each row execute function public.tg_enforce_placement_update();

-- Placement geometry must always equal its reservation's geometry.
create or replace function public.tg_placement_geometry_matches_reservation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_x integer; v_y integer; v_w integer; v_h integer; v_owner uuid;
begin
  select r.cell_x, r.cell_y, r.cell_w, r.cell_h, r.owner_id
    into v_x, v_y, v_w, v_h, v_owner
  from public.reservations r
  where r.id = new.reservation_id;

  if v_x is null then
    raise exception 'reservation_not_found' using errcode = 'foreign_key_violation';
  end if;

  if new.cell_x <> v_x or new.cell_y <> v_y or new.cell_w <> v_w or new.cell_h <> v_h then
    raise exception
      'placement_geometry_mismatch'
      using errcode = 'check_violation',
            detail = 'placement rectangle must equal its reservation rectangle';
  end if;

  if new.owner_id <> v_owner then
    raise exception
      'placement_owner_mismatch'
      using errcode = 'check_violation',
            detail = 'placement owner must equal reservation owner';
  end if;

  return new;
end;
$$;

drop trigger if exists placements_geometry_matches_reservation on public.placements;
create trigger placements_geometry_matches_reservation
  before insert on public.placements
  for each row execute function public.tg_placement_geometry_matches_reservation();

-- -----------------------------------------------------------------------------
-- Cells must belong to their reservation's rectangle and owner
-- -----------------------------------------------------------------------------
create or replace function public.tg_pixel_cell_matches_reservation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_x integer; v_y integer; v_w integer; v_h integer; v_owner uuid;
begin
  select r.cell_x, r.cell_y, r.cell_w, r.cell_h, r.owner_id
    into v_x, v_y, v_w, v_h, v_owner
  from public.reservations r
  where r.id = new.reservation_id;

  if v_x is null then
    raise exception 'reservation_not_found' using errcode = 'foreign_key_violation';
  end if;

  if new.cell_x < v_x or new.cell_x >= v_x + v_w
     or new.cell_y < v_y or new.cell_y >= v_y + v_h
  then
    raise exception
      'cell_outside_reservation'
      using errcode = 'check_violation',
            detail = 'a claimed cell must lie inside its reservation rectangle';
  end if;

  if new.owner_id <> v_owner then
    raise exception 'cell_owner_mismatch' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists pixel_cells_match_reservation on public.pixel_cells;
create trigger pixel_cells_match_reservation
  before insert or update on public.pixel_cells
  for each row execute function public.tg_pixel_cell_matches_reservation();

-- -----------------------------------------------------------------------------
-- Privilege escalation guard on profiles
-- -----------------------------------------------------------------------------
-- is_admin, founding_buyer, buyer_ordinal and email are not application-writable.
-- Changing them requires explicitly opting in for the current transaction:
--
--   set local hqpixels.allow_privilege_change = 'on';
--
-- The Worker never sets that flag. Granting admin is a deliberate, auditable
-- SQL operation performed by the operator (README -> "Creating the first
-- admin"), and the founding-buyer/ordinal fields are only written by
-- settle_payment(), which sets the flag itself.
create or replace function public.tg_protect_profile_privileges()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_allowed boolean := coalesce(
    nullif(current_setting('hqpixels.allow_privilege_change', true), '') = 'on',
    false
  );
begin
  if v_allowed then
    return new;
  end if;

  if new.is_admin is distinct from old.is_admin then
    raise exception
      'privilege_change_not_allowed'
      using errcode = 'insufficient_privilege',
            detail = 'is_admin requires an explicit privileged transaction';
  end if;

  if new.founding_buyer is distinct from old.founding_buyer
     or new.buyer_ordinal is distinct from old.buyer_ordinal
  then
    raise exception
      'badge_change_not_allowed'
      using errcode = 'insufficient_privilege',
            detail = 'founding-buyer status is derived from settled payments only';
  end if;

  -- Email comes from the identity provider, never from a form.
  if lower(new.email) is distinct from lower(old.email) then
    raise exception
      'email_change_not_allowed'
      using errcode = 'insufficient_privilege',
            detail = 'email is synced from auth.users';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_protect_privileges on public.profiles;
create trigger profiles_protect_privileges
  before update on public.profiles
  for each row execute function public.tg_protect_profile_privileges();

-- -----------------------------------------------------------------------------
-- Manifest versioning
-- -----------------------------------------------------------------------------
-- The public wall changed => bump the version. The Worker's manifest rebuild
-- and the client's conditional polling both key off this single number.
create or replace function public.tg_bump_manifest_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_relevant boolean := false;
begin
  if tg_op = 'INSERT' then
    v_relevant := new.status = 'active';
  elsif tg_op = 'DELETE' then
    v_relevant := old.status = 'active';
  else
    -- A change is publicly visible if the active flag flipped, or if any
    -- rendered field of an already-active placement changed.
    v_relevant :=
      (old.status = 'active') <> (new.status = 'active')
      or (
        new.status = 'active' and (
          new.title is distinct from old.title
          or new.alt_text is distinct from old.alt_text
          or new.destination_host is distinct from old.destination_host
          or new.image_public_path is distinct from old.image_public_path
        )
      );
  end if;

  if v_relevant then
    update public.wall_state
    set manifest_version = manifest_version + 1,
        last_activated_at = case
          when tg_op <> 'DELETE' and new.status = 'active' then now()
          else last_activated_at
        end,
        updated_at = now()
    where id;
  end if;

  return null;
end;
$$;

drop trigger if exists placements_bump_manifest on public.placements;
create trigger placements_bump_manifest
  after insert or update or delete on public.placements
  for each row execute function public.tg_bump_manifest_version();

comment on function public.tg_bump_manifest_version() is
  'Single source of cache invalidation for the wall. If the manifest ever goes '
  'stale after an approval, look here first.';
