-- USAGE — product platform.
--
-- Turns the proven engine into a product: a provider-neutral registry, a
-- versioned mining protocol, a real network denominator, and the first pieces
-- of crypto readiness. Nothing about proof issuance, pricing or settlement
-- changes here.

-- ------------------------------------------------------------- providers
--
-- Mirror of src/lib/providers/catalog.ts, kept in the database so the product's
-- claims about a provider are auditable without reading the source tree. The
-- code is the source of truth; `npm run usage:providers:publish` re-syncs.
--
-- The honesty rule lives in the data: a capability is 'available' only when a
-- code path exists. Everything else is 'coming_soon' and the UI says so.
create table providers (
  slug text primary key,
  name text not null,
  category text not null,
  status text not null,
  integration_version text not null,
  routed_mining text not null default 'unsupported',
  verified_import text not null default 'unsupported',
  byok text not null default 'unsupported',
  subscription text not null default 'unsupported',
  usage_fields text[] not null default '{}',
  cost_fields text[] not null default '{}',
  updated_at timestamptz not null default now(),
  check (category in ('model_provider', 'gateway', 'cloud_platform')),
  check (status in ('beta', 'experimental', 'planned')),
  check (routed_mining in ('available', 'experimental', 'coming_soon', 'unsupported')),
  check (verified_import in ('available', 'experimental', 'coming_soon', 'unsupported')),
  check (byok in ('available', 'experimental', 'coming_soon', 'unsupported')),
  check (subscription in ('available', 'experimental', 'coming_soon', 'unsupported'))
);

-- How a connection was made. A connection's *state* is derived (from the
-- catalog and this row), never stored twice.
alter table provider_connections
  add column if not exists method text not null default 'routed_mining';

alter table provider_connections
  add constraint provider_connections_method_check
  check (method in ('routed_mining', 'verified_import', 'byok', 'subscription'));

-- ------------------------------------------------- mining protocol versions
--
-- Emission, epoch length, scoring and pricing as one versioned bundle, so the
-- number 100000 lives in exactly one place and a protocol change is a new
-- version rather than an edit.
--
-- `network = 'development'` is a statement of fact: this is not a public
-- network and the emission is not tokenomics.
create table mining_protocol_versions (
  version text primary key,
  epoch_duration_seconds integer not null check (epoch_duration_seconds > 0),
  epoch_emission_points bigint not null check (epoch_emission_points >= 0),
  scoring_version text not null,
  pricing_version text not null,
  effective_from date not null,
  network text not null,
  status text not null,
  created_at timestamptz not null default now(),
  check (network in ('development', 'production')),
  check (status in ('active', 'superseded'))
);

insert into mining_protocol_versions
  (version, epoch_duration_seconds, epoch_emission_points, scoring_version,
   pricing_version, effective_from, network, status)
values
  ('mining-dev-v1', 86400, 100000, 'usage_score_v1', 'usage-pricing-v2',
   '2026-09-01', 'development', 'active');

alter table reward_epochs
  add column if not exists protocol_version text references mining_protocol_versions (version);

-- ------------------------------------------------------- network denominator
--
-- A user's share of an epoch needs the network's total score, which no user can
-- read under RLS. This view is the one legitimate aggregate: totals only, no
-- user ids, no per-user rows. It is security definer on purpose -- an invoker
-- view would return only the caller's own score and quietly report a 100%
-- share.
create view epoch_network_totals
with (security_invoker = off) as
  select
    day,
    algorithm_version,
    sum(points)::numeric(24, 4) as network_score,
    count(*)::bigint as participants
  from score_records
  where points > 0
  group by day, algorithm_version;

-- ------------------------------------------------------------ crypto readiness
--
-- A wallet address is a nullable label on a profile. USAGE holds no keys, takes
-- no custody, and there is no token to receive: this exists so a future claim
-- dataset can be built without a migration on historical data.
alter table profiles
  add column if not exists wallet_address text;

create unique index if not exists profiles_wallet_address_idx
  on profiles (wallet_address) where wallet_address is not null;

-- Immutable per-epoch balance snapshots, so a future snapshot can state what a
-- user earned from which epochs without recomputing (or rewriting) history.
create table point_balance_snapshots (
  user_id uuid not null references profiles (id) on delete cascade,
  epoch_id text not null references reward_epochs (id) on delete restrict,
  points_credited bigint not null check (points_credited >= 0),
  balance_after bigint not null check (balance_after >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, epoch_id)
);

-- ----------------------------------------------------------------------- RLS
--
-- Same rule as everywhere: users read their own rows and write nothing that
-- carries economic weight.
alter table providers enable row level security;
alter table mining_protocol_versions enable row level security;
alter table point_balance_snapshots enable row level security;

create policy "providers are public" on providers for select using (true);
create policy "protocol versions are public" on mining_protocol_versions for select using (true);
create policy "read own snapshots" on point_balance_snapshots
  for select using (auth.uid() = user_id);

revoke insert, update, delete on table providers from anon, authenticated;
revoke insert, update, delete on table mining_protocol_versions from anon, authenticated;
revoke insert, update, delete on table point_balance_snapshots from anon, authenticated;

grant select on table providers to anon, authenticated;
grant select on table mining_protocol_versions to anon, authenticated;
grant select on table point_balance_snapshots to authenticated;
grant select on table epoch_network_totals to anon, authenticated;
grant all on table providers to service_role;
grant all on table mining_protocol_versions to service_role;
grant all on table point_balance_snapshots to service_role;

-- wallet_address needs no new grant: profiles already carry the "own profile"
-- policy, so a user can name their own wallet and nothing else.
