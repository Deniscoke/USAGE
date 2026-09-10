-- 0018_economic_unit.sql
--
-- PREPARED, NOT APPLIED. Lives in supabase/pending/ so that neither the test
-- harness nor `supabase db push` picks it up by accident. Operating rule 13:
-- it is presented for approval first, and no deployed code depends on it.
-- src/lib/db/migration-0018.test.ts applies it to PGlite on top of 0001-0017
-- and proves what it enforces.
--
-- WHY. M14 makes the economic unit explicit: one usage_events row per unique,
-- authoritatively identified AI compute, rewarded at most once. Today the
-- unit's key, dedupe status and economic-verification verdict live in
-- usage_events.raw_metadata (jsonb) and the at-most-once rule is enforced by
-- ingestion code (src/lib/db/economic-dedupe.ts) and asserted by tests. This
-- migration moves the key and the two statuses into real columns so the
-- database itself refuses a second primary unit for the same key, and refuses
-- any change to the economic columns of a settled row.
--
-- WHAT CHANGES
--   usage_events      + economic_event_key text (null = unkeyed)
--                     + dedupe_status economic_dedupe_status not null default 'unkeyed'
--                     + economic_verification_status text
--                     + economic_verification_policy_version text
--                     unique partial index (user_id, economic_event_key)
--                       where dedupe_status = 'unique'
--                     trigger: settled rows are economically immutable
--   correlation_status enum + 'conflict'
--   usage_point_ledger, reward_allocations: trigger refusing UPDATE/DELETE
--
-- ROWS REWRITTEN (the whole list)
--   usage_events      every row: the four new columns are backfilled from
--                     raw_metadata (economic_event_key, dedupe_status,
--                     economic_verification_status,
--                     economic_verification_policy_version). Rows without a
--                     key in raw_metadata stay null / 'unkeyed'. No economic
--                     column (eligible_compute_micros, reward_status,
--                     reward_hold, economic_status, epoch_id) is read or
--                     written. The ledger and every epoch are untouched.
--   (correlation_status rows spelled 'pending' for a conflict are NOT
--   rewritten here: Postgres forbids using an enum value added in the same
--   transaction. Code writes 'conflict' once this has run; a later migration
--   may backfill the handful of rows, if any exist by then.)
--
-- ECONOMIC IMPACT. None on any settled value. Prospectively: a second
-- primary unit for a key becomes a database error rather than an ingestion
-- decision; a settled row's economic columns become unwritable even by the
-- service role.
--
-- ROLLBACK. Drop the two triggers and their functions, drop the partial
-- index, drop the four columns from usage_events, drop the enum type
-- economic_dedupe_status. The added enum value 'conflict' cannot be removed
-- from correlation_status in place (Postgres does not drop enum values); rows
-- using it must first be set back to 'pending', after which the value is
-- harmless. raw_metadata keeps everything the columns held, so nothing is
-- lost by rolling back.

-- ------------------------------------------------------------------ types

do $$
begin
  if not exists (select 1 from pg_type where typname = 'economic_dedupe_status') then
    create type public.economic_dedupe_status as enum ('unique', 'duplicate', 'conflict', 'unkeyed');
  end if;
end $$;

alter type public.correlation_status add value if not exists 'conflict';

-- ------------------------------------------------------------------ columns

alter table public.usage_events
  add column if not exists economic_event_key text,
  add column if not exists dedupe_status public.economic_dedupe_status not null default 'unkeyed',
  add column if not exists economic_verification_status text,
  add column if not exists economic_verification_policy_version text;

alter table public.usage_events
  drop constraint if exists usage_events_economic_key_shape;
alter table public.usage_events
  add constraint usage_events_economic_key_shape
  check (economic_event_key is null or economic_event_key ~ '^ecu1:[0-9a-f]{64}$');

alter table public.usage_events
  drop constraint if exists usage_events_economic_verification_known;
alter table public.usage_events
  add constraint usage_events_economic_verification_known
  check (economic_verification_status is null
         or economic_verification_status in ('verified', 'held', 'ineligible', 'not_verified'));

-- ------------------------------------------------------------------ backfill

update public.usage_events
   set economic_event_key = case
         when raw_metadata->>'economic_event_key' ~ '^ecu1:[0-9a-f]{64}$' then raw_metadata->>'economic_event_key'
         else null
       end,
       dedupe_status = case raw_metadata->>'dedupe_status'
         when 'unique'    then 'unique'::public.economic_dedupe_status
         when 'duplicate' then 'duplicate'::public.economic_dedupe_status
         when 'conflict'  then 'conflict'::public.economic_dedupe_status
         else 'unkeyed'::public.economic_dedupe_status
       end,
       economic_verification_status = case
         when raw_metadata->>'economic_verification_status' in ('verified', 'held', 'ineligible', 'not_verified')
           then raw_metadata->>'economic_verification_status'
         else null
       end,
       economic_verification_policy_version = raw_metadata->>'economic_verification_policy_version'
 where economic_event_key is null and dedupe_status = 'unkeyed';

-- A key with no recorded dedupe status is a unit: the key is what made it one.
update public.usage_events
   set dedupe_status = 'unique'
 where economic_event_key is not null and dedupe_status = 'unkeyed';

-- ------------------------------------------------------------------ at most one

-- ONE AUTHORITATIVE COMPUTE = AT MOST ONE UNIT. Evidence rows (duplicates,
-- conflicts) may share the key; exactly one row per user may be the unit.
create unique index if not exists usage_events_one_unit_per_key
  on public.usage_events (user_id, economic_event_key)
  where economic_event_key is not null and dedupe_status = 'unique';

create index if not exists usage_events_economic_key_idx
  on public.usage_events (economic_event_key)
  where economic_event_key is not null;

-- ------------------------------------------------------------------ immutability

-- A settled row's economics are history. Provenance may still grow (a later
-- correlation adds a source); the money columns may not move, whoever asks.
create or replace function public.usage_events_settled_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.economic_status = 'settled' then
    if new.economic_status is distinct from old.economic_status
       or new.eligible_compute_micros is distinct from old.eligible_compute_micros
       or new.reward_status is distinct from old.reward_status
       or new.reward_policy_version is distinct from old.reward_policy_version
       or new.protocol_compute_micros is distinct from old.protocol_compute_micros
       or new.protocol_pricing_version is distinct from old.protocol_pricing_version
       or new.economic_source_class is distinct from old.economic_source_class
       or new.epoch_id is distinct from old.epoch_id
       or new.economic_event_key is distinct from old.economic_event_key
       or new.dedupe_status is distinct from old.dedupe_status
       or new.economic_verification_policy_version is distinct from old.economic_verification_policy_version then
      raise exception 'usage_events %: economic columns of a settled row are immutable', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists usage_events_settled_immutable on public.usage_events;
create trigger usage_events_settled_immutable
  before update on public.usage_events
  for each row execute function public.usage_events_settled_immutable();

-- Settled points and allocations are append-only. There is no legitimate
-- UPDATE or DELETE; a correction is a new, versioned entry.
create or replace function public.settled_history_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: settled history is immutable', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists usage_point_ledger_append_only on public.usage_point_ledger;
create trigger usage_point_ledger_append_only
  before update or delete on public.usage_point_ledger
  for each row execute function public.settled_history_append_only();

drop trigger if exists reward_allocations_append_only on public.reward_allocations;
create trigger reward_allocations_append_only
  before update or delete on public.reward_allocations
  for each row execute function public.settled_history_append_only();

revoke execute on function public.usage_events_settled_immutable() from public, anon, authenticated;
revoke execute on function public.settled_history_append_only() from public, anon, authenticated;
