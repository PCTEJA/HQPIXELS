-- =============================================================================
-- HQPixels 0002 — core tables
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
-- One row per authenticated user, created by a trigger on auth.users so it can
-- never be missing. `is_admin` is a privilege bit and is protected by a trigger
-- (see 0007) — no user-facing path may set it.
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  email_verified boolean not null default false,
  display_name  text,
  handle        text,
  is_admin      boolean not null default false,
  founding_buyer boolean not null default false,
  -- Ordinal among settled buyers. NULL until the first payment settles.
  buyer_ordinal integer,
  -- Version string of the terms accepted at the most recent purchase.
  accepted_terms_version text,
  accepted_terms_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint profiles_email_len check (char_length(email) between 5 and 254),
  constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 40),
  constraint profiles_handle_fmt
    check (handle is null or handle ~ '^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$'),
  constraint profiles_buyer_ordinal_positive
    check (buyer_ordinal is null or buyer_ordinal > 0)
);

create unique index if not exists profiles_handle_lower_key
  on public.profiles (lower(handle)) where handle is not null;
create unique index if not exists profiles_email_lower_key
  on public.profiles (lower(email));
create unique index if not exists profiles_buyer_ordinal_key
  on public.profiles (buyer_ordinal) where buyer_ordinal is not null;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.tg_set_updated_at();

comment on table public.profiles is
  'Public-ish buyer profile. Email is present but is never exposed in any '
  'public API response — see shared/api-types.ts.';

-- -----------------------------------------------------------------------------
-- pricing_versions
-- -----------------------------------------------------------------------------
-- Immutable once created. Changing a price means inserting a new version and
-- flipping is_active; existing reservations keep pointing at the version they
-- were quoted under, which is what makes "the price cannot change mid-checkout"
-- a structural guarantee rather than a policy.
create table if not exists public.pricing_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique,
  currency char(3) not null default 'USD',
  cents_per_logical_pixel integer not null,
  -- [{ "label": "...", "x": 0, "y": 0, "w": 10, "h": 10, "multiplierBp": 15000 }]
  -- Array ORDER IS SIGNIFICANT: first match wins. Mirrors shared/pricing.ts.
  zone_multipliers jsonb not null default '[]'::jsonb,
  min_cells integer not null default 1,
  max_cells integer not null default 2500,
  reservation_ttl_seconds integer not null default 2700,
  is_active boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,

  constraint pricing_currency_usd check (currency = 'USD'),
  constraint pricing_cpp_positive check (cents_per_logical_pixel > 0 and cents_per_logical_pixel <= 100000),
  constraint pricing_cells_sane check (min_cells >= 1 and max_cells >= min_cells and max_cells <= 2500),
  constraint pricing_ttl_sane
    -- Must exceed Stripe's 30 minute minimum session lifetime plus headroom.
    check (reservation_ttl_seconds between 2100 and 86400),
  constraint pricing_zones_is_array check (jsonb_typeof(zone_multipliers) = 'array'),
  constraint pricing_zones_bounded check (jsonb_array_length(zone_multipliers) <= 20)
);

-- Exactly one active pricing version, enforced by the database.
create unique index if not exists pricing_versions_single_active
  on public.pricing_versions ((true)) where is_active;

comment on table public.pricing_versions is
  'Append-only price book. Never UPDATE cents_per_logical_pixel on a row that '
  'any reservation references.';

-- -----------------------------------------------------------------------------
-- reservations
-- -----------------------------------------------------------------------------
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete restrict,
  pricing_version_id uuid not null references public.pricing_versions (id) on delete restrict,
  state public.reservation_state not null default 'reserved',

  cell_x integer not null,
  cell_y integer not null,
  cell_w integer not null,
  cell_h integer not null,
  cell_count integer not null,
  logical_pixel_count integer not null,

  quoted_total_cents integer not null,
  currency char(3) not null default 'USD',
  -- Human-readable breakdown captured at quote time, for receipts and disputes.
  quote_breakdown jsonb not null default '{}'::jsonb,

  expires_at timestamptz not null,
  -- Increments on every Checkout Session creation. Feeds the Stripe idempotency
  -- key, so a retry after a genuine failure gets a NEW key while a duplicate
  -- button press reuses the old one.
  checkout_attempt integer not null default 0,

  accepted_terms_version text,
  accepted_terms_at timestamptz,
  -- Truncated /24 (IPv4) or /48 (IPv6) prefix, for abuse correlation only.
  created_ip_prefix text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reservations_coords_in_range
    check (cell_x between 0 and 99 and cell_y between 0 and 99),
  constraint reservations_span_in_range
    check (cell_w between 1 and 100 and cell_h between 1 and 100),
  constraint reservations_within_wall
    check (cell_x + cell_w <= 100 and cell_y + cell_h <= 100),
  constraint reservations_counts_consistent
    check (cell_count = cell_w * cell_h and logical_pixel_count = cell_count * 100),
  constraint reservations_area_bounded check (cell_count between 1 and 2500),
  constraint reservations_total_positive
    check (quoted_total_cents > 0 and quoted_total_cents <= 100000000),
  constraint reservations_currency_usd check (currency = 'USD'),
  constraint reservations_ip_prefix_len
    check (created_ip_prefix is null or char_length(created_ip_prefix) <= 45)
);

drop trigger if exists reservations_set_updated_at on public.reservations;
create trigger reservations_set_updated_at
  before update on public.reservations
  for each row execute function public.tg_set_updated_at();

comment on column public.reservations.created_ip_prefix is
  'Truncated network prefix, never a full IP. Retention: purged by the daily '
  'job after 30 days. See PRIVACY policy.';

-- -----------------------------------------------------------------------------
-- placements
-- -----------------------------------------------------------------------------
-- Coordinates are denormalised from the reservation so the manifest query never
-- has to join, and are kept in sync by a CHECK-backed trigger (0007). They are
-- immutable: an owner can change artwork and link, never position or size.
create table if not exists public.placements (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.reservations (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  status public.placement_status not null default 'draft',

  cell_x integer not null,
  cell_y integer not null,
  cell_w integer not null,
  cell_h integer not null,

  title text not null default '',
  alt_text text not null default '',
  -- Canonical form produced by shared/url-safety.ts. Never the raw buyer input.
  destination_url text,
  destination_host text,

  -- Provider asset id (Cloudflare Images). Randomised by the provider; we never
  -- use a buyer-supplied filename as a key.
  image_asset_id text,
  image_public_path text,
  image_width integer,
  image_height integer,
  image_bytes integer,
  image_mime text,
  image_uploaded_at timestamptz,

  moderation_state public.moderation_decision not null default 'auto_flag',
  moderation_note text,
  moderated_by uuid references public.profiles (id) on delete set null,
  moderated_at timestamptz,

  activated_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text,

  -- Link health, maintained by the daily recheck job.
  link_last_checked_at timestamptz,
  link_last_status integer,
  link_consecutive_failures integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint placements_coords_in_range
    check (cell_x between 0 and 99 and cell_y between 0 and 99),
  constraint placements_within_wall
    check (cell_x + cell_w <= 100 and cell_y + cell_h <= 100),
  constraint placements_span_in_range
    check (cell_w between 1 and 100 and cell_h between 1 and 100),
  constraint placements_title_len check (char_length(title) <= 60),
  constraint placements_alt_len check (char_length(alt_text) <= 140),
  constraint placements_url_len
    check (destination_url is null or char_length(destination_url) between 8 and 512),
  constraint placements_url_scheme
    check (destination_url is null or destination_url ~ '^https?://'),
  constraint placements_host_len
    check (destination_host is null or char_length(destination_host) between 3 and 253),
  constraint placements_image_mime_allowed
    check (image_mime is null or image_mime in ('image/jpeg', 'image/png', 'image/webp')),
  constraint placements_image_dims
    check (
      (image_width is null and image_height is null)
      or (image_width between 10 and 4000 and image_height between 10 and 4000
          and image_width * image_height <= 4000000)
    ),
  constraint placements_image_bytes check (image_bytes is null or image_bytes between 1 and 2097152),
  constraint placements_link_failures check (link_consecutive_failures >= 0),

  -- The publication invariant. A placement literally cannot be 'active' in this
  -- database without artwork, a title, alt text and a destination.
  constraint placements_active_is_complete check (
    status <> 'active'
    or (
      image_public_path is not null
      and char_length(title) > 0
      and char_length(alt_text) > 0
      and destination_url is not null
      and destination_host is not null
      and activated_at is not null
    )
  ),
  constraint placements_disabled_has_reason check (
    status not in ('disabled', 'chargeback_disabled', 'rejected')
    or disabled_reason is not null
    or moderation_note is not null
  )
);

drop trigger if exists placements_set_updated_at on public.placements;
create trigger placements_set_updated_at
  before update on public.placements
  for each row execute function public.tg_set_updated_at();

comment on constraint placements_active_is_complete on public.placements is
  'Structural guarantee behind "only paid and approved placements are '
  'published": an incomplete row cannot reach status = active.';

-- -----------------------------------------------------------------------------
-- pixel_cells — the ownership ledger
-- -----------------------------------------------------------------------------
-- One row per claimed 10x10 unit. The PRIMARY KEY on (cell_x, cell_y) is the
-- mechanism that makes double allocation impossible: two concurrent
-- transactions inserting the same cell means one of them aborts, and because
-- the whole reservation is inserted in a single statement, a partial
-- reservation cannot exist.
create table if not exists public.pixel_cells (
  cell_x integer not null,
  cell_y integer not null,
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  placement_id uuid references public.placements (id) on delete set null,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  claimed_at timestamptz not null default now(),

  constraint pixel_cells_pkey primary key (cell_x, cell_y),
  constraint pixel_cells_coords_in_range
    check (cell_x between 0 and 99 and cell_y between 0 and 99)
);

comment on table public.pixel_cells is
  'Authoritative cell ownership. PRIMARY KEY (cell_x, cell_y) is the '
  'anti-double-allocation constraint. Rows are deleted (cells returned to the '
  'wall) only on expiry, refund, or chargeback — never because a browser closed.';

-- -----------------------------------------------------------------------------
-- payments
-- -----------------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id) on delete restrict,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  status public.payment_status not null default 'requires_payment',

  amount_cents integer not null,
  currency char(3) not null default 'USD',
  amount_refunded_cents integer not null default 0,

  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_customer_id text,
  -- Which reservation.checkout_attempt produced this row. Part of the
  -- idempotency key we send to Stripe.
  checkout_attempt integer not null default 0,
  checkout_expires_at timestamptz,

  paid_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,
  disputed_at timestamptz,
  dispute_status text,
  -- Stripe decline/failure code. Safe to store; shown to nobody but admins.
  last_error_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payments_amount_positive check (amount_cents > 0 and amount_cents <= 100000000),
  constraint payments_refund_bounded
    check (amount_refunded_cents >= 0 and amount_refunded_cents <= amount_cents),
  constraint payments_currency_usd check (currency = 'USD'),
  constraint payments_succeeded_has_paid_at
    check (status <> 'succeeded' or paid_at is not null),
  constraint payments_refunded_consistent
    check (status <> 'refunded' or amount_refunded_cents = amount_cents),
  constraint payments_stripe_ids_len check (
    (stripe_checkout_session_id is null or char_length(stripe_checkout_session_id) <= 255)
    and (stripe_payment_intent_id is null or char_length(stripe_payment_intent_id) <= 255)
    and (stripe_charge_id is null or char_length(stripe_charge_id) <= 255)
  )
);

create unique index if not exists payments_checkout_session_key
  on public.payments (stripe_checkout_session_id) where stripe_checkout_session_id is not null;
create unique index if not exists payments_payment_intent_key
  on public.payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

-- "One active Checkout Session per reservation", enforced by the database.
-- A second attempt is only possible once the first is failed/canceled/expired.
create unique index if not exists payments_one_open_per_reservation
  on public.payments (reservation_id)
  where status in ('requires_payment', 'processing');

-- One settled payment per reservation. This is the last line of defence against
-- double fulfilment if every other check somehow passed.
create unique index if not exists payments_one_settled_per_reservation
  on public.payments (reservation_id)
  where status in ('succeeded', 'refunded', 'partially_refunded', 'disputed');

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- stripe_events — webhook idempotency ledger
-- -----------------------------------------------------------------------------
-- We store the event id (primary key = idempotency) and a digest of the raw
-- body, NOT the body itself: webhook payloads contain customer email and card
-- metadata we have no reason to retain.
create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  api_version text,
  stripe_created_at timestamptz,
  payload_sha256 text not null,
  livemode boolean,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  -- 'ok' | 'ignored:<reason>' | 'error:<code>'
  outcome text,
  attempts integer not null default 0,
  -- Denormalised links, for the reconciler and the admin view.
  reservation_id uuid references public.reservations (id) on delete set null,
  payment_id uuid references public.payments (id) on delete set null,

  constraint stripe_events_id_len check (char_length(id) between 3 and 255),
  constraint stripe_events_type_len check (char_length(type) between 3 and 255),
  constraint stripe_events_digest_len check (char_length(payload_sha256) = 64),
  constraint stripe_events_attempts check (attempts >= 0 and attempts <= 100)
);

comment on table public.stripe_events is
  'Webhook idempotency. INSERT ... ON CONFLICT DO NOTHING decides whether an '
  'event is new; a duplicate delivery therefore does no work. Never stores the '
  'raw payload.';

-- -----------------------------------------------------------------------------
-- wall_state — manifest version
-- -----------------------------------------------------------------------------
-- Single row. Bumped by trigger whenever the public wall changes, so the edge
-- cache and the client both have a cheap monotonic invalidation signal.
create table if not exists public.wall_state (
  id boolean primary key default true,
  manifest_version bigint not null default 1,
  last_activated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint wall_state_singleton check (id)
);

insert into public.wall_state (id) values (true) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Reservation state machine, as data
-- -----------------------------------------------------------------------------
create table if not exists public.reservation_transitions (
  from_state public.reservation_state not null,
  to_state public.reservation_state not null,
  primary key (from_state, to_state)
);

insert into public.reservation_transitions (from_state, to_state) values
  ('draft', 'reserved'),
  ('draft', 'expired'),
  ('reserved', 'ready_for_checkout'),
  ('reserved', 'expired'),
  ('ready_for_checkout', 'checkout_created'),
  ('ready_for_checkout', 'reserved'),
  ('ready_for_checkout', 'expired'),
  ('checkout_created', 'paid_pending_review'),
  ('checkout_created', 'ready_for_checkout'),
  ('checkout_created', 'payment_failed'),
  ('checkout_created', 'expired'),
  ('paid_pending_review', 'active'),
  ('paid_pending_review', 'rejected_refunded'),
  ('paid_pending_review', 'chargeback_disabled'),
  ('paid_pending_review', 'disabled'),
  ('active', 'disabled'),
  ('active', 'chargeback_disabled'),
  ('active', 'rejected_refunded'),
  ('payment_failed', 'ready_for_checkout'),
  ('disabled', 'active'),
  ('disabled', 'chargeback_disabled'),
  ('disabled', 'rejected_refunded')
on conflict do nothing;

comment on table public.reservation_transitions is
  'The state machine from shared/states.ts, as rows. Enforced by the '
  'reservations_enforce_transition trigger — so an illegal transition fails '
  'even if it is attempted with the service role.';

-- -----------------------------------------------------------------------------
-- Role check helper
-- -----------------------------------------------------------------------------
-- Defined here rather than in 0001 because a `language sql` body is validated at
-- CREATE time and this one reads public.profiles.
--
-- STABLE so the planner evaluates it once per statement rather than once per row
-- — it appears in RLS policies on tables that get scanned.
--
-- SECURITY DEFINER because `authenticated` has no unrestricted SELECT on
-- profiles; without it, a policy that reads profiles to decide access to
-- profiles would recurse.
create or replace function public.is_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = p_user_id),
    false
  );
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

comment on function public.is_admin(uuid) is
  'True when the given (default: current) user has the admin bit. Used by RLS. '
  'Never the only authorization check — the Worker checks separately.';
