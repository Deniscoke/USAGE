-- USAGE — reward eligibility, separated from proof truth.
--
-- Two different questions, and conflating them is how a metering system becomes
-- a printing press:
--
--   did this compute really happen?   -> proof_status   (evidence)
--   should it earn USAGE?             -> reward_status  (policy)
--
-- The protocol compute value deliberately ignores what anyone paid, so that two
-- identical requests mine identically. That is right for measurement and wrong
-- for economics: free hosted inference is real, provable compute that must not
-- pay, or farming it becomes the cheapest way to mine.
--
-- Nothing here downgrades proof evidence. A held reward keeps its signed
-- receipt and can be released by a later policy without re-proving anything.

-- ------------------------------------------------------ reward policy versions
--
-- Every economic decision records the policy that made it, so it stays
-- explainable and reproducible. Historical decisions are never silently
-- re-judged: a new policy applies to new records.
create table reward_policy_versions (
  version text primary key,
  effective_from date not null,
  status text not null,
  description text not null,
  created_at timestamptz not null default now(),
  check (status in ('active', 'superseded'))
);

insert into reward_policy_versions (version, effective_from, status, description) values
  ('usage-reward-policy-v0', '2026-09-01', 'superseded',
   'Pre-policy records. Economic status was decided by proof status alone; preserved so historical epochs stay reproducible.'),
  ('usage-reward-policy-v1', '2026-09-09', 'active',
   'Beta policy. Metered paid compute earns; free compute never does; anything unproven is held rather than paid or discarded.');

-- --------------------------------------------------- economics on a usage event
--
-- economic_source_class is ECONOMIC provenance, independent of proof provenance.
-- Derived server-side from trusted evidence only: a client never chooses it,
-- and a provider's word alone never establishes 'metered_paid' -- a malicious
-- user can control both their own endpoint and their USAGE account.
alter table usage_events
  add column if not exists economic_source_class text not null default 'unknown',
  -- Compute that actually counts toward mining. Zero whenever the reward is not
  -- eligible. Separate from protocol_compute_micros so a held record still says
  -- what it WOULD be worth, and releasing a hold is a policy decision rather
  -- than a re-measurement.
  add column if not exists eligible_compute_micros bigint not null default 0,
  add column if not exists reward_status text not null default 'held',
  add column if not exists reward_reason text,
  add column if not exists reward_policy_version text references reward_policy_versions (version);

alter table usage_events
  add constraint usage_events_economic_source_check
  check (economic_source_class in
    ('metered_paid', 'byok', 'subscription', 'free', 'promotional', 'unknown'));

alter table usage_events
  add constraint usage_events_reward_status_check
  check (reward_status in ('eligible', 'held', 'ineligible'));

alter table usage_events
  add constraint usage_events_eligible_compute_check
  check (eligible_compute_micros >= 0);

-- Backfill: every existing row keeps the decision it was actually made under,
-- labelled v0 so nobody mistakes it for a v1 judgement. Settled epochs must not
-- move, and re-judging history would move them.
update usage_events
set
  reward_policy_version = 'usage-reward-policy-v0',
  reward_reason = 'legacy_pre_policy',
  reward_status = case
    when economic_status in ('eligible', 'settled') then 'eligible'
    else 'held'
  end,
  eligible_compute_micros = case
    when economic_status in ('eligible', 'settled') then protocol_compute_micros
    else 0
  end
where reward_policy_version is null;

create index if not exists usage_events_reward_idx
  on usage_events (user_id, reward_status);

-- ------------------------------------------------------------ sybil hooks
--
-- Extension points only. Nothing reads these to make a decision yet, and
-- nothing should until there is a policy worth writing down. They exist now so
-- adding one later does not require migrating settled history.
alter table profiles
  add column if not exists identity_trust_level text not null default 'unverified';

alter table profiles
  add constraint profiles_identity_trust_check
  check (identity_trust_level in ('unverified', 'basic', 'verified', 'restricted'));

alter table provider_connections
  -- A stable, non-reversible fingerprint of the upstream account a credential
  -- belongs to, so one provider account cannot later be split across many USAGE
  -- accounts unnoticed. Never the credential, never anything reversible.
  add column if not exists provider_account_identity_hash text;

create index if not exists provider_connections_account_identity_idx
  on provider_connections (provider_account_identity_hash)
  where provider_account_identity_hash is not null;

-- ----------------------------------------------------------------------- RLS
alter table reward_policy_versions enable row level security;

create policy "reward policies are public" on reward_policy_versions for select using (true);

revoke insert, update, delete on table reward_policy_versions from anon, authenticated;
grant select on table reward_policy_versions to anon, authenticated;
grant all on table reward_policy_versions to service_role;

-- usage_events remains server-written (0002): a client cannot set its own
-- economic source, reward status or eligible compute, because it cannot write
-- the table at all.
