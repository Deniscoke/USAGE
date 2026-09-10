-- 0019 — v2 economics: exact pico compute, versioned emission, epoch version
--        binding, development calibration disposition, claimability
--
-- STATUS: PENDING. Lives in supabase/pending/ on purpose so that neither
-- `supabase db push` nor the PGlite chain picks it up. Applying it to
-- production is an owner decision (CLAUDE.md rule 13) and a separate act.
--
-- ORDER (M15D): this migration is ADDITIVE and activates nothing, and the
-- calibration close of epoch-2026-09-10 needs the columns and rows it adds
-- (protocol binding, claimable flag, mining-dev-calibration-v1). So the
-- order is: apply 0019 while mining-dev-v1 stays active -> verify -> close
-- the calibration epoch with zero emission -> verify zero ledger delta ->
-- only then, at a named UTC epoch, activate v2.
--
-- WHAT IT DOES (no row is rewritten economically, no history changes)
--   1. usage_events: authoritative v2 economics in pico-USD beside the legacy
--      micro columns, which stay authoritative for v1 forever.
--   2. score_records: the v2 score (Σ eligible pico) as an exact integer.
--   3. mining_protocol_versions: emission parameters, role (network |
--      calibration), claimable, and a 'draft' status; inserts
--      mining-dev-calibration-v1 (ACTIVE, role calibration, zero emission)
--      and mining-beta-v2 (DRAFT).
--   4. reward_epochs: `claimable` flag, effective/undistributed points,
--      network pico; the existing `protocol_version` FK (0008) is the epoch's
--      emission binding. Historical epochs are stamped
--      protocol_version = 'mining-dev-v1' and claimable = false BEFORE the
--      immutability trigger learns those columns, so the stamp is possible
--      exactly once and never again.
--   5. Extends the 0018 immutability triggers to every new column.
--   6. audit_epoch(): one row that answers, from persisted data only, which
--      scoring, pricing and emission rules an epoch used, what it emitted and
--      whether it is claimable.
--   7. check_v2_epoch_settleable(): the database's copy of the pre-settlement
--      invariants for baseline-linear-v1 epochs.
--
-- WHAT IT DOES NOT DO
--   - It does not activate usage_score_v2, usage-pricing-v3 or mining-beta-v2.
--   - It does not settle epoch-2026-09-10, nor touch the M14C event
--     (c75acc2e), its score, its proof, any allocation or any ledger row.
--   - It backfills NO economic value (see §8).
--
-- TYPES. One token at p micro-USD per million tokens is exactly p pico-USD.
-- bigint (9.22e18 pico = $9.2M) bounds one event but not a day or an epoch,
-- and a later type change on a settled table would collide with the
-- immutability triggers, so every pico column is numeric(38,0): an exact
-- integer, never a float, never rounded, checked integral and non-negative.

begin;

-- 1. usage_events ---------------------------------------------------------

alter table public.usage_events
  add column if not exists protocol_compute_pico numeric(38,0),
  add column if not exists eligible_compute_pico numeric(38,0),
  add column if not exists pricing_components_pending text[] not null default '{}';

alter table public.usage_events
  add constraint usage_events_protocol_compute_pico_integral
    check (protocol_compute_pico is null or (protocol_compute_pico >= 0 and protocol_compute_pico = trunc(protocol_compute_pico))),
  add constraint usage_events_eligible_compute_pico_integral
    check (eligible_compute_pico is null or (eligible_compute_pico >= 0 and eligible_compute_pico = trunc(eligible_compute_pico))),
  add constraint usage_events_eligible_pico_le_protocol
    check (eligible_compute_pico is null or protocol_compute_pico is null or eligible_compute_pico <= protocol_compute_pico);

comment on column public.usage_events.protocol_compute_pico is
  'Exact protocol compute value in pico-USD (10^-12 USD), usage-pricing-v3+. NULL for rows priced under v1/v2, whose protocol_compute_micros stays authoritative.';
comment on column public.usage_events.eligible_compute_pico is
  'AUTHORITATIVE for usage_score_v2: pico-USD the reward policy made eligible. NULL for v1 rows.';
comment on column public.usage_events.pricing_components_pending is
  'Token classes the pricing version could not price (e.g. {cacheRead}). Non-empty => the whole event is pending (M15C decision A).';

create index if not exists usage_events_epoch_eligible_pico_idx
  on public.usage_events (epoch_id, user_id)
  where eligible_compute_pico is not null and reward_status = 'eligible';

-- 2. score_records --------------------------------------------------------

alter table public.score_records
  add column if not exists weighted_compute_pico numeric(38,0);

alter table public.score_records
  add constraint score_records_weighted_compute_pico_integral
    check (weighted_compute_pico is null or (weighted_compute_pico >= 0 and weighted_compute_pico = trunc(weighted_compute_pico)));

comment on column public.score_records.weighted_compute_pico is
  'usage_score_v2: the score IS this number (Σ eligible_compute_pico for the user and epoch). NULL for v1 rows.';

-- 3. mining_protocol_versions --------------------------------------------

alter table public.mining_protocol_versions
  drop constraint if exists mining_protocol_versions_status_check;
alter table public.mining_protocol_versions
  add constraint mining_protocol_versions_status_check check (status in ('draft', 'active', 'superseded'));

alter table public.mining_protocol_versions
  add column if not exists emission_algorithm text not null default 'fixed-pool-v1',
  add column if not exists baseline_compute_pico numeric(38,0),
  add column if not exists floor_points bigint not null default 0,
  add column if not exists undistributed_policy text not null default 'distributed',
  add column if not exists role text not null default 'network',
  add column if not exists claimable boolean not null default false,
  add column if not exists effective_from_epoch text;

alter table public.mining_protocol_versions
  add constraint mining_protocol_versions_emission_algorithm_check
    check (emission_algorithm in ('fixed-pool-v1', 'baseline-linear-v1', 'zero-reward-calibration-v1')),
  add constraint mining_protocol_versions_undistributed_check
    check (undistributed_policy in ('distributed', 'never_minted')),
  add constraint mining_protocol_versions_role_check
    check (role in ('network', 'calibration')),
  add constraint mining_protocol_versions_baseline_required
    check (emission_algorithm <> 'baseline-linear-v1' or (baseline_compute_pico is not null and baseline_compute_pico > 0)),
  -- A calibration version emits nothing, ever.
  add constraint mining_protocol_versions_calibration_is_zero
    check (emission_algorithm <> 'zero-reward-calibration-v1' or (epoch_emission_points = 0 and floor_points = 0 and role = 'calibration')),
  -- DEVELOPMENT EPOCHS ARE NOT FUTURE TOKEN CLAIMS.
  add constraint mining_protocol_versions_development_not_claimable
    check (network <> 'development' or claimable = false);

comment on column public.mining_protocol_versions.role is
  'network: what the network mines under (at most one active). calibration: a zero-reward disposition applied to one owner-approved development epoch.';
comment on column public.mining_protocol_versions.claimable is
  'Whether epochs settled under this version may ever enter a wallet claim snapshot, genesis allocation, airdrop, conversion or on-chain claim root. Development versions are never claimable.';

-- Exactly one ACTIVE network protocol at a time. Calibration versions are
-- active dispositions, not the network protocol, and do not count.
create unique index if not exists mining_protocol_versions_one_active_network
  on public.mining_protocol_versions ((role)) where status = 'active' and role = 'network';

-- The development calibration disposition (M15D). ACTIVE so it can be
-- applied; role calibration so it is never "the current protocol".
insert into public.mining_protocol_versions
  (version, epoch_duration_seconds, epoch_emission_points, scoring_version, pricing_version,
   effective_from, network, status, emission_algorithm, baseline_compute_pico, floor_points,
   undistributed_policy, role, claimable, effective_from_epoch)
values
  ('mining-dev-calibration-v1', 86400, 0, 'usage_score_v1', 'usage-pricing-v2',
   '2026-09-10', 'development', 'active', 'zero-reward-calibration-v1', null, 0,
   'never_minted', 'calibration', false, 'epoch-2026-09-10')
on conflict (version) do nothing;

-- The beta protocol, DRAFT: may be simulated and previewed, cannot settle.
insert into public.mining_protocol_versions
  (version, epoch_duration_seconds, epoch_emission_points, scoring_version, pricing_version,
   effective_from, network, status, emission_algorithm, baseline_compute_pico, floor_points,
   undistributed_policy, role, claimable, effective_from_epoch)
values
  ('mining-beta-v2', 86400, 100000, 'usage_score_v2', 'usage-pricing-v3',
   '2099-01-01', 'development', 'draft', 'baseline-linear-v1', 1000000000000000, 0,
   'never_minted', 'network', false, null)
on conflict (version) do nothing;

-- 4. reward_epochs --------------------------------------------------------

alter table public.reward_epochs
  add column if not exists claimable boolean not null default false,
  add column if not exists network_compute_pico numeric(38,0),
  add column if not exists effective_pool_points bigint,
  add column if not exists undistributed_points bigint;

alter table public.reward_epochs
  add constraint reward_epochs_effective_pool_le_scheduled
    check (effective_pool_points is null or (effective_pool_points >= 0 and effective_pool_points <= reward_pool_points)),
  add constraint reward_epochs_undistributed_is_remainder
    check (undistributed_points is null or effective_pool_points is null or undistributed_points = reward_pool_points - effective_pool_points),
  add constraint reward_epochs_network_compute_pico_integral
    check (network_compute_pico is null or (network_compute_pico >= 0 and network_compute_pico = trunc(network_compute_pico))),
  -- DEVELOPMENT EPOCHS ARE NOT FUTURE TOKEN CLAIMS.
  add constraint reward_epochs_development_not_claimable
    check (epoch_kind <> 'development' or claimable = false);

comment on column public.reward_epochs.reward_pool_points is
  'SCHEDULED cap for the epoch. fixed-pool-v1 distributes it in full; baseline-linear-v1 distributes effective_pool_points and never mints the rest; zero-reward-calibration-v1 is 0.';
comment on column public.reward_epochs.protocol_version is
  'mining_protocol_versions.version the epoch was settled under: its emission rule. Stamped mining-dev-v1 on every epoch settled before 0019.';
comment on column public.reward_epochs.claimable is
  'Whether this epoch may ever enter a future claim snapshot. False for every development epoch by constraint.';

-- Stamp history ONCE, while the 0018 trigger does not yet guard these
-- columns. Every epoch that exists at apply time was settled (or opened)
-- under the fixed 100,000-point mining-dev-v1 pool; that is a fact about
-- the past being recorded, not a change to it.
update public.reward_epochs
   set protocol_version = coalesce(protocol_version, 'mining-dev-v1'),
       pricing_version = coalesce(pricing_version, 'usage-pricing-v2'),
       effective_pool_points = coalesce(effective_pool_points, reward_pool_points),
       undistributed_points = coalesce(undistributed_points, 0),
       claimable = false
 where state = 'settled';

alter table public.reward_epochs
  -- From now on a settled epoch always says which rule emitted its points.
  add constraint reward_epochs_settled_has_protocol
    check (state <> 'settled' or protocol_version is not null);

-- 5. immutability: extend the 0018 triggers to the new columns -------------

create or replace function public.usage_events_settled_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.economic_status = 'settled' then
      raise exception 'usage_events %: a settled economic unit cannot be deleted', old.id using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'usage_events %: user_id is immutable', old.id using errcode = 'restrict_violation';
  end if;
  if old.economic_status = 'settled' then
    if new.economic_status is distinct from old.economic_status
       or new.reward_status is distinct from old.reward_status
       or new.reward_policy_version is distinct from old.reward_policy_version
       or new.eligible_compute_micros is distinct from old.eligible_compute_micros
       or new.protocol_compute_micros is distinct from old.protocol_compute_micros
       or new.protocol_pricing_version is distinct from old.protocol_pricing_version
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
       or new.economic_verification_policy_version is distinct from old.economic_verification_policy_version
       -- 0019
       or new.protocol_compute_pico is distinct from old.protocol_compute_pico
       or new.eligible_compute_pico is distinct from old.eligible_compute_pico
       or new.pricing_components_pending is distinct from old.pricing_components_pending then
      raise exception 'usage_events %: economic columns of a settled row are immutable', old.id using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.reward_epochs_settled_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.state = 'settled' then
      raise exception 'reward_epochs %: a settled epoch cannot be deleted', old.id using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if old.state <> 'settled' then
    return new;
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
     or new.epoch_kind is distinct from old.epoch_kind
     -- 0019
     or new.pricing_version is distinct from old.pricing_version
     or new.protocol_version is distinct from old.protocol_version
     or new.claimable is distinct from old.claimable
     or new.network_compute_pico is distinct from old.network_compute_pico
     or new.effective_pool_points is distinct from old.effective_pool_points
     or new.undistributed_points is distinct from old.undistributed_points then
    raise exception 'reward_epochs %: a settled epoch is immutable', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- Versions that have settled an epoch are frozen except for status.
create or replace function public.mining_protocol_versions_frozen()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.reward_epochs where protocol_version = old.version) then
      raise exception 'mining_protocol_versions: % has settled epochs and cannot be deleted', old.version using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if exists (select 1 from public.reward_epochs where protocol_version = old.version and state = 'settled')
     and (new.epoch_emission_points is distinct from old.epoch_emission_points
          or new.scoring_version is distinct from old.scoring_version
          or new.pricing_version is distinct from old.pricing_version
          or new.emission_algorithm is distinct from old.emission_algorithm
          or new.baseline_compute_pico is distinct from old.baseline_compute_pico
          or new.floor_points is distinct from old.floor_points
          or new.undistributed_policy is distinct from old.undistributed_policy
          or new.role is distinct from old.role
          or new.claimable is distinct from old.claimable
          or new.network is distinct from old.network) then
    raise exception 'mining_protocol_versions: % has settled epochs and is immutable except for status', old.version using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists mining_protocol_versions_frozen on public.mining_protocol_versions;
create trigger mining_protocol_versions_frozen
  before update or delete on public.mining_protocol_versions
  for each row execute function public.mining_protocol_versions_frozen();

-- 6. the historical audit, from persisted data only -------------------------

create or replace function public.audit_epoch(p_epoch_id text)
returns table (
  epoch_id text, state text, epoch_kind text,
  scoring_version text, pricing_version text, protocol_version text,
  emission_algorithm text, scheduled_points bigint, effective_points bigint,
  network_score numeric, distributed_points bigint, ledger_points bigint,
  claimable boolean, protocol_claimable boolean, protocol_role text
)
language sql stable as $$
  select e.id, e.state::text, e.epoch_kind,
         e.scoring_version, coalesce(e.pricing_version, p.pricing_version), e.protocol_version,
         p.emission_algorithm, e.reward_pool_points, coalesce(e.effective_pool_points, e.reward_pool_points),
         e.network_score,
         coalesce((select sum(points) from public.reward_allocations a where a.epoch_id = e.id), 0)::bigint,
         coalesce((select sum(amount) from public.usage_point_ledger l where l.epoch_id = e.id), 0)::bigint,
         e.claimable, p.claimable, p.role
    from public.reward_epochs e
    left join public.mining_protocol_versions p on p.version = e.protocol_version
   where e.id = p_epoch_id;
$$;

-- 7. settlement check for baseline-linear-v1 epochs -------------------------

create or replace function public.check_v2_epoch_settleable(p_epoch_id text)
returns table (invariant text, ok boolean, detail text)
language sql stable as $$
  with e as (select * from public.reward_epochs where id = p_epoch_id),
       p as (select * from public.mining_protocol_versions where version = (select protocol_version from e)),
       units as (
         select user_id, eligible_compute_pico, reward_status, economic_event_key, dedupe_status
         from public.usage_events where epoch_id = p_epoch_id and reward_status = 'eligible'
       ),
       n as (select coalesce(sum(eligible_compute_pico), 0) as network from units)
  select 'epoch exists', exists (select 1 from e), p_epoch_id
  union all select 'epoch is finalizing', (select state = 'finalizing' from e), (select state::text from e)
  union all select 'protocol version active and network role', (select status = 'active' and role = 'network' from p), (select concat_ws(',', status, role) from p)
  union all select 'protocol is baseline-linear-v1', (select emission_algorithm = 'baseline-linear-v1' from p), (select emission_algorithm from p)
  union all select 'epoch bound to protocol versions',
    (select e.scoring_version = p.scoring_version and e.pricing_version = p.pricing_version from e, p),
    (select concat_ws(',', e.scoring_version, e.pricing_version, e.protocol_version) from e)
  union all select 'pricing version frozen or active',
    (select status in ('frozen', 'active') from public.protocol_pricing_versions where version = (select pricing_version from e)),
    (select status from public.protocol_pricing_versions where version = (select pricing_version from e))
  union all select 'no duplicate economic keys in epoch',
    (select count(*) = 0 from (select economic_event_key from units where economic_event_key is not null group by 1 having count(*) > 1) d), ''
  union all select 'every eligible unit is unique-deduped', (select coalesce(bool_and(dedupe_status = 'unique'), true) from units), ''
  union all select 'every eligible unit carries pico', (select coalesce(bool_and(eligible_compute_pico is not null), true) from units), ''
  union all select 'no ledger rows for epoch yet', (select count(*) = 0 from public.usage_point_ledger where epoch_id = p_epoch_id), ''
  union all select 'effective pool <= scheduled',
    (select coalesce(effective_pool_points, 0) <= reward_pool_points from e), (select effective_pool_points::text from e)
  union all select 'effective pool = baseline-linear-v1(network)',
    (select e.effective_pool_points = floor(e.reward_pool_points * least(n.network, p.baseline_compute_pico) / p.baseline_compute_pico) + p.floor_points from e, p, n),
    (select network::text from n);
$$;

-- 8. NO ECONOMIC BACKFILL. --------------------------------------------------
-- Historical rows keep protocol_compute_micros / eligible_compute_micros as
-- their authoritative v1 economics. §4's UPDATE records which rule settled
-- each historical epoch; it moves no points. An analytics-only pico backfill
-- is deliberately absent; if ever wanted it is a separate approved act that
-- excludes every settled row and every v1 epoch.

commit;

-- ROLLBACK (only before the first settlement that USES a 0019 column, i.e.
-- before the calibration close; afterwards the columns hold immutable history):
--   begin;
--   drop function if exists public.check_v2_epoch_settleable(text);
--   drop function if exists public.audit_epoch(text);
--   drop trigger if exists mining_protocol_versions_frozen on public.mining_protocol_versions;
--   drop function if exists public.mining_protocol_versions_frozen();
--   delete from public.mining_protocol_versions where version in ('mining-beta-v2', 'mining-dev-calibration-v1');
--   drop index if exists public.mining_protocol_versions_one_active_network;
--   alter table public.reward_epochs drop constraint reward_epochs_settled_has_protocol, drop constraint reward_epochs_development_not_claimable,
--     drop column claimable, drop column network_compute_pico, drop column effective_pool_points, drop column undistributed_points;
--   -- protocol_version / pricing_version stamps on settled epochs are harmless facts and may stay.
--   alter table public.mining_protocol_versions drop column emission_algorithm, drop column baseline_compute_pico, drop column floor_points,
--     drop column undistributed_policy, drop column role, drop column claimable, drop column effective_from_epoch;
--   alter table public.mining_protocol_versions drop constraint mining_protocol_versions_status_check;
--   alter table public.mining_protocol_versions add constraint mining_protocol_versions_status_check check (status in ('active','superseded'));
--   alter table public.score_records drop column weighted_compute_pico;
--   drop index if exists public.usage_events_epoch_eligible_pico_idx;
--   alter table public.usage_events drop column protocol_compute_pico, drop column eligible_compute_pico, drop column pricing_components_pending;
--   -- then re-create the 0018 versions of the two trigger functions.
--   commit;
--
-- LOCKING: ADD COLUMN, ADD CONSTRAINT (CHECK) and one UPDATE of one settled
-- epoch row. Brief ACCESS EXCLUSIVE locks on tables holding 6 event rows.
--
-- ECONOMIC IMPACT AT APPLY TIME: none. No score, allocation, ledger row or
-- epoch state changes. Two protocol rows are inserted: one calibration
-- disposition (zero emission) and one draft.
