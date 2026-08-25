-- =============================================================================
-- HQPixels 0014 — session profile lookup
-- =============================================================================

-- -----------------------------------------------------------------------------
-- session_profile
-- -----------------------------------------------------------------------------
-- The Worker calls this once per authenticated request to learn the caller's
-- authorization facts. It exists as its own RPC (rather than the Worker reading
-- the profiles table) for two reasons:
--
--   1. `is_admin` must come from the database, never from a JWT claim. A claim
--      is minted at sign-in and would go stale the moment admin is revoked; and
--      a claim is one signing-key compromise away from being forgeable into
--      admin. Reading it fresh means revocation is immediate.
--   2. It returns exactly the fields authorization needs and nothing else, so an
--      accidental over-fetch cannot leak profile data into a response.
create or replace function public.session_profile(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles where id = p_user_id;

  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'code', 'profile_not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_profile.id,
    'email', v_profile.email,
    'emailVerified', v_profile.email_verified,
    'isAdmin', v_profile.is_admin,
    'foundingBuyer', v_profile.founding_buyer,
    'displayName', v_profile.display_name,
    'handle', v_profile.handle,
    'buyerOrdinal', v_profile.buyer_ordinal,
    'acceptedTermsVersion', v_profile.accepted_terms_version
  );
end;
$$;

revoke all on function public.session_profile(uuid) from public;
grant execute on function public.session_profile(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- update_profile
-- -----------------------------------------------------------------------------
-- The only writable profile fields. Note what is absent: email, is_admin,
-- founding_buyer, buyer_ordinal. Those are guarded by
-- tg_protect_profile_privileges as well, so this function could not change them
-- even if it tried.
create or replace function public.update_profile(
  p_user_id uuid,
  p_display_name text default null,
  p_handle text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  begin
    update public.profiles
    set display_name = coalesce(p_display_name, display_name),
        handle = coalesce(p_handle, handle)
    where id = p_user_id
    returning * into v_profile;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'code', 'handle_taken');
  end;

  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'code', 'profile_not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'displayName', v_profile.display_name,
    'handle', v_profile.handle
  );
end;
$$;

revoke all on function public.update_profile(uuid, text, text) from public;
grant execute on function public.update_profile(uuid, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- record_terms_acceptance
-- -----------------------------------------------------------------------------
-- Stored on the profile AND on the reservation, so a dispute can be answered
-- with "this specific purchase accepted this specific terms version at this
-- timestamp" rather than "the account agreed at some point".
create or replace function public.record_terms_acceptance(
  p_user_id uuid,
  p_reservation_id uuid,
  p_terms_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res public.reservations;
begin
  if p_terms_version is null or char_length(trim(p_terms_version)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'terms_version_required');
  end if;

  select * into v_res
  from public.reservations
  where id = p_reservation_id and owner_id = p_user_id
  for update;

  if v_res.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_res.state not in ('reserved', 'ready_for_checkout') then
    return jsonb_build_object('ok', false, 'code', 'reservation_state_invalid', 'state', v_res.state);
  end if;

  update public.reservations
  set accepted_terms_version = left(p_terms_version, 32), accepted_terms_at = now()
  where id = p_reservation_id;

  update public.profiles
  set accepted_terms_version = left(p_terms_version, 32), accepted_terms_at = now()
  where id = p_user_id;

  return jsonb_build_object('ok', true, 'termsVersion', left(p_terms_version, 32));
end;
$$;

revoke all on function public.record_terms_acceptance(uuid, uuid, text) from public;
grant execute on function public.record_terms_acceptance(uuid, uuid, text) to service_role;
