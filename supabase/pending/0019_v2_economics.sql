-- 0019 — v2 economics: exact pico compute, versioned emission, epoch version binding
--
-- STATUS: PENDING. Lives in supabase/pending/ on purpose so that neither
-- `supabase db push` nor the PGlite chain picks it up. Applying it to
-- production is an owner decision (CLAUDE.md rule 13) and a separate act.
--
-- WHAT IT DOES (additive only; no row is rewritten, no history changes)
--   1. usage_events: authoritative v2 economics in pico-USD, beside the
--      legacy micro columns which stay authoritative for v1 forever.
--   2. score_records: the v2 score (Σ eligible pico) as an exact integer.
--   3. reward_epochs: binds every epoch to its scoring, pricing and emission
--      versions, and records the effective pool and the never-minted remainder.
--   4. mining_protocol_versions: allows a 'draft' status and carries the
--      emission parameters; inserts mining-beta-v2 as DRAFT (not active).
--   5. Extends the 0018 immutability triggers to the new columns.
--   6. A settlement check function the settle script must call before it
--      credits a v2 epoch.
--
-- WHAT IT DOES NOT DO
--   - It does not activate usage_score_v2, usage-pricing-v3 or mining-beta-v2.
--   - It does not touch epoch-2026-09-10, the M14C event (c75acc2e) or any
--     settled row, allocation or ledger entry.
--   - It backfills NO economic value. The optional analytics backfill at the
--     end is commented out and, if ever run, writes pico only for rows whose
--     epoch is still OPEN and whose reward has not been settled.
--
-- TYPES. One token at p micro-USD per million tokens is exactly p pico-USD.
-- A single event is bounded by bigint (9.22e18 pico = $9.2M), but a user's
-- day, a network day and an epoch total are not, and a future column type
-- change on a settled table would collide with the immutability triggers.
-- So every pico column is numeric(38,0): an exact integer with 38 digits
-- (10^26 USD), never a float, never rounded. The check constraints keep it
-- integral and non-negative.

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
  -- eligible never exceeds protocol value; both null for pre-v3 rows.
  add constraint usage_events_eligible_pico_le_protocol
    check (eligible_compute_pico is null or protocol_compute_pico is null or eligible_compute_pico <= protocol_compute_pico);

comment on column public.usage_events.protocol_compute_pico is
  'Exact protocol compute value in pico-USD (10^-12 USD), usage-pricing-v3+. NULL for rows priced under v1/v2, whose protocol_compute_micros stays authoritative.';
comment on column public.usage_events.eligible_compute_pico is
  'AUTHORITATIVE for usage_score_v2: pico-USD that the reward policy made eligible. NULL for v1 rows.';
comment on column public.usage_events.pricing_components_pending is
  'Token classes the pricing version could not price (e.g. {cacheRead}). Non-empty => pricing_status pending, event held whole (M15C partial-pricing decision A).';

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
  'usage_score_v2: the score IS this number (Σ eligible_compute_pico for the user and epoch). points mirrors it as micro for display. NULL for v1 rows.';

-- 3. reward_epochs --------------------------------------------------------

alter table public.reward_epochs
  add column if not exists emission_version text,
  add column if not exists network_compute_pico numeric(38,0),
  add column if not exists effective_pool_points bigint,
  add column if not exists undistributed_points bigint;

alter table public.reward_epochs
  add constraint reward_epochs_effective_pool_le_scheduled
    check (effective_pool_points is null or (effective_pool_points >= 0 and effective_pool_points <= reward_pool_points)),
  add constraint reward_epochs_undistributed_is_remainder
    check (undistributed_points is null or effective_pool_points is null or undistributed_points = reward_pool_points - effective_pool_points),
  add constraint reward_epochs_network_compute_pico_integral
    check (network_compute_pico is null or (network_compute_pico >= 0 and network_compute_pico = trunc(network_compute_pico)));

comment on column public.reward_epochs.reward_pool_points is 'SCHEDULED cap for the epoch. Under baseline-linear-v1 the amount distributed is effective_pool_points; the difference is never minted.';
comment on column public.reward_epochs.emission_version is 'mining_protocol_versions.version the epoch was settled under (mining-dev-v1 = fixed pool; mining-beta-v2 = baseline-linear-v1). NULL on historical rows means mining-dev-v1.';

-- 4. mining_protocol_versions --------------------------------------------

alter table public.mining_protocol_versions
  drop constraint if exists mining_protocol_versions_status_check;
alter table public.mining_protocol_versions
  add constraint mining_protocol_versions_status_check check (status in ('draft', 'active', 'superseded'));

alter table public.mining_protocol_versions
  add column if not exists emission_algorithm text not null default 'fixed-pool-v1',
  add column if not exists baseline_compute_pico numeric(38,0),
  add column if not exists floor_points bigint not null default 0,
  add column if not exists undistributed_policy text not null default 'distributed',
  add column if not exists effective_from_epoch text;

alter table public.mining_protocol_versions
  add constraint mining_protocol_versions_emission_algorithm_check check (emission_algorithm in ('fixed-pool-v1', 'baseline-linear-v1')),
  add constraint mining_protocol_versions_undistributed_check check (undistributed_policy in ('distributed', 'never_minted')),
  add constraint mining_protocol_versions_baseline_required
    check (emission_algorithm <> 'baseline-linear-v1' or (baseline_compute_pico is not null and baseline_compute_pico > 0));

-- DRAFT row. status = 'draft' means: may be simulated and previewed, cannot
-- settle. Activation = a later, explicit UPDATE of status and
-- effective_from_epoch, after this migration and the code deploy.
insert into public.mining_protocol_versions
  (version, epoch_duration_seconds, epoch_emission_points, scoring_version, pricing_version,
   effective_from, network, status, emission_algorithm, baseline_compute_pico, floor_points,
   undistributed_policy, effective_from_epoch)
values
  ('mining-beta-v2', 86400, 100000, 'usage_score_v2', 'usage-pricing-v3',
   '2099-01-01', 'development', 'draft', 'baseline-linear-v1', 1000000000000000, 0,
   'never_minted', null)
on conflict (version) do nothing;

-- Only one ACTIVE mining protocol at a time.
create unique index if not exists mining_protocol_versions_one_active
  on public.mining_protocol_versions ((status)) where status = 'active';

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
     or new.emission_version is distinct from old.emission_version
     or new.network_compute_pico is distinct from old.network_compute_pico
     or new.effective_pool_points is distinct from old.effective_pool_points
     or new.undistributed_points is distinct from old.undistributed_points then
    raise exception 'reward_epochs %: a settled epoch is immutable', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- 6. settlement check: the database's own copy of the §18 invariants --------
-- The settle script MUST call this and abort on any returned row before it
-- credits a v2 epoch. It reads only.

create or replace function public.check_v2_epoch_settleable(p_epoch_id text)
returns table (invariant text, ok boolean, detail text)
language sql stable as $$
  with e as (select * from public.reward_epochs where id = p_epoch_id),
       p as (select * from public.mining_protocol_versions where version = (select emission_version from e)),
       units as (
         select user_id, eligible_compute_pico, reward_status, economic_event_key, dedupe_status
         from public.usage_events where epoch_id = p_epoch_id and reward_status = 'eligible'
       ),
       n as (select coalesce(sum(eligible_compute_pico), 0) as network from units)
  select 'epoch exists', exists (select 1 from e), p_epoch_id
  union all select 'epoch is finalizing', (select state = 'finalizing' from e), (select state::text from e)
  union all select 'emission version active', (select status = 'active' from p), (select status from p)
  union all select 'epoch bound to protocol versions',
    (select scoring_version = p.scoring_version and pricing_version = p.pricing_version from e, p),
    (select concat_ws(',', e.scoring_version, e.pricing_version, e.emission_version) from e)
  union all select 'pricing version frozen or active',
    (select status in ('frozen', 'active') from public.protocol_pricing_versions where version = (select pricing_version from e)),
    (select status from public.protocol_pricing_versions where version = (select pricing_version from e))
  union all select 'no duplicate economic keys in epoch',
    (select count(*) = 0 from (select economic_event_key from units where economic_event_key is not null group by 1 having count(*) > 1) d), ''
  union all select 'every eligible unit is unique-deduped', (select bool_and(dedupe_status = 'unique') from units), ''
  union all select 'every eligible unit carries pico', (select bool_and(eligible_compute_pico is not null) from units), ''
  union all select 'no ledger rows for epoch yet', (select count(*) = 0 from public.usage_point_ledger where epoch_id = p_epoch_id), ''
  union all select 'effective pool <= scheduled',
    (select coalesce(effective_pool_points, 0) <= reward_pool_points from e), (select effective_pool_points::text from e)
  union all select 'effective pool = baseline-linear-v1(network)',
    (select e.effective_pool_points = floor(e.reward_pool_points * least(n.network, p.baseline_compute_pico) / p.baseline_compute_pico) + p.floor_points from e, p, n),
    (select network::text from n);
$$;

-- 7. NO ECONOMIC BACKFILL. --------------------------------------------------
-- Historical rows keep protocol_compute_micros / eligible_compute_micros as
-- their authoritative v1 economics. The following analytics-only backfill is
-- intentionally commented out; if ever run it must be a separate, approved
-- act and must exclude every settled row (the trigger above would refuse
-- them anyway) and every row in a v1 epoch.
--
-- update public.usage_events set protocol_compute_pico = ... where economic_status <> 'settled' and ...;

commit;

-- ROLLBACK (only before the first v2 settlement; afterwards the columns hold
-- immutable history and must stay):
--   begin;
--   drop function if exists public.check_v2_epoch_settleable(text);
--   delete from public.mining_protocol_versions where version = 'mining-beta-v2' and status = 'draft';
--   drop index if exists public.mining_protocol_versions_one_active;
--   alter table public.mining_protocol_versions drop column emission_algorithm, drop column baseline_compute_pico, drop column floor_points, drop column undistributed_policy, drop column effective_from_epoch;
--   alter table public.mining_protocol_versions drop constraint mining_protocol_versions_status_check;
--   alter table public.mining_protocol_versions add constraint mining_protocol_versions_status_check check (status in ('active','superseded'));
--   alter table public.reward_epochs drop column emission_version, drop column network_compute_pico, drop column effective_pool_points, drop column undistributed_points;
--   alter table public.score_records drop column weighted_compute_pico;
--   drop index if exists public.usage_events_epoch_eligible_pico_idx;
--   alter table public.usage_events drop column protocol_compute_pico, drop column eligible_compute_pico, drop column pricing_components_pending;
--   -- then re-create the 0018 versions of the two trigger functions.
--   commit;
--
-- LOCKING: every ALTER is ADD COLUMN (nullable or with a constant default)
-- or ADD CONSTRAINT with a CHECK, which PostgreSQL validates with a brief
-- ACCESS EXCLUSIVE lock and a table scan of 6 usage_events rows. Sub-second
-- on the current database.
--
-- ECONOMIC IMPACT: none at apply time. No score, allocation, ledger row or
-- epoch changes. mining-beta-v2 is inserted as DRAFT and cannot settle.
