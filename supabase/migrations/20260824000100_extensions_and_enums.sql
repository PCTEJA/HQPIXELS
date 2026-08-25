-- =============================================================================
-- HQPixels 0001 — enums and shared helpers
-- =============================================================================
-- Conventions used by every migration in this directory:
--
--   * Every function is SECURITY DEFINER with `set search_path = ''` and uses
--     fully qualified names. An empty search_path is the single most effective
--     defence against search-path hijacking of a definer function.
--   * EXECUTE is revoked from PUBLIC and granted only to the roles that need
--     it. The Worker uses the service role; almost nothing is callable by
--     `authenticated` or `anon`.
--   * Money is `integer` cents. There is no numeric/float column for money
--     anywhere in this schema, by design.
--   * Every timestamp is `timestamptz`.
-- =============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+; no extension required.
-- We deliberately avoid citext so the schema has no extension dependency —
-- case-insensitive uniqueness is done with unique indexes on lower(...).

-- -----------------------------------------------------------------------------
-- Reservation lifecycle. Mirrors shared/states.ts exactly.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reservation_state') then
    create type public.reservation_state as enum (
      'draft',
      'reserved',
      'ready_for_checkout',
      'checkout_created',
      'paid_pending_review',
      'active',
      'expired',
      'payment_failed',
      'rejected_refunded',
      'disabled',
      'chargeback_disabled'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'placement_status') then
    create type public.placement_status as enum (
      'draft',
      'pending_review',
      'active',
      'rejected',
      'disabled',
      'chargeback_disabled'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type public.payment_status as enum (
      'requires_payment',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'refunded',
      'partially_refunded',
      'disputed'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'moderation_decision') then
    create type public.moderation_decision as enum (
      'auto_pass',
      'auto_flag',
      'auto_reject',
      'approved',
      'rejected',
      'disabled',
      'reenabled'
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.tg_set_updated_at() is
  'BEFORE UPDATE trigger. Keeps updated_at honest even if the caller forgets.';

-- -----------------------------------------------------------------------------
-- Append-only guard
-- -----------------------------------------------------------------------------
-- Used by audit_logs and stripe_events. Note this fires for the service role
-- too: RLS can be bypassed, triggers cannot. That is exactly why the audit
-- trail uses a trigger rather than a policy.
create or replace function public.tg_forbid_update_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Table %.% is append-only (attempted %)',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.tg_forbid_update_delete() is
  'Blocks UPDATE and DELETE, including for superuser/service-role callers.';

-- NOTE: public.is_admin() is defined at the end of 0002, not here. A
-- `language sql` function body is parsed and validated when it is CREATEd, so a
-- helper that reads public.profiles cannot be declared before that table exists.
