-- =============================================================================
-- HQPixels 0012 — bootstrap: profile provisioning, launch pricing, admin grant
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Profile provisioning from auth.users
-- -----------------------------------------------------------------------------
-- A profile row can never be missing, because it is created by a trigger on the
-- identity table rather than by application code that might not run.
--
-- email and email_verified are mirrored from auth.users and are NOT
-- application-writable (see tg_protect_profile_privileges). This function opts
-- into the privileged transaction flag because it is the legitimate writer.
create or replace function public.tg_sync_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  -- OAuth providers hand us arbitrary display names. Truncate hard and strip
  -- anything that is not plain text; the Worker normalises properly on first
  -- edit, this is only a sensible default.
  v_name := nullif(
    left(
      regexp_replace(
        coalesce(
          new.raw_user_meta_data ->> 'full_name',
          new.raw_user_meta_data ->> 'name',
          new.raw_user_meta_data ->> 'user_name',
          ''
        ),
        '[^[:print:]]', '', 'g'
      ),
      40
    ),
    ''
  );

  perform set_config('hqpixels.allow_privilege_change', 'on', true);

  insert into public.profiles (id, email, email_verified, display_name)
  values (
    new.id,
    lower(new.email),
    new.email_confirmed_at is not null,
    v_name
  )
  on conflict (id) do update
  set email = lower(excluded.email),
      email_verified = excluded.email_verified,
      display_name = coalesce(public.profiles.display_name, excluded.display_name);

  perform set_config('hqpixels.allow_privilege_change', 'off', true);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_sync_profile_from_auth();

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.tg_sync_profile_from_auth();

comment on function public.tg_sync_profile_from_auth() is
  'Keeps public.profiles in lockstep with auth.users. The only legitimate writer '
  'of profiles.email / email_verified.';

-- -----------------------------------------------------------------------------
-- Launch pricing version
-- -----------------------------------------------------------------------------
-- $0.10 per logical pixel => 10 cents. One unit is 10x10 = 100 logical pixels,
-- so the minimum purchase is 1000 cents = $10.00. No zone multipliers at launch:
-- a flat, explainable price is easier to trust and easier to audit.
insert into public.pricing_versions (
  version, currency, cents_per_logical_pixel, zone_multipliers,
  min_cells, max_cells, reservation_ttl_seconds, is_active, notes
)
values (
  1, 'USD', 10, '[]'::jsonb,
  1, 2500, 2700, true,
  'Launch pricing. $0.10 per logical pixel; minimum purchase one 10x10 unit ($10.00). '
  'Reservation hold 45 minutes, which leaves a 15 minute window in which a Stripe '
  'Checkout Session (30 minute minimum) still expires before the hold does.'
)
on conflict (version) do nothing;

-- -----------------------------------------------------------------------------
-- Admin grant — deliberately awkward
-- -----------------------------------------------------------------------------
-- There is no admin sign-up route, no admin invite email, and no way for the
-- Worker to grant admin. Promoting an account requires a direct database
-- connection as a superuser, which means it requires access to the Supabase
-- dashboard or the pooler credentials.
--
-- Usage (README -> "Creating the first admin"):
--   select public.grant_admin('you@example.com');
--
-- EXECUTE is revoked from every application role INCLUDING service_role, so a
-- compromised Worker cannot create an admin.
create or replace function public.grant_admin(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select p.id into v_id from public.profiles p where lower(p.email) = lower(p_email);

  if v_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'no_such_profile',
      'hint', 'The person must sign in once first so their profile row exists.'
    );
  end if;

  perform set_config('hqpixels.allow_privilege_change', 'on', true);
  update public.profiles set is_admin = true where id = v_id;
  perform set_config('hqpixels.allow_privilege_change', 'off', true);

  perform public.write_audit(
    null, 'operator', 'admin.grant', 'profile', v_id::text,
    jsonb_build_object('email', lower(p_email), 'method', 'sql_console')
  );

  return jsonb_build_object('ok', true, 'profileId', v_id);
end;
$$;

revoke all on function public.grant_admin(text) from public, anon, authenticated, service_role;

comment on function public.grant_admin(text) is
  'Promote a profile to admin. Callable only with a direct superuser database '
  'connection — intentionally not reachable from the application.';

create or replace function public.revoke_admin(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select p.id into v_id from public.profiles p where lower(p.email) = lower(p_email);
  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'no_such_profile');
  end if;

  perform set_config('hqpixels.allow_privilege_change', 'on', true);
  update public.profiles set is_admin = false where id = v_id;
  perform set_config('hqpixels.allow_privilege_change', 'off', true);

  perform public.write_audit(
    null, 'operator', 'admin.revoke', 'profile', v_id::text,
    jsonb_build_object('email', lower(p_email), 'method', 'sql_console')
  );

  return jsonb_build_object('ok', true, 'profileId', v_id);
end;
$$;

revoke all on function public.revoke_admin(text) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Seed the manifest so the first request is not a cold rebuild
-- -----------------------------------------------------------------------------
update public.wall_state set manifest_version = manifest_version where id;
