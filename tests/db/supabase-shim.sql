-- =============================================================================
-- TEST-ONLY Supabase shim
-- =============================================================================
-- Recreates the parts of a Supabase project that our migrations depend on, so
-- the schema can be applied and tested against a plain PostgreSQL 15+ instance
-- with no Docker and no cloud project.
--
-- WHY THIS EXISTS
--   `supabase db reset` (Docker) is the primary path and is what CI uses when
--   Docker is available. This shim is the fallback: it lets a developer or a
--   Docker-less CI runner apply every migration and run the pgTAP suite in a
--   throwaway cluster. It is how the migrations in this repo were verified.
--
-- NEVER RUN THIS AGAINST A REAL SUPABASE PROJECT. Supabase already provides all
-- of it, and re-creating `auth.users` would be destructive.
--
-- Usage:
--   psql -f tests/db/supabase-shim.sql -d <throwaway-db>
--   then apply supabase/migrations/*.sql in filename order.
-- =============================================================================

-- Fail loudly if someone points this at a real project.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception
      'Refusing to run: this looks like a real Supabase project (supabase_admin exists).';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Roles
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- BYPASSRLS mirrors Supabase: the Worker's service role is not constrained
    -- by RLS, which is the documented trust boundary.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant anon, authenticated, service_role to current_user;

-- -----------------------------------------------------------------------------
-- auth schema
-- -----------------------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Supabase reads the `sub` claim from the request JWT. Tests simulate a signed-in
-- user with:
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  );
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.email', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
    ),
    ''
  );
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- Supabase sets these defaults on a fresh project; migration 0011 revokes them
-- again. Creating them here means the revoke is actually exercised by the tests.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
