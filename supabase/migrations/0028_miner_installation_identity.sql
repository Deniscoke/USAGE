-- USAGE — the same computer keeps the same device row when it pairs again.
--
-- Until now every pairing inserted a new miner_devices row. Signing out and back
-- in on the same PC left an "Offline · previous pairing" ghost behind, reset every
-- tool mapping to off, and started local-event deduplication from scratch, because
-- observations are unique per (device_id, local_event_id).
--
-- Since 0.4.2 the miner mints a random installation id (installation.json) and
-- sends it when pairing. This migration stores it; `approve()` then reuses the
-- APPROVING user's LIVE device row with that id instead of inserting a new one
-- (docs/MINER.md §8).
--
-- WHAT THE ID IS NOT: a credential or proof of anything. It arrives on an
-- unauthenticated request, so it only ever selects among rows the approving user
-- already owns. Knowing somebody's installation id gains nothing without that
-- person approving the pairing in their own signed-in browser -- and approving a
-- stranger's code already hands them a device. A revoked device is never revived:
-- revoking is a deliberate decision, so a later pairing starts a new row.

alter table public.miner_pairing_requests
  add column if not exists installation_id text;

alter table public.miner_devices
  add column if not exists installation_id text;

alter table public.miner_pairing_requests
  drop constraint if exists miner_pairing_requests_installation_id_format;
alter table public.miner_pairing_requests
  add constraint miner_pairing_requests_installation_id_format
  check (installation_id is null or installation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

alter table public.miner_devices
  drop constraint if exists miner_devices_installation_id_format;
alter table public.miner_devices
  add constraint miner_devices_installation_id_format
  check (installation_id is null or installation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- At most one live row per installation per account. Two approvals racing for the
-- same installation cannot both insert; the loser fails instead of duplicating.
create unique index if not exists miner_devices_live_installation_key
  on public.miner_devices (user_id, installation_id)
  where installation_id is not null and revoked_at is null;

comment on column public.miner_devices.installation_id is
  'Random id of the miner installation, sent at pairing. Selects which of the owner''s live rows a re-pair reuses. Never an authenticator.';
