-- USAGE — initial schema.
--
-- Conventions:
--   * Money is BIGINT micro-USD (1 USD = 1_000_000). Never float, never numeric
--     rounding surprises. Display formatting happens in the app.
--   * Every user-owned table has RLS on and a policy scoped to auth.uid().
--   * Idempotency lives in the schema, not in application luck: usage_events
--     carries a natural unique key so re-importing a provider window is a no-op.
--   * Scores and rewards always record the algorithm version that produced them,
--     so score_v2 can ship without rewriting history.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- enumerations

create type verification_type as enum ('verified', 'routed', 'reported');
create type verification_status as enum ('confirmed', 'pending', 'unverifiable');
create type usage_source as enum (
  'provider_usage_api',
  'provider_cost_api',
  'org_analytics_api',
  'gateway',
  'local_client',
  'imported_report'
);
create type connection_status as enum ('active', 'error', 'revoked');

-- -------------------------------------------------------------------- profiles

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text unique,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------- provider connections

create table provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  provider text not null,
  account_label text,
  status connection_status not null default 'active',
  -- Non-sensitive settings only. Secrets NEVER live here: they are held in a
  -- server-side secret store and referenced by this handle.
  config jsonb not null default '{}'::jsonb,
  secret_ref text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, provider, account_label)
);

create index provider_connections_user_idx on provider_connections (user_id);

-- ----------------------------------------------------------------- usage events

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  connection_id uuid references provider_connections (id) on delete set null,

  provider text not null,
  source usage_source not null,
  external_reference text not null,
  model text not null,
  occurred_at timestamptz not null,

  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  requests integer not null default 0 check (requests >= 0),

  reported_cost_micros bigint,
  normalized_cost_micros bigint not null default 0,

  verification_type verification_type not null,
  verification_status verification_status not null default 'confirmed',

  -- Usage metadata only. Prompts, completions and source code MUST NOT be stored.
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  -- The idempotency contract. Mirrored by usageEventKey() in the application.
  constraint usage_events_natural_key unique (user_id, provider, source, external_reference)
);

create index usage_events_user_time_idx on usage_events (user_id, occurred_at desc);
create index usage_events_user_provider_idx on usage_events (user_id, provider);

-- ------------------------------------------------------------ daily aggregates

create table usage_daily_aggregates (
  user_id uuid not null references profiles (id) on delete cascade,
  day date not null,
  provider text not null,
  model text not null,
  verification_type verification_type not null,

  requests bigint not null default 0,
  input_tokens bigint not null default 0,
  cached_input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_micros bigint not null default 0,

  updated_at timestamptz not null default now(),
  primary key (user_id, day, provider, model, verification_type)
);

-- ---------------------------------------------------------------- proof records

-- Evidence about how a usage record came to be trusted. Kept separate from the
-- event so future attestation schemes can be added without schema churn.
create table proof_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  usage_event_id uuid not null references usage_events (id) on delete cascade,
  verification_type verification_type not null,
  proof_kind text not null,
  proof_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index proof_records_event_idx on proof_records (usage_event_id);

-- ---------------------------------------------------------------- score records

create table score_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  day date not null,
  algorithm_version text not null,
  weighted_cost_micros bigint not null default 0,
  excluded_cost_micros bigint not null default 0,
  points numeric(20, 4) not null default 0,
  created_at timestamptz not null default now(),
  -- One score per user per day per algorithm version: v2 can be computed
  -- alongside v1 without destroying history.
  unique (user_id, day, algorithm_version)
);

create index score_records_day_idx on score_records (day, algorithm_version);

-- ---------------------------------------------------------------- reward epochs

create table reward_epochs (
  id text primary key,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reward_pool_points bigint not null check (reward_pool_points >= 0),
  scoring_version text not null,
  network_score numeric(24, 4) not null default 0,
  settled_at timestamptz,
  check (ends_at > starts_at)
);

create table reward_allocations (
  epoch_id text not null references reward_epochs (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  score numeric(20, 4) not null default 0,
  network_share numeric(12, 10) not null default 0,
  points bigint not null default 0 check (points >= 0),
  created_at timestamptz not null default now(),
  primary key (epoch_id, user_id)
);

-- ------------------------------------------------------------------------- RLS

alter table profiles enable row level security;
alter table provider_connections enable row level security;
alter table usage_events enable row level security;
alter table usage_daily_aggregates enable row level security;
alter table proof_records enable row level security;
alter table score_records enable row level security;
alter table reward_allocations enable row level security;
alter table reward_epochs enable row level security;

create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own connections" on provider_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Usage is written by trusted server-side sync jobs (service role bypasses RLS);
-- users may read their own rows only.
create policy "read own usage" on usage_events
  for select using (auth.uid() = user_id);

create policy "read own aggregates" on usage_daily_aggregates
  for select using (auth.uid() = user_id);

create policy "read own proofs" on proof_records
  for select using (auth.uid() = user_id);

create policy "read own scores" on score_records
  for select using (auth.uid() = user_id);

create policy "read own allocations" on reward_allocations
  for select using (auth.uid() = user_id);

-- Epochs are public parameters, not user data.
create policy "epochs are readable" on reward_epochs for select using (true);
