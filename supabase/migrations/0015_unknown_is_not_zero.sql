-- Unknown protocol compute is NULL, not zero.
--
-- `protocol_compute_micros` was `bigint not null default 0`, so the column
-- could not say "this model has no approved price". A record with no pricing
-- snapshot stored 0, which reads as "we priced it and it was worth nothing" --
-- the same value a genuinely free, genuinely priced generation would store.
-- Two different economic facts, one representation.
--
-- Nothing was mis-rewarded because of it: the reward path reads
-- `protocol_pricing_version`, and `raw_metadata` already recorded the honest
-- null. But a signed proof and a settlement ledger should not depend on a
-- reader knowing which of two columns to believe.
--
-- After this migration:
--
--   pricing_status = 'priced'           protocol_compute_micros is a real
--                                       number produced by a pricing snapshot.
--                                       It may legitimately be 0.
--   pricing_status = 'pending_pricing'  protocol_compute_micros IS NULL. No
--                                       approved price exists for this model.
--   pricing_status = 'unknown_legacy'   predates the metadata that would let us
--                                       tell the two apart. Left exactly as it
--                                       was, flagged for audit, never guessed.

begin;

-- ---------------------------------------------------------------- the column

alter table public.usage_events
  alter column protocol_compute_micros drop default,
  alter column protocol_compute_micros drop not null;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'pricing_status') then
    create type public.pricing_status as enum ('priced', 'pending_pricing', 'unknown_legacy');
  end if;
end $$;

alter table public.usage_events
  add column if not exists pricing_status public.pricing_status;

comment on column public.usage_events.protocol_compute_micros is
  'Deterministic protocol compute in micro-USD, from a frozen pricing snapshot. NULL means no approved price exists -- never zero. A real 0 means priced at zero.';
comment on column public.usage_events.pricing_status is
  'Whether protocol_compute_micros is a price, an absence of one, or too old to tell.';

-- ------------------------------------------------------------ the backfill
--
-- The evidence is `raw_metadata.protocol_compute_micros`, which ingestion has
-- written since the economic model existed and which already distinguishes a
-- number from null. Three cases, in strict order of certainty:

-- 1. A pricing version is attached. The number was computed, so it stands --
--    including a genuine zero. This is the only case that keeps its value.
update public.usage_events
   set pricing_status = 'priced'
 where pricing_status is null
   and protocol_pricing_version is not null;

-- 2. No pricing version, and the metadata explicitly recorded null. The zero in
--    the column is the sentinel this migration exists to remove.
update public.usage_events
   set protocol_compute_micros = null,
       pricing_status = 'pending_pricing'
 where pricing_status is null
   and protocol_pricing_version is null
   and raw_metadata ? 'protocol_compute_micros'
   and raw_metadata->>'protocol_compute_micros' is null;

-- 3. No pricing version, and the metadata says a number anyway. Inconsistent
--    with itself; the pricing version is the authority, so the value is not
--    trusted, but neither is it silently discarded.
update public.usage_events
   set pricing_status = 'unknown_legacy'
 where pricing_status is null
   and protocol_pricing_version is null
   and raw_metadata ? 'protocol_compute_micros';

-- 4. Everything else predates the metadata. Value untouched, marked for audit.
--    Guessing here would rewrite history to make a column tidy, which is
--    exactly the trade this project does not make.
update public.usage_events
   set pricing_status = 'unknown_legacy'
 where pricing_status is null;

alter table public.usage_events
  alter column pricing_status set not null,
  alter column pricing_status set default 'pending_pricing';

-- --------------------------------------------------------------- the invariant
--
-- Enforced rather than documented, because the whole point is that a future
-- writer must not be able to reintroduce the sentinel.

alter table public.usage_events
  drop constraint if exists usage_events_pricing_status_consistent;

alter table public.usage_events
  add constraint usage_events_pricing_status_consistent check (
    (pricing_status = 'priced' and protocol_compute_micros is not null)
    or (pricing_status = 'pending_pricing' and protocol_compute_micros is null)
    or pricing_status = 'unknown_legacy'
  ) not valid;

-- Validated separately so the check applies to new rows immediately and the
-- historical scan does not hold a lock on a table that is being written to.
alter table public.usage_events
  validate constraint usage_events_pricing_status_consistent;

-- ------------------------------------------------------------- settled ledger
--
-- Settlement reads `eligible_compute_micros`, which is a separate column with
-- its own decision recorded beside it, and is untouched here. Nothing about an
-- allocation that has already been settled changes: this migration alters how
-- an absent price is represented, never what anything was worth.

commit;
