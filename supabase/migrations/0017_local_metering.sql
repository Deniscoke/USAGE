-- Universal local metering, and the accounting it must never contaminate.
--
-- NOT APPLIED TO PRODUCTION BY THIS COMMIT. See docs/STATE.md: this file is
-- presented for approval first. Everything below is additive -- no column is
-- dropped, renamed or retyped, no row is rewritten -- and it is exercised
-- against PGlite by the test suite before it goes anywhere near a hosted
-- database.
--
-- WHAT IT ADDS
--
--   miner_tool_mappings        which tools a device may meter. Enable/disable
--                              is the user's; everything about trust is not.
--   local_usage_observations   what a paired device saw. A SEPARATE table from
--                              usage_events on purpose: nothing here feeds
--                              scoring, settlement or points. Ever.
--   miner_devices.public_key   the device's Ed25519 signing key.
--   usage_events.provenance_*  a confirmed event may gain "and a local
--                              observation matched it" -- stronger provenance,
--                              same single reward.
--   wallet_connections         a boundary for a future opt-in wallet. Schema
--                              only. Nothing reads it, nothing rewards from it.
--   usage_miner_credentials    two new scopes: telemetry, mappings.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   * give any client a way to write usage_events, score_records, or the
--     ledger -- RLS on those is unchanged and still grants nothing;
--   * let a local observation carry proof_status, verification_type,
--     economic_status, pricing, or reward fields -- the table has no such
--     columns, so there is nothing to lie in;
--   * touch settled allocations, the ledger, or any epoch.

-- ------------------------------------------------------------ tool mappings

do $$
begin
  if not exists (select 1 from pg_type where typname = 'metering_method') then
    create type public.metering_method as enum
      ('native_otel', 'routed', 'provider_import', 'local_observed', 'unsupported');
  end if;
  if not exists (select 1 from pg_type where typname = 'mapping_status') then
    create type public.mapping_status as enum ('enabled', 'disabled');
  end if;
  if not exists (select 1 from pg_type where typname = 'verification_level') then
    -- The ladder. Order matters: each rung is strictly stronger than the last.
    create type public.verification_level as enum
      ('local_observed', 'device_attested', 'provider_correlated', 'routed_confirmed', 'provider_verified_import');
  end if;
  if not exists (select 1 from pg_type where typname = 'correlation_status') then
    create type public.correlation_status as enum ('none', 'pending', 'matched', 'unmatched');
  end if;
end $$;

create table if not exists public.miner_tool_mappings (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.miner_devices (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  tool_id text not null,
  tool_version text,
  -- Decided by the server from the tool registry, never accepted from a client.
  metering_method public.metering_method not null,
  status public.mapping_status not null default 'enabled',
  -- The strongest verification this tool's evidence can ever reach on its own.
  -- A ceiling, not a promise: an individual event may be weaker.
  verification_capability public.verification_level not null,
  enabled_at timestamptz not null default now(),
  disabled_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, tool_id)
);

create index if not exists miner_tool_mappings_user_idx on public.miner_tool_mappings (user_id, status);

alter table public.miner_tool_mappings enable row level security;

-- Owners read their own mappings. Nobody writes through PostgREST: the miner
-- API (service role, after authenticating the device credential) is the only
-- writer, exactly as for miner_devices.
drop policy if exists miner_tool_mappings_owner_read on public.miner_tool_mappings;
create policy miner_tool_mappings_owner_read on public.miner_tool_mappings
  for select to authenticated using (user_id = auth.uid());

revoke all on public.miner_tool_mappings from anon, authenticated;
grant select on public.miner_tool_mappings to authenticated;
grant all on table public.miner_tool_mappings to service_role;

-- --------------------------------------------------------- device signing key

alter table public.miner_devices
  add column if not exists public_key text,
  add column if not exists public_key_algorithm text,
  add column if not exists public_key_registered_at timestamptz,
  -- Safe state from the heartbeat. Never a process list or a path.
  add column if not exists os text,
  add column if not exists tool_state jsonb not null default '[]'::jsonb,
  add column if not exists last_usage_event_at timestamptz,
  add column if not exists device_trust_level text not null default 'paired';

comment on column public.miner_devices.public_key is
  'SPKI DER, base64. Proves an upload came from this device. Proves nothing about whether its numbers are true.';
comment on column public.miner_devices.device_trust_level is
  'paired | attested. A hook for future policy; today every device is paired and attested devices are those with a registered key.';

-- ------------------------------------------------------ local observations
--
-- Everything a device reports lands here and ONLY here. There is no path from
-- this table into usage_events except correlation, which never inserts: it
-- marks a local row matched and annotates an existing trusted event.

create table if not exists public.local_usage_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_id uuid not null references public.miner_devices (id) on delete cascade,
  mapping_id uuid references public.miner_tool_mappings (id) on delete set null,

  schema_version text not null,
  adapter text not null,
  tool_id text not null,
  tool_version text,
  source_type text not null,

  provider text not null,
  model text,
  -- The provider's own request identity, as the tool passed it along. The
  -- ONLY field with correlation value. Null when the tool did not supply one.
  upstream_request_id text,

  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  reasoning_tokens bigint,
  tool_tokens bigint,
  -- The tool's own estimate. Recorded, displayed, never used for anything.
  estimated_cost_micros bigint,

  occurred_at timestamptz not null,
  local_session_id text not null,
  -- Retry-safe delivery id from the device. Dedupe key together with device.
  local_event_id text not null,

  -- Ed25519 over the canonical observation. Verified at ingestion when the
  -- device's key was registered; stored either way so it can be checked later.
  device_signature text,
  signature_verified boolean not null default false,

  -- Where this sits on the ladder. Starts at device_attested (signature
  -- verified) or local_observed (not), and rises to provider_correlated only
  -- when the server matches upstream_request_id to a record it trusts.
  verification_level public.verification_level not null default 'local_observed',
  correlation_status public.correlation_status not null default 'none',
  -- The trusted usage_event this observation was matched to, if any.
  correlated_event_id uuid references public.usage_events (id) on delete set null,
  -- sha256 of (provider, upstream_request_id): a joinable identity that does
  -- not itself reveal the id, for anti-Sybil work later.
  provider_identity_hash text,

  received_at timestamptz not null default now(),
  unique (device_id, local_event_id)
);

create index if not exists local_usage_observations_user_day_idx
  on public.local_usage_observations (user_id, occurred_at desc);
create index if not exists local_usage_observations_upstream_idx
  on public.local_usage_observations (user_id, provider, upstream_request_id)
  where upstream_request_id is not null;

-- The invariant, as a constraint rather than a comment: a local observation
-- cannot be economically anything. There are no columns for it to be.
comment on table public.local_usage_observations is
  'Device-reported usage. Analytics and provenance only. Never scored, never settled, never rewarded. Has no economic columns by design.';

alter table public.local_usage_observations enable row level security;

drop policy if exists local_usage_observations_owner_read on public.local_usage_observations;
create policy local_usage_observations_owner_read on public.local_usage_observations
  for select to authenticated using (user_id = auth.uid());

revoke all on public.local_usage_observations from anon, authenticated;
grant select on public.local_usage_observations to authenticated;
grant all on table public.local_usage_observations to service_role;

-- -------------------------------------------- provenance on trusted events
--
-- A trusted event may be corroborated by a local observation. That adds a
-- provenance source and a level; it never adds a second reward, because the
-- reward columns on this row are untouched by correlation.

alter table public.usage_events
  add column if not exists provenance_sources text[] not null default '{}',
  add column if not exists verification_level public.verification_level,
  add column if not exists correlation_status public.correlation_status not null default 'none',
  add column if not exists identity_trust_level text not null default 'account',
  add column if not exists provider_identity_hash text;

-- Existing rows: their level is what their verification type already says.
-- Nothing economic changes; this names what was already true.
update public.usage_events
   set verification_level = case
         when verification_type = 'verified' then 'provider_verified_import'::public.verification_level
         when verification_type = 'routed'   then 'routed_confirmed'::public.verification_level
         else 'local_observed'::public.verification_level
       end,
       provenance_sources = case
         when verification_type = 'verified' then array['provider_import']
         when verification_type = 'routed'   then array['usage_gateway']
         else array['reported']
       end
 where verification_level is null;

create index if not exists usage_events_provider_identity_idx
  on public.usage_events (user_id, provider_identity_hash)
  where provider_identity_hash is not null;

-- ------------------------------------------------------------ miner scopes

alter table public.usage_miner_credentials
  drop constraint if exists usage_miner_credentials_scopes_known;

alter table public.usage_miner_credentials
  add constraint usage_miner_credentials_scopes_known check (
    scopes <@ array[
      'miner:route', 'miner:config', 'miner:heartbeat', 'miner:rotate',
      'miner:telemetry', 'miner:mappings'
    ]::text[]
  );

-- Every existing device credential gains the two new abilities. They are the
-- same class of thing the credential already had -- reporting about itself --
-- and neither can move a single point.
update public.usage_miner_credentials
   set scopes = array(
     select distinct s from unnest(scopes || array['miner:telemetry', 'miner:mappings']) as s
   )
 where revoked_at is null;

alter table public.usage_miner_credentials
  alter column scopes set default array[
    'miner:route', 'miner:config', 'miner:heartbeat', 'miner:rotate',
    'miner:telemetry', 'miner:mappings'
  ];

-- --------------------------------------------------- future wallet boundary
--
-- Schema readiness only. No route writes it, no UI shows it, and NOTHING in
-- scoring, settlement or the ledger references it. A wallet address is a
-- place a future snapshot might be claimed from; it is not an input to how
-- much anyone earned, and a test asserts that.

create table if not exists public.wallet_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- CAIP-2 style: namespace and chain id, e.g. ('eip155', '1'). No chain is
  -- chosen here; the columns exist so a choice does not need a migration.
  chain_namespace text not null,
  chain_id text not null,
  address text not null,
  -- Ownership must be proven by signing a server nonce. Unverified rows are
  -- inert; USAGE never holds a private key.
  verified_at timestamptz,
  verification_method text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, chain_namespace, chain_id, address)
);

alter table public.wallet_connections enable row level security;
revoke all on public.wallet_connections from anon, authenticated;
grant all on table public.wallet_connections to service_role;
-- No policies at all: not readable, not writable, by any client role. It
-- becomes reachable when a milestone that needs it says so.
