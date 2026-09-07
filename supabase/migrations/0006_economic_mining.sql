-- USAGE — economic mining v1.
--
-- The protocol rewards VERIFIED COMPUTE, not what a user happened to pay.
-- Two identical requests must mine identically whether one was billed at list
-- price and the other covered by BYOK, credits or an enterprise discount.
--
-- So two separate numbers, never conflated:
--
--   protocol_compute_micros   deterministic, from a frozen pricing snapshot.
--                             The economic basis for mining.
--   reported_cost_micros      what the gateway actually said it cost, when it
--                             says anything. Analytics and reconciliation only.

-- --------------------------------------------------------- pricing snapshots
--
-- A mirror of the reviewed snapshots in src/lib/pricing, kept in the database so
-- an economic record can be audited without reading the source tree. `status`
-- makes freezing explicit: once a version has priced anything, it is 'frozen'
-- and a price change means a NEW version, never an edit.
create table protocol_pricing_versions (
  version text primary key,
  source text not null,
  effective_from date not null,
  captured_at timestamptz not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  check (status in ('active', 'frozen', 'superseded'))
);

create table protocol_model_prices (
  pricing_version text not null references protocol_pricing_versions (version) on delete restrict,
  model text not null,
  provider_family text not null,
  input_micros_per_million bigint not null check (input_micros_per_million >= 0),
  output_micros_per_million bigint not null check (output_micros_per_million >= 0),
  cache_read_micros_per_million bigint check (cache_read_micros_per_million >= 0),
  cache_write_micros_per_million bigint check (cache_write_micros_per_million >= 0),
  reasoning_micros_per_million bigint check (reasoning_micros_per_million >= 0),
  primary key (pricing_version, model)
);

-- ------------------------------------------------------ economics on an event

alter table usage_events
  add column if not exists protocol_compute_micros bigint not null default 0,
  add column if not exists protocol_pricing_version text,
  add column if not exists protocol_pricing_basis text,
  -- Reserved for a future fraud review step. Nothing writes them yet; they exist
  -- so adding review later does not require touching settled history.
  add column if not exists fraud_status text not null default 'none',
  add column if not exists reward_hold boolean not null default false;

alter table usage_events
  add constraint usage_events_fraud_status_check
  check (fraud_status in ('none', 'review', 'rejected'));

-- PENDING_PRICING: a genuine confirmed proof whose model this pricing version
-- does not cover. SETTLED: already counted into an epoch allocation.
alter table usage_events drop constraint if exists usage_events_economic_status_check;
alter table usage_events
  add constraint usage_events_economic_status_check
  check (economic_status in ('eligible', 'pending_cost', 'pending_pricing', 'ineligible', 'settled'));

create index if not exists usage_events_pricing_idx
  on usage_events (user_id, protocol_pricing_version);

-- ------------------------------------------------------------------- ledger
--
-- Append-only record of every Usage Point credited. Usage Points are an
-- off-chain protocol accounting unit: not money, not a security, not a claim on
-- any future token.
--
-- The unique constraint on allocation_id is the anti-double-mint rule: an epoch
-- allocation can credit the ledger exactly once, however many times settlement
-- is retried.
create table usage_point_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  epoch_id text not null references reward_epochs (id) on delete restrict,
  allocation_id text not null unique,
  amount bigint not null check (amount >= 0),
  reason text not null,
  created_at timestamptz not null default now()
);

create index usage_point_ledger_user_idx on usage_point_ledger (user_id, created_at desc);

-- Epochs need to record which rules produced them, so a historical epoch stays
-- explainable after the rules move on.
alter table reward_epochs
  add column if not exists pricing_version text,
  add column if not exists epoch_kind text not null default 'development';

alter table reward_epochs
  add constraint reward_epochs_kind_check check (epoch_kind in ('development', 'production'));

-- --------------------------------------------------------------------- RLS
--
-- Same rule as everywhere else: users read their own rows, and write nothing.
-- Economic values are computed server-side from a signed proof, an approved
-- pricing snapshot and versioned scoring rules.
alter table protocol_pricing_versions enable row level security;
alter table protocol_model_prices enable row level security;
alter table usage_point_ledger enable row level security;

create policy "pricing versions are public" on protocol_pricing_versions for select using (true);
create policy "model prices are public" on protocol_model_prices for select using (true);
create policy "read own points" on usage_point_ledger
  for select using (auth.uid() = user_id);

revoke insert, update, delete on table protocol_pricing_versions from anon, authenticated;
revoke insert, update, delete on table protocol_model_prices from anon, authenticated;
revoke insert, update, delete on table usage_point_ledger from anon, authenticated;

grant select on table protocol_pricing_versions to anon, authenticated;
grant select on table protocol_model_prices to anon, authenticated;
grant select on table usage_point_ledger to authenticated;
grant all on table protocol_pricing_versions to service_role;
grant all on table protocol_model_prices to service_role;
grant all on table usage_point_ledger to service_role;
