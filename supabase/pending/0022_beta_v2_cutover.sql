-- 0022 — mining-beta-v2 cutover: epoch-aware scheduling, pricing v3, atomic v2 settlement
--
-- STATUS: PENDING. Not applied. 0019 and 0020 are applied history and are
-- not touched. Applying this migration SCHEDULES the beta protocol for a
-- future UTC epoch; it does not activate anything for any epoch before that
-- boundary, and it settles nothing. The confirmed settlement of a v2 epoch
-- is a separate, later owner approval.
--
-- TARGET (owner decision, M16A): first mining-beta-v2 epoch = epoch-2026-09-14,
-- i.e. 2026-09-14T00:00:00Z. Valid only if the activation-compatible code and
-- this schema are deployed and verified by 2026-09-11T23:59:59Z; otherwise
-- the owner names a later epoch and the single UPDATE in §4 is edited before
-- apply. Nothing else in this file depends on the date.
--
-- WHAT IT DOES
--   1. status 'scheduled' for mining_protocol_versions: approved, bound to a
--      future epoch, not yet governing. Invariant: a network version that is
--      scheduled/active/superseded names its first epoch; drafts do not.
--   2. mining-dev-v1 stamped effective_from_epoch = epoch-2026-09-01 (its
--      recorded effective_from date). The genesis protocol governs every
--      earlier epoch too.
--   3. protocol_for_epoch(epoch_id): the database's own epoch-aware resolver,
--      identical in rule to src/lib/protocol/schedule.ts. A bound epoch row
--      wins; otherwise the latest scheduled/active/superseded NETWORK version
--      whose effective_from_epoch <= epoch_id; drafts never resolve.
--   4. usage-pricing-v3 registered and FROZEN with the M16A fresh-audit prices
--      (five first-party-priced models; see src/lib/pricing/usage-pricing-v3.ts
--      for sources and exclusions). mining-beta-v2 → status 'scheduled',
--      effective_from_epoch = the target.
--   5. settle_beta_v2_epoch(epoch_id): ONE transaction for a positive-ledger
--      settlement under baseline-linear-v1 (M15E showed why the multi-request
--      path is unsafe). Advisory lock, epoch must have ended (UTC), protocol
--      resolved and checked, every eligible unit exact-pico and priced under
--      the epoch's version, economic keys unique, stored v2 scores equal the
--      recomputed sums, effective pool = floor(cap × min(N,B)/B) + floor,
--      largest-remainder allocation summing exactly to the effective pool,
--      ledger rows only for positive points, events settled, postconditions,
--      audit returned. Any RAISE rolls back everything.
--      service_role only; caller supplies the epoch id and nothing else.
--
-- WHAT IT DOES NOT DO
--   - It does not settle any epoch, credit any point, or change any balance.
--   - It does not touch epoch-2026-09-07 or epoch-2026-09-10.
--   - It does not make development epochs claimable.

begin;

-- 1. 'scheduled' ----------------------------------------------------------

alter table public.mining_protocol_versions
  drop constraint if exists mining_protocol_versions_status_check;
alter table public.mining_protocol_versions
  add constraint mining_protocol_versions_status_check
    check (status in ('draft', 'scheduled', 'active', 'superseded'));

-- 2. genesis binding --------------------------------------------------------

update public.mining_protocol_versions
   set effective_from_epoch = 'epoch-2026-09-01'
 where version = 'mining-dev-v1' and effective_from_epoch is null;

alter table public.mining_protocol_versions
  add constraint mining_protocol_versions_network_needs_epoch
    check (role <> 'network' or status = 'draft' or effective_from_epoch is not null),
  add constraint mining_protocol_versions_epoch_id_shape
    check (effective_from_epoch is null or effective_from_epoch ~ '^epoch-\d{4}-\d{2}-\d{2}$');

-- One first epoch per network version: no two network versions may claim the same boundary.
create unique index if not exists mining_protocol_versions_one_per_epoch
  on public.mining_protocol_versions (effective_from_epoch)
  where role = 'network' and status <> 'draft';

-- 3. the resolver -----------------------------------------------------------

create or replace function public.protocol_for_epoch(p_epoch_id text)
returns public.mining_protocol_versions
language sql stable
set search_path = ''
as $$
  -- A bound epoch row is authoritative.
  select p.* from public.reward_epochs e
    join public.mining_protocol_versions p on p.version = e.protocol_version
   where e.id = p_epoch_id and e.protocol_version is not null
  union all
  -- Otherwise the latest network version not after the epoch; before the
  -- genesis version, the genesis version.
  (select p.* from public.mining_protocol_versions p
    where p.role = 'network' and p.status in ('scheduled', 'active', 'superseded')
      and p.effective_from_epoch is not null
      and not exists (select 1 from public.reward_epochs e where e.id = p_epoch_id and e.protocol_version is not null)
    order by (p.effective_from_epoch <= p_epoch_id) desc,
             case when p.effective_from_epoch <= p_epoch_id then p.effective_from_epoch end desc,
             p.effective_from_epoch asc
    limit 1)
  limit 1;
$$;

revoke execute on function public.protocol_for_epoch(text) from public;
grant execute on function public.protocol_for_epoch(text) to anon, authenticated, service_role;

-- 4. pricing v3 (frozen) and the beta schedule ------------------------------

insert into public.protocol_pricing_versions (version, source, effective_from, captured_at, status)
values ('usage-pricing-v3', 'provider first-party pricing pages, M16A audit 2026-09-10', '2026-09-14', '2026-09-10T19:20:00Z', 'frozen')
on conflict (version) do nothing;

insert into public.protocol_model_prices
  (pricing_version, model, provider_family, input_micros_per_million, output_micros_per_million,
   cache_read_micros_per_million, cache_write_micros_per_million, reasoning_micros_per_million)
values
  ('usage-pricing-v3', 'anthropic/claude-opus-5',     'anthropic', 5000000, 25000000, 500000, 6250000, null),
  ('usage-pricing-v3', 'anthropic/claude-sonnet-4.6', 'anthropic', 3000000, 15000000, 300000, 3750000, null),
  ('usage-pricing-v3', 'anthropic/claude-haiku-4.5',  'anthropic', 1000000,  5000000, 100000, 1250000, null),
  ('usage-pricing-v3', 'openai/gpt-5.4',              'openai',    2500000, 15000000, 250000, null,    null),
  ('usage-pricing-v3', 'openai/gpt-5-nano',           'openai',      50000,   400000,   5000, null,    null)
on conflict (pricing_version, model) do nothing;

-- The beta protocol: approved and SCHEDULED for the owner's target epoch.
-- Not active: protocol_for_epoch() returns it only for epochs at or after
-- the target, and only that makes any epoch resolve to it.
update public.mining_protocol_versions
   set status = 'scheduled',
       effective_from = '2026-09-14',
       effective_from_epoch = 'epoch-2026-09-14'
 where version = 'mining-beta-v2' and status = 'draft';

-- 5. atomic v2 settlement -----------------------------------------------------

create or replace function public.settle_beta_v2_epoch(p_epoch_id text)
returns table (
  epoch_id text, state text, protocol_version text, scoring_version text, pricing_version text,
  network_compute_pico numeric, scheduled_points bigint, effective_points bigint, undistributed_points bigint,
  distributed_points bigint, ledger_points bigint, participants bigint, claimable boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_day        date;
  v_starts     timestamptz;
  v_ends       timestamptz;
  v_proto      public.mining_protocol_versions%rowtype;
  v_epoch      public.reward_epochs%rowtype;
  v_pricing    text;
  v_network    numeric;
  v_effective  bigint;
  v_cap        bigint;
  v_baseline   numeric;
  v_bad        bigint;
  v_ledger_before bigint;
  v_ledger_after  bigint;
  v_alloc_sum     bigint;
  v_participants  bigint;
  v_epoch_exists  boolean;
begin
  if p_epoch_id !~ '^epoch-\d{4}-\d{2}-\d{2}$' then
    raise exception 'v2 settlement: % is not an epoch id', p_epoch_id using errcode = 'restrict_violation';
  end if;
  perform pg_advisory_xact_lock(hashtext('usage:v2-settlement'), hashtext(p_epoch_id));

  -- UTC boundaries from the epoch id alone; no session TimeZone involved.
  v_day    := substr(p_epoch_id, 7)::date;
  v_starts := make_timestamptz(extract(year from v_day)::int, extract(month from v_day)::int, extract(day from v_day)::int, 0, 0, 0, 'UTC');
  v_ends   := v_starts + interval '1 day';
  if now() < v_ends then
    raise exception 'v2 settlement: % has not ended (ends %)', p_epoch_id, v_ends using errcode = 'restrict_violation';
  end if;

  -- Protocol: bound row or resolver. Must be an active/scheduled network
  -- baseline-linear-v1 version whose first epoch is not after this one.
  select * into v_epoch from public.reward_epochs where id = p_epoch_id for update;
  v_epoch_exists := found;
  if v_epoch_exists and v_epoch.state = 'settled' then
    raise exception 'v2 settlement: % is already settled', p_epoch_id using errcode = 'restrict_violation';
  end if;
  select * into v_proto from public.protocol_for_epoch(p_epoch_id);
  if v_proto.version is null then raise exception 'v2 settlement: no protocol governs %', p_epoch_id using errcode = 'restrict_violation'; end if;
  if v_proto.role <> 'network' or v_proto.status not in ('scheduled', 'active') or v_proto.emission_algorithm <> 'baseline-linear-v1'
     or v_proto.scoring_version <> 'usage_score_v2' or v_proto.effective_from_epoch > p_epoch_id then
    raise exception 'v2 settlement: % is governed by %, which is not a live baseline-linear-v1 protocol', p_epoch_id, v_proto.version using errcode = 'restrict_violation';
  end if;
  if v_epoch_exists and (v_epoch.protocol_version is distinct from v_proto.version or v_epoch.epoch_kind <> v_proto.network) then
    raise exception 'v2 settlement: epoch row of % disagrees with the resolved protocol', p_epoch_id using errcode = 'restrict_violation';
  end if;
  v_pricing  := v_proto.pricing_version;
  v_cap      := v_proto.epoch_emission_points;
  v_baseline := v_proto.baseline_compute_pico;
  if v_baseline is null or v_baseline <= 0 then raise exception 'v2 settlement: protocol % has no baseline', v_proto.version using errcode = 'restrict_violation'; end if;
  if not exists (select 1 from public.protocol_pricing_versions where version = v_pricing and status in ('frozen', 'active')) then
    raise exception 'v2 settlement: pricing version % is not frozen or active', v_pricing using errcode = 'restrict_violation';
  end if;

  -- Units: every eligible unit in the epoch must be exact-pico, priced under
  -- the epoch's version, unique, with no pending component.
  select count(*) into v_bad from public.usage_events u
   where u.epoch_id = p_epoch_id and u.reward_status = 'eligible'
     and (u.eligible_compute_pico is null or u.protocol_pricing_version is distinct from v_pricing
          or u.dedupe_status <> 'unique' or coalesce(array_length(u.pricing_components_pending, 1), 0) > 0
          or u.economic_status not in ('eligible'));
  if v_bad > 0 then
    raise exception 'v2 settlement: % eligible unit(s) in % are not settleable (missing pico, foreign pricing version, non-unique, pending, or wrong status)', v_bad, p_epoch_id using errcode = 'restrict_violation';
  end if;
  select count(*) into v_bad from (
    select economic_event_key from public.usage_events
     where epoch_id = p_epoch_id and reward_status = 'eligible' and economic_event_key is not null
     group by economic_event_key having count(*) > 1) d;
  if v_bad > 0 then raise exception 'v2 settlement: duplicate economic keys in %', p_epoch_id using errcode = 'restrict_violation'; end if;
  if exists (select 1 from public.usage_point_ledger where epoch_id = p_epoch_id) then
    raise exception 'v2 settlement: ledger already holds rows for %', p_epoch_id using errcode = 'restrict_violation';
  end if;

  -- Scores: the stored v2 score rows must equal the recomputed exact sums,
  -- participant by participant, or settlement refuses.
  create temp table v2_participants on commit drop as
    select u.user_id, sum(u.eligible_compute_pico)::numeric(38,0) as pico
      from public.usage_events u
     where u.epoch_id = p_epoch_id and u.reward_status = 'eligible' and u.economic_status = 'eligible'
     group by u.user_id
    having sum(u.eligible_compute_pico) > 0;
  select count(*) into v_bad from v2_participants vp
    left join public.score_records s on s.user_id = vp.user_id and s.day = v_day and s.algorithm_version = 'usage_score_v2'
   where s.weighted_compute_pico is null or s.weighted_compute_pico <> vp.pico;
  if v_bad > 0 then
    raise exception 'v2 settlement: % participant score row(s) do not equal the recomputed exact sum', v_bad using errcode = 'restrict_violation';
  end if;
  select coalesce(sum(pico), 0), count(*) into v_network, v_participants from v2_participants;

  -- baseline-linear-v1, exact integer arithmetic.
  v_effective := floor(v_cap * least(v_network, v_baseline) / v_baseline)::bigint + v_proto.floor_points;
  if v_effective < 0 or v_effective > v_cap then raise exception 'v2 settlement: effective pool % outside [0, %]', v_effective, v_cap using errcode = 'restrict_violation'; end if;

  select count(*), coalesce(sum(amount), 0) into v_bad, v_ledger_before from public.usage_point_ledger;

  -- Epoch: finalizing, then settled, bound and non-claimable.
  insert into public.reward_epochs
    (id, starts_at, ends_at, reward_pool_points, scoring_version, pricing_version, protocol_version,
     network_score, network_compute_pico, epoch_kind, state, finalizing_at, claimable, effective_pool_points, undistributed_points)
  values
    (p_epoch_id, v_starts, v_ends, v_cap, v_proto.scoring_version, v_pricing, v_proto.version,
     (v_network / 1000000)::numeric(24,4), v_network, v_proto.network, 'finalizing', now(), false, v_effective, v_cap - v_effective)
  on conflict (id) do update
    set reward_pool_points = v_cap, scoring_version = v_proto.scoring_version, pricing_version = v_pricing, protocol_version = v_proto.version,
        network_score = (v_network / 1000000)::numeric(24,4), network_compute_pico = v_network, epoch_kind = v_proto.network,
        state = 'finalizing', finalizing_at = coalesce(public.reward_epochs.finalizing_at, now()), claimable = false,
        effective_pool_points = v_effective, undistributed_points = v_cap - v_effective;
  -- @stage finalizing

  -- Largest remainder in exact integer arithmetic: floor(effective × pico / N)
  -- per participant, then one extra point each to the largest remainders
  -- (ties by user id) until the floors sum to the effective pool.
  create temp table v2_alloc on commit drop as
    with base as (
      select user_id, pico,
             case when v_network > 0 then floor(v_effective * pico / v_network)::bigint else 0 end as floor_points,
             case when v_network > 0 then (v_effective * pico) - floor(v_effective * pico / v_network) * v_network else 0 end as remainder
        from v2_participants
    ), ranked as (
      select *, row_number() over (order by remainder desc, user_id asc) as rn,
             (select v_effective - coalesce(sum(floor_points), 0) from base) as leftover
        from base
    )
    select user_id, pico, floor_points + case when rn <= leftover then 1 else 0 end as points from ranked;

  select coalesce(sum(points), 0) into v_alloc_sum from v2_alloc;
  if v_alloc_sum <> v_effective then raise exception 'v2 settlement: allocations sum to %, effective pool is %', v_alloc_sum, v_effective using errcode = 'restrict_violation'; end if;

  update public.reward_epochs set state = 'settled', settled_at = now() where id = p_epoch_id;
  -- @stage settled

  insert into public.reward_allocations (epoch_id, user_id, score, network_share, points)
  select p_epoch_id, user_id, (pico / 1000000)::numeric(20,4),
         case when v_network > 0 then (pico / v_network)::numeric(12,10) else 0 end, points
    from v2_alloc;
  -- @stage allocation

  insert into public.usage_point_ledger (user_id, epoch_id, allocation_id, amount, reason)
  select user_id, p_epoch_id, p_epoch_id || ':' || user_id::text, points, 'epoch_settlement'
    from v2_alloc where points > 0;
  -- @stage ledger

  update public.usage_events set economic_status = 'settled'
   where epoch_id = p_epoch_id and economic_status = 'eligible' and reward_status = 'eligible';
  -- @stage events

  -- Postconditions, fresh reads.
  select count(*), coalesce(sum(amount), 0) into v_bad, v_ledger_after from public.usage_point_ledger;
  if v_ledger_after - v_ledger_before <> v_effective then
    raise exception 'v2 settlement: ledger delta % is not the effective pool %', v_ledger_after - v_ledger_before, v_effective using errcode = 'restrict_violation';
  end if;
  if (select coalesce(sum(amount), 0) from public.usage_point_ledger where epoch_id = p_epoch_id) <> v_effective then
    raise exception 'v2 settlement: epoch ledger rows do not sum to the effective pool' using errcode = 'restrict_violation';
  end if;
  if (select coalesce(sum(points), 0) from public.reward_allocations where epoch_id = p_epoch_id) <> v_effective then
    raise exception 'v2 settlement: allocations do not sum to the effective pool' using errcode = 'restrict_violation';
  end if;
  if exists (select 1 from public.reward_allocations a where a.epoch_id = p_epoch_id and a.points > 0
              and not exists (select 1 from public.usage_events u where u.epoch_id = p_epoch_id and u.user_id = a.user_id and u.economic_status = 'settled' and u.reward_status = 'eligible')) then
    raise exception 'v2 settlement: a positive allocation has no settled eligible unit behind it' using errcode = 'restrict_violation';
  end if;
  select * into v_epoch from public.reward_epochs where id = p_epoch_id;
  if v_epoch.state <> 'settled' or v_epoch.claimable or v_epoch.protocol_version <> v_proto.version
     or v_epoch.effective_pool_points <> v_effective or v_epoch.undistributed_points <> v_cap - v_effective
     or v_epoch.starts_at <> v_starts or v_epoch.ends_at <> v_ends then
    raise exception 'v2 settlement: postcondition failed on the epoch row' using errcode = 'restrict_violation';
  end if;
  -- @stage postcondition

  return query
    select a.epoch_id, a.state, a.protocol_version, a.scoring_version, a.pricing_version,
           v_network, a.scheduled_points, a.effective_points, v_cap - v_effective,
           a.distributed_points, a.ledger_points, v_participants, a.claimable
      from public.audit_epoch(p_epoch_id) a;
end;
$$;

revoke execute on function public.settle_beta_v2_epoch(text) from public;
revoke execute on function public.settle_beta_v2_epoch(text) from anon;
revoke execute on function public.settle_beta_v2_epoch(text) from authenticated;
grant execute on function public.settle_beta_v2_epoch(text) to service_role;

comment on function public.settle_beta_v2_epoch(text) is
  'M16A: atomic settlement of one ended mining-beta-v2 epoch under baseline-linear-v1. All-or-nothing; service_role only; caller supplies the epoch id and nothing else.';

commit;

-- ROLLBACK (before the first v2 settlement; afterwards settled epochs bound
-- to mining-beta-v2 are immutable history and the version must stay):
--   begin;
--   drop function if exists public.settle_beta_v2_epoch(text);
--   drop function if exists public.protocol_for_epoch(text);
--   update public.mining_protocol_versions set status = 'draft', effective_from = '2099-01-01', effective_from_epoch = null where version = 'mining-beta-v2';
--   update public.protocol_pricing_versions set status = 'superseded' where version = 'usage-pricing-v3';  -- rows are frozen by 0018 triggers; status is the only mutable field
--   drop index if exists public.mining_protocol_versions_one_per_epoch;
--   alter table public.mining_protocol_versions drop constraint mining_protocol_versions_network_needs_epoch, drop constraint mining_protocol_versions_epoch_id_shape;
--   alter table public.mining_protocol_versions drop constraint mining_protocol_versions_status_check;
--   alter table public.mining_protocol_versions add constraint mining_protocol_versions_status_check check (status in ('draft', 'active', 'superseded'));
--   -- mining-dev-v1.effective_from_epoch is a harmless fact and may stay.
--   commit;
--
-- LOCKING: constraint changes and two functions on tables with a handful of rows.
-- ECONOMIC IMPACT AT APPLY TIME: none. No epoch, allocation, ledger row or balance changes.
