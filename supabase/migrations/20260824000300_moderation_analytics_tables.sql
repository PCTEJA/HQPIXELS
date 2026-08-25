-- =============================================================================
-- HQPixels 0003 — moderation, audit, analytics, leaderboards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- moderation_actions
-- -----------------------------------------------------------------------------
create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references public.placements (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  -- 'system' for automated checks, 'admin' for a human, 'reporter' for an
  -- abuse report that changed state.
  actor_kind text not null default 'admin',
  decision public.moderation_decision not null,
  reason text,
  -- Structured automated-check output: [{check, result, detail}]
  checks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),

  constraint moderation_actor_kind check (actor_kind in ('system', 'admin', 'reporter')),
  constraint moderation_reason_len check (reason is null or char_length(reason) <= 2000),
  constraint moderation_checks_is_array check (jsonb_typeof(checks) = 'array'),
  -- A human decision must name a human.
  constraint moderation_admin_has_actor
    check (actor_kind <> 'admin' or actor_id is not null)
);

-- Moderation history is evidence. It is append-only.
drop trigger if exists moderation_actions_append_only on public.moderation_actions;
create trigger moderation_actions_append_only
  before update or delete on public.moderation_actions
  for each row execute function public.tg_forbid_update_delete();

-- -----------------------------------------------------------------------------
-- abuse_reports
-- -----------------------------------------------------------------------------
create table if not exists public.abuse_reports (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references public.placements (id) on delete cascade,
  category text not null,
  details text,
  -- Truncated prefix only, 7 day retention. Enough to spot a brigading pattern.
  reporter_ip_prefix text,
  reporter_id uuid references public.profiles (id) on delete set null,
  handled_at timestamptz,
  handled_by uuid references public.profiles (id) on delete set null,
  outcome text,
  created_at timestamptz not null default now(),

  constraint abuse_category check (
    category in ('malware', 'phishing', 'adult', 'illegal', 'misleading', 'broken', 'other')
  ),
  constraint abuse_details_len check (details is null or char_length(details) <= 1000),
  constraint abuse_outcome_len check (outcome is null or char_length(outcome) <= 500)
);

-- -----------------------------------------------------------------------------
-- audit_logs
-- -----------------------------------------------------------------------------
-- Append-only record of security-sensitive and money-moving actions. `detail`
-- is redacted before it gets here (see worker/lib/audit.ts): no tokens, no card
-- data, no full IPs, no email bodies.
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_id uuid references public.profiles (id) on delete set null,
  actor_label text not null default 'system',
  action text not null,
  target_type text not null,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  request_id text,
  -- Truncated prefix. 90 day retention for security investigations.
  ip_prefix text,
  user_agent_family text,

  constraint audit_action_len check (char_length(action) between 3 and 100),
  constraint audit_target_type_len check (char_length(target_type) between 2 and 60),
  constraint audit_target_id_len check (target_id is null or char_length(target_id) <= 200),
  constraint audit_detail_is_object check (jsonb_typeof(detail) = 'object'),
  -- Bounded so a caller cannot use the audit log as blob storage. Uses a text
  -- cast rather than pg_column_size(), which is STABLE and therefore illegal in
  -- a CHECK constraint.
  constraint audit_detail_bounded check (char_length(detail::text) <= 8192),
  constraint audit_request_id_len check (request_id is null or char_length(request_id) <= 64),
  constraint audit_ua_len check (user_agent_family is null or char_length(user_agent_family) <= 60)
);

drop trigger if exists audit_logs_append_only on public.audit_logs;
create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function public.tg_forbid_update_delete();

comment on table public.audit_logs is
  'Append-only. Enforced by trigger, which even the service role cannot bypass. '
  'Retention and redaction rules are in SECURITY.md.';

-- -----------------------------------------------------------------------------
-- view_aggregates
-- -----------------------------------------------------------------------------
-- Page views, pre-aggregated into 5 minute buckets by the AnalyticsBufferDO.
-- There is deliberately no per-view row anywhere: at 100k concurrent viewers a
-- row-per-view design would be the first thing to fall over.
create table if not exists public.view_aggregates (
  bucket_start timestamptz not null,
  -- 'home' | 'wall' | 'rankings' | 'stats' | 'placement' | 'other'
  surface text not null,
  views bigint not null default 0,
  -- Requests dropped by bot filtering. Kept so the public number can be shown
  -- alongside an honest "excluded" figure if we ever choose to publish it.
  filtered bigint not null default 0,
  updated_at timestamptz not null default now(),

  constraint view_aggregates_pkey primary key (bucket_start, surface),
  constraint view_surface check (
    surface in ('home', 'wall', 'rankings', 'stats', 'placement', 'other')
  ),
  constraint view_counts_nonneg check (views >= 0 and filtered >= 0)
);

-- Bucket alignment (every bucket_start must land on a 5 minute boundary) cannot
-- be a CHECK constraint: date_trunc/extract on timestamptz are STABLE, not
-- IMMUTABLE, and PostgreSQL rejects non-immutable expressions in constraints.
-- It is enforced in public.ingest_view_aggregates(), which is the only writer,
-- and asserted by supabase/tests/03_analytics.sql. Unaligned buckets would let
-- a caller create overlapping windows and inflate the public total.
comment on column public.view_aggregates.bucket_start is
  'Start of a 5 minute bucket. Alignment enforced by ingest_view_aggregates().';

-- -----------------------------------------------------------------------------
-- click_aggregates
-- -----------------------------------------------------------------------------
create table if not exists public.click_aggregates (
  bucket_start timestamptz not null,
  placement_id uuid not null references public.placements (id) on delete cascade,
  -- Passed fraud filtering; these are the numbers shown to buyers and used for
  -- the "Most visited" board.
  clicks bigint not null default 0,
  -- Rejected: repeat click from the same visitor cookie inside the bucket, a
  -- known bot signature, or a rate-limited request.
  filtered bigint not null default 0,
  -- Distinct visitor cookies seen in this bucket, capped by the DO's tracking
  -- set size. Labelled as an estimate wherever it is displayed.
  distinct_visitors_est integer not null default 0,
  updated_at timestamptz not null default now(),

  constraint click_aggregates_pkey primary key (bucket_start, placement_id),
  constraint click_counts_nonneg
    check (clicks >= 0 and filtered >= 0 and distinct_visitors_est >= 0)
);

comment on column public.click_aggregates.bucket_start is
  'Start of a 5 minute bucket. Alignment enforced by ingest_click_aggregates().';

-- -----------------------------------------------------------------------------
-- impression_aggregates
-- -----------------------------------------------------------------------------
-- An "impression" here means: the placement was inside the viewport of a
-- rendered wall. Counted client-side, batched, and explicitly labelled as an
-- estimate in the buyer dashboard. It is NOT a verified ad-industry impression
-- and the UI must not imply otherwise.
create table if not exists public.impression_aggregates (
  bucket_start timestamptz not null,
  placement_id uuid not null references public.placements (id) on delete cascade,
  impressions bigint not null default 0,
  updated_at timestamptz not null default now(),

  constraint impression_aggregates_pkey primary key (bucket_start, placement_id),
  constraint impressions_nonneg check (impressions >= 0)
);

-- -----------------------------------------------------------------------------
-- leaderboard_snapshots
-- -----------------------------------------------------------------------------
-- Rankings are computed on a schedule, not per request. The public endpoint
-- serves the newest snapshot straight from KV.
create table if not exists public.leaderboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  computed_at timestamptz not null default now(),
  -- { entries: [...], methodology: "...", windowDescription: "..." }
  payload jsonb not null,

  constraint leaderboard_kind check (
    kind in ('largest_owners', 'top_supporters', 'most_visited', 'rising')
  ),
  constraint leaderboard_payload_is_object check (jsonb_typeof(payload) = 'object'),
  constraint leaderboard_payload_bounded check (char_length(payload::text) <= 262144)
);

-- -----------------------------------------------------------------------------
-- job_runs — observability for scheduled work
-- -----------------------------------------------------------------------------
create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  items_processed integer not null default 0,
  -- Redacted message only. Never a stack trace with connection strings in it.
  note text,

  constraint job_runs_job_len check (char_length(job) between 3 and 60),
  constraint job_runs_note_len check (note is null or char_length(note) <= 1000)
);
