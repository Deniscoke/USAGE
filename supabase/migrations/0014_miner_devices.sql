-- USAGE — miner devices and browser pairing.
--
-- The last manual step in onboarding is a user copying a miner token into a
-- terminal. This removes it: the miner asks for a short pairing code, the user
-- approves the device in a browser where they are already signed in, and the
-- credential is delivered to the miner directly.
--
-- THE TRUST RULE THIS DOES NOT CHANGE: a miner is not a trusted reporter of
-- usage. Pairing gives a device the right to ROUTE requests through USAGE and
-- read its own configuration. It gives it no way to assert token counts, cost,
-- proof status or rewards -- those still come only from hosted infrastructure
-- observing the upstream request.

-- --------------------------------------------------------------- devices
--
-- One row per installed miner. The credential belongs to the device, so
-- revoking a laptop does not disturb a desktop.
create table miner_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  -- User-facing label, e.g. the machine name. Never trusted for anything.
  name text not null,
  platform text not null,
  app_version text not null,
  -- The credential this device authenticates with. Hashed, as always.
  credential_id uuid references usage_miner_credentials (id) on delete set null,
  -- Which tools the device reports having enabled. Display only.
  enabled_tools text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index miner_devices_user_idx on miner_devices (user_id, created_at desc);

-- ---------------------------------------------------------------- pairing
--
-- A miner starts a pairing attempt and polls; the user approves it in the
-- browser. Two separate secrets, deliberately:
--
--   user_code    short and human-readable, shown to the user and typed or
--                clicked in the browser. Short enough to read aloud, so it is
--                short-lived, single-use and rate-limited.
--   poll_token   long and random, held only by the miner. Knowing the user_code
--                is NOT enough to collect the credential -- otherwise anyone who
--                glimpsed the screen could steal the pairing.
create table miner_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  -- Displayed to the user. Unique only among live requests.
  user_code text not null,
  -- SHA-256 of the poll token. The plaintext exists only on the device.
  poll_token_hash text not null unique,
  device_name text not null,
  platform text not null,
  app_version text not null,
  -- Set when a signed-in user approves. Until then the request belongs to nobody.
  approved_by uuid references profiles (id) on delete cascade,
  approved_at timestamptz,
  -- The credential minted on approval, collected exactly once by the miner.
  credential_id uuid references usage_miner_credentials (id) on delete set null,
  device_id uuid references miner_devices (id) on delete set null,
  -- The minted token, parked for exactly one collection. Unreachable without
  -- the poll token, and cleared the instant the device picks it up -- so it is
  -- at rest for seconds, not for the life of the row.
  pending_token text,
  collected_at timestamptz,
  denied_at timestamptz,
  created_at timestamptz not null default now(),
  -- Short: a pairing code that lingers is a pairing code somebody else can use.
  expires_at timestamptz not null default now() + interval '10 minutes'
);

-- A live code must be unique; expired ones may repeat.
create unique index miner_pairing_live_code_idx
  on miner_pairing_requests (user_code)
  where collected_at is null and denied_at is null;

create index miner_pairing_expiry_idx on miner_pairing_requests (expires_at);

-- ----------------------------------------------------------------------- RLS
--
-- Devices: a user reads and revokes their own. Creation happens server-side on
-- approval, so a client cannot mint a device for anybody.
alter table miner_devices enable row level security;

create policy "read own miner devices" on miner_devices
  for select using (auth.uid() = user_id);

revoke all on table miner_devices from anon, authenticated;
grant select on table miner_devices to authenticated;
grant all on table miner_devices to service_role;

-- Pairing requests carry a token hash and an unapproved code. No client role
-- touches this table at all; approval goes through a server action.
alter table miner_pairing_requests enable row level security;
revoke all on table miner_pairing_requests from anon, authenticated;
grant all on table miner_pairing_requests to service_role;

-- ------------------------------------------------------- miner protocol
--
-- So the server can later require a minimum miner version without shipping a
-- new server for it. Nothing enforces this yet beyond reporting.
create table miner_protocol_versions (
  version text primary key,
  minimum_supported text not null,
  released_at date not null,
  notes text,
  created_at timestamptz not null default now()
);

insert into miner_protocol_versions (version, minimum_supported, released_at, notes)
values ('miner-protocol-v1', '0.1.0', '2026-09-09',
        'First beta. Pairing, tool configuration, routing and heartbeat.');

alter table miner_protocol_versions enable row level security;
create policy "miner protocol is public" on miner_protocol_versions for select using (true);
revoke insert, update, delete on table miner_protocol_versions from anon, authenticated;
grant select on table miner_protocol_versions to anon, authenticated;
grant all on table miner_protocol_versions to service_role;

-- A credential can belong to a device, so revoking one revokes the other.
alter table usage_miner_credentials
  add column if not exists device_id uuid references miner_devices (id) on delete cascade;
