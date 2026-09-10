-- 0018_economic_unit.sql
--
-- PREPARED, NOT APPLIED. Lives in supabase/pending/ so that neither the test
-- harness (unless USAGE_TEST_PENDING=1) nor `supabase db push` picks it up.
-- Operating rule 13: presented for approval first; no deployed code depends
-- on it. src/lib/db/migration-0018.test.ts applies it to PGlite on top of
-- 0001-0017; `USAGE_TEST_PENDING=1 npm test` runs the whole suite on the
-- resulting chain.
--
-- WHY
--   M14 made the economic unit explicit: one usage_events row per unique,
--   authoritatively identified AI compute, rewarded at most once, owned by
--   the account that established it. Today the unit's key, dedupe status and
--   verification verdict live in usage_events.raw_metadata and the
--   at-most-once rule is enforced by ingestion code. This migration makes
--   the DATABASE enforce it -- globally, across users -- and makes settled
--   history unwritable, so a future $USAGE accounting snapshot can be
--   derived from rows that provably did not move.
--
-- TABLES / COLUMNS
--   usage_events              + economic_event_key text (null = unkeyed)
--                             + dedupe_status economic_dedupe_status not null default 'unkeyed'
--                             + economic_verification_status text
--                             + economic_verification_policy_version text
--   (new enum)                economic_dedupe_status: unique | duplicate | conflict | unkeyed
--   correlation_status enum   + 'conflict'
--
-- INDEXES
--   usage_events_one_unit_per_key   UNIQUE (economic_event_key)
--                                   where key is not null and dedupe_status = 'unique'
--                                   GLOBAL, not per user: the key carries no
--                                   user id on purpose (see economic-unit.ts,
--                                   "authority scope"), so the same compute
--                                   claimed by two accounts is one unit.
--   usage_events_economic_key_idx   (economic_event_key) for the dedupe lookup
--
-- TRIGGERS (all BEFORE, row-level, plpgsql, search_path = '')
--   usage_events_settled_immutable  settled row: economic columns and user_id
--                                   frozen on UPDATE; DELETE refused. Any row:
--                                   user_id may never change (reward owner is
--                                   the row's user_id; nothing reassigns it).
--   reward_epochs_settled_immutable settled epoch: pool, network score,
--                                   scoring version, bounds, state, kind and
--                                   settlement time frozen; DELETE refused.
--   score_records_settled_immutable a score whose (day, algorithm) lies in a
--                                   settled epoch: UPDATE/DELETE refused.
--   usage_point_ledger_append_only  UPDATE/DELETE refused.
--   reward_allocations_append_only  UPDATE/DELETE refused.
--   protocol_model_prices_frozen    rates may never change or vanish; a
--                                   republish of identical rates is allowed.
--   protocol_pricing_versions_frozen only `status` may change; DELETE refused.
--   reward_policy_versions_frozen   only `status`/`description` may change;
--                                   DELETE refused.
--
-- ROWS REWRITTEN (the whole list)
--   usage_events   every row: the four new columns backfilled from
--                  raw_metadata. Rows with no key in raw_metadata stay
--                  null / 'unkeyed'. No economic column (eligible_compute_micros,
--                  reward_status, reward_hold, economic_status, epoch_id,
--                  protocol_*) is read or written. Ledger, allocations, epochs
--                  and scores are not touched.
--   (rows spelling a conflict 'pending' in correlation_status are NOT
--   relabelled: Postgres forbids using an enum value added in the same
--   transaction. Code writes 'conflict' once this has run.)
--
-- ECONOMIC EFFECT
--   None on any settled value. Prospectively: a second unit for a key, a
--   change to a settled row's economics or owner, a change to a settled
--   epoch, score, allocation, ledger entry, pricing rate or policy row all
--   become database errors, whoever asks (service_role included).
--
-- LOCKING / RUNTIME
--   Everything runs in the one transaction `supabase db push` opens.
--   ADD COLUMN with a constant default is a catalog change (no rewrite).
--   The UNIQUE index is built with a plain CREATE INDEX, holding a SHARE lock
--   on usage_events for the build; CONCURRENTLY is impossible inside a
--   transaction and would be ceremony at the current row count (single
--   digits). Should the table be large when this runs, build the index
--   first in its own non-transactional step. The backfill UPDATE takes a
--   ROW EXCLUSIVE lock and touches every row once. Triggers are pure
--   catalog changes. scripts/preflight-0018.ts (read-only) proves the
--   backfill produces no key that would violate the unique index BEFORE
--   this is run.
--
-- ROLLBACK
--   drop the eight triggers and their five functions; drop the two indexes;
--   drop the four usage_events columns; drop type economic_dedupe_status.
--   raw_metadata still holds every value the columns held. The enum value
--   'conflict' added to correlation_status cannot be dropped in place;
--   set any row using it back to 'pending' and it is harmless.

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

-- ONE AUTHORITATIVE COMPUTE = AT MOST ONE UNIT, across every account.
-- Evidence rows (duplicates, conflicts) may share the key; exactly one row in
-- the whole table may be the unit. Its user_id is the reward owner.
create unique index if not exists usage_events_one_unit_per_key
  on public.usage_events (economic_event_key)
  where economic_event_key is not null and dedupe_status = 'unique';

create index if not exists usage_events_economic_key_idx
  on public.usage_events (economic_event_key)
  where economic_event_key is not null;

-- ------------------------------------------------------------------ immutability

-- Settled economics are history. Provenance may still grow (a later
-- correlation adds a source, a status the ladder spells differently); the
-- money columns, the identity and the owner may not move, whoever asks.
create or replace function public.usage_events_settled_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.economic_status = 'settled' then
      raise exception 'usage_events %: a settled economic unit cannot be deleted', old.id
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  -- The reward owner is the row's user_id. No row, settled or not, moves
  -- between accounts: there is no legitimate operation that needs it.
  if new.user_id is distinct from old.user_id then
    raise exception 'usage_events %: user_id is immutable', old.id
      using errcode = 'restrict_violation';
  end if;

  if old.economic_status = 'settled' then
    if new.economic_status is distinct from old.economic_status
       or new.eligible_compute_micros is distinct from old.eligible_compute_micros
       or new.reward_status is distinct from old.reward_status
       or new.reward_reason is distinct from old.reward_reason
       or new.reward_policy_version is distinct from old.reward_policy_version
       or new.reward_hold is distinct from old.reward_hold
       or new.protocol_compute_micros is distinct from old.protocol_compute_micros
       or new.protocol_pricing_version is distinct from old.protocol_pricing_version
       or new.pricing_status is distinct from old.pricing_status
       or new.economic_source_class is distinct from old.economic_source_class
       or new.actual_cost_micros is distinct from old.actual_cost_micros
       or new.normalized_cost_micros is distinct from old.normalized_cost_micros
       or new.input_tokens is distinct from old.input_tokens
       or new.cached_input_tokens is distinct from old.cached_input_tokens
       or new.output_tokens is distinct from old.output_tokens
       or new.requests is distinct from old.requests
       or new.model is distinct from old.model
       or new.provider is distinct from old.provider
       or new.occurred_at is distinct from old.occurred_at
       or new.epoch_id is distinct from old.epoch_id
       or new.verification_type is distinct from old.verification_type
       or new.verification_status is distinct from old.verification_status
       or new.economic_event_key is distinct from old.economic_event_key
       or new.dedupe_status is distinct from old.dedupe_status
       or new.economic_verification_status is distinct from old.economic_verification_status
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
  before update or delete on public.usage_events
  for each row execute function public.usage_events_settled_immutable();

-- A settled epoch is a statement of what was distributed and why. It does
-- not change; a correction is a new append-only record (see docs).
create or replace function public.reward_epochs_settled_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state <> 'settled' and old.settled_at is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'reward_epochs %: a settled epoch cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id is distinct from old.id
     or new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at
     or new.reward_pool_points is distinct from old.reward_pool_points
     or new.scoring_version is distinct from old.scoring_version
     or new.network_score is distinct from old.network_score
     or new.settled_at is distinct from old.settled_at
     or new.finalizing_at is distinct from old.finalizing_at
     or new.state is distinct from old.state
     or new.epoch_kind is distinct from old.epoch_kind then
    raise exception 'reward_epochs %: a settled epoch is immutable', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists reward_epochs_settled_immutable on public.reward_epochs;
create trigger reward_epochs_settled_immutable
  before update or delete on public.reward_epochs
  for each row execute function public.reward_epochs_settled_immutable();

-- A score that a settled epoch was distributed from stays exactly as it was
-- read. Open days keep recomputing freely.
create or replace function public.score_records_settled_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.reward_epochs e
     where (e.state = 'settled' or e.settled_at is not null)
       and e.scoring_version = old.algorithm_version
       and old.day >= (e.starts_at at time zone 'UTC')::date
       and old.day <  (e.ends_at   at time zone 'UTC')::date
  ) then
    raise exception 'score_records: the score for % under % was used by a settled epoch and is immutable', old.day, old.algorithm_version
      using errcode = 'restrict_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists score_records_settled_immutable on public.score_records;
create trigger score_records_settled_immutable
  before update or delete on public.score_records
  for each row execute function public.score_records_settled_immutable();

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

-- A pricing version's rates are what every unit priced under it resolves to,
-- forever. Republishing the same snapshot is a no-op and allowed; changing a
-- rate is a NEW version. Version rows may only change status.
create or replace function public.protocol_model_prices_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'protocol_model_prices: a published rate cannot be deleted (% / %)', old.pricing_version, old.model
      using errcode = 'restrict_violation';
  end if;
  if new.pricing_version is distinct from old.pricing_version
     or new.model is distinct from old.model
     or new.provider_family is distinct from old.provider_family
     or new.input_micros_per_million is distinct from old.input_micros_per_million
     or new.output_micros_per_million is distinct from old.output_micros_per_million
     or new.cache_read_micros_per_million is distinct from old.cache_read_micros_per_million
     or new.cache_write_micros_per_million is distinct from old.cache_write_micros_per_million
     or new.reasoning_micros_per_million is distinct from old.reasoning_micros_per_million then
    raise exception 'protocol_model_prices: a published rate is immutable (% / %); publish a new version', old.pricing_version, old.model
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists protocol_model_prices_frozen on public.protocol_model_prices;
create trigger protocol_model_prices_frozen
  before update or delete on public.protocol_model_prices
  for each row execute function public.protocol_model_prices_frozen();

create or replace function public.protocol_pricing_versions_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'protocol_pricing_versions: version % cannot be deleted', old.version
      using errcode = 'restrict_violation';
  end if;
  if new.version is distinct from old.version
     or new.source is distinct from old.source
     or new.effective_from is distinct from old.effective_from
     or new.captured_at is distinct from old.captured_at then
    raise exception 'protocol_pricing_versions: version % is immutable except for status', old.version
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists protocol_pricing_versions_frozen on public.protocol_pricing_versions;
create trigger protocol_pricing_versions_frozen
  before update or delete on public.protocol_pricing_versions
  for each row execute function public.protocol_pricing_versions_frozen();

-- Every settled unit names the reward policy that decided it. That name must
-- keep resolving to the same rules: the row may be superseded, never edited
-- into something else or removed.
create or replace function public.reward_policy_versions_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reward_policy_versions: version % cannot be deleted', old.version
      using errcode = 'restrict_violation';
  end if;
  if new.version is distinct from old.version
     or new.effective_from is distinct from old.effective_from then
    raise exception 'reward_policy_versions: version % is immutable except for status and description', old.version
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists reward_policy_versions_frozen on public.reward_policy_versions;
create trigger reward_policy_versions_frozen
  before update or delete on public.reward_policy_versions
  for each row execute function public.reward_policy_versions_frozen();

revoke execute on function public.usage_events_settled_immutable() from public, anon, authenticated;
revoke execute on function public.reward_epochs_settled_immutable() from public, anon, authenticated;
revoke execute on function public.score_records_settled_immutable() from public, anon, authenticated;
revoke execute on function public.settled_history_append_only() from public, anon, authenticated;
revoke execute on function public.protocol_model_prices_frozen() from public, anon, authenticated;
revoke execute on function public.protocol_pricing_versions_frozen() from public, anon, authenticated;
revoke execute on function public.reward_policy_versions_frozen() from public, anon, authenticated;
