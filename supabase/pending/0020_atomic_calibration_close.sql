-- 0020 — atomic development calibration close (M15E)
--
-- STATUS: PENDING. Not applied. 0019 is applied history and is not touched.
--
-- WHY. The application close path (src/lib/db/calibration-close.ts over the
-- Supabase settlement store) performs finalize, settle, allocation, event
-- status and postcondition checks as SEPARATE PostgREST requests, each its
-- own autocommitted transaction. A failure between two of them leaves a
-- partially committed epoch even though the application reports failure.
-- The first permanent settlement in USAGE must be all-or-nothing, so the
-- close becomes ONE PostgreSQL function: every read, lock, write and
-- postcondition runs inside one transaction, and any RAISE rolls back all
-- of it.
--
-- SCOPE. This is not a settlement override. It can close exactly one epoch,
-- epoch-2026-09-10, against the exact facts the owner approved on
-- 2026-09-10 (M15D), which are constants in the function body. The caller
-- supplies only the epoch id; every economic value is derived from the
-- database and compared with the constants. Anything else raises.
--
-- SECURITY. SECURITY INVOKER: the service role already owns every write the
-- function performs, so no privilege escalation is needed. search_path is
-- pinned. EXECUTE is revoked from PUBLIC, anon and authenticated and granted
-- only to service_role.
--
-- CONCURRENCY. pg_advisory_xact_lock(hashtext('usage:calibration-close'),
-- hashtext(p_epoch_id)) is taken first, before any read, and is held to the
-- end of the transaction. Two concurrent confirmations serialise: the second
-- waits, then sees a settled epoch and raises. The epoch row may not exist
-- yet, so the lock does not depend on SELECT ... FOR UPDATE of that row;
-- existing event, score, protocol and epoch rows are additionally locked
-- FOR UPDATE once the advisory lock is held.
--
-- FAULT INJECTION. `current_setting('usage.calibration_fail_after', true)`
-- is read once; when it names a stage the function raises right after that
-- stage. Only a session that can already execute the function can set it,
-- it can only cause a refusal, and it exists so the atomicity of every
-- stage is provable in tests against a real PostgreSQL.

begin;

create or replace function public.close_development_calibration_epoch(p_epoch_id text)
returns table (
  epoch_id text,
  state text,
  protocol_version text,
  scoring_version text,
  pricing_version text,
  network_score numeric,
  distributed_points bigint,
  ledger_points bigint,
  claimable boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  -- Owner-approved facts (M15D, 2026-09-10). Not parameters.
  c_epoch     constant text    := 'epoch-2026-09-10';
  c_day       constant date    := '2026-09-10';
  c_event     constant uuid    := 'c75acc2e-7f79-4161-b18f-3d8783561394';
  c_key       constant text    := 'ecu1:cf605dfe61da51020d3e406fba288c137d4b1059268e68064322a44d3a1a2107';
  c_user      constant uuid    := 'da93cec8-8f02-4fc7-b86a-d70be521a19f';
  c_proof     constant uuid    := 'b60f5602-9ea5-4292-a1c8-fda3e874c025';
  c_eligible  constant bigint  := 1;
  c_score     constant numeric := 1.0000;
  c_protocol  constant text    := 'mining-dev-calibration-v1';
  c_scoring   constant text    := 'usage_score_v1';
  c_pricing   constant text    := 'usage-pricing-v2';

  v_fail_after text;
  v_event   public.usage_events%rowtype;
  v_proof   public.proof_records%rowtype;
  v_score   numeric;
  v_proto   public.mining_protocol_versions%rowtype;
  v_epoch   public.reward_epochs%rowtype;
  v_ledger_rows  bigint;
  v_ledger_total bigint;
  v_balance      bigint;
  v_positive     bigint;
  v_rows         integer;
begin
  -- 0. Only the approved epoch, and only one closer at a time.
  if p_epoch_id is distinct from c_epoch then
    raise exception 'calibration close: % is not the owner-approved calibration epoch', p_epoch_id
      using errcode = 'restrict_violation';
  end if;
  perform pg_advisory_xact_lock(hashtext('usage:calibration-close'), hashtext(p_epoch_id));
  v_fail_after := current_setting('usage.calibration_fail_after', true);

  -- 1. Preconditions, all under row locks.
  -- The epoch first: a repeat attempt is refused as "already settled" before
  -- anything else is inspected.
  select * into v_epoch from public.reward_epochs where id = c_epoch for update;
  if found then
    if v_epoch.state = 'settled' then raise exception 'calibration close: % is already settled', c_epoch using errcode = 'restrict_violation'; end if;
    if v_epoch.epoch_kind <> 'development' then raise exception 'calibration close: % is not a development epoch', c_epoch using errcode = 'restrict_violation'; end if;
  end if;
  select * into v_event from public.usage_events where id = c_event for update;
  if not found then raise exception 'calibration close: approved event % is missing', c_event using errcode = 'restrict_violation'; end if;
  if v_event.user_id <> c_user then raise exception 'calibration close: event owner differs from the approved owner' using errcode = 'restrict_violation'; end if;
  if v_event.epoch_id is distinct from c_epoch then raise exception 'calibration close: event is assigned to %, not %', v_event.epoch_id, c_epoch using errcode = 'restrict_violation'; end if;
  if v_event.economic_event_key is distinct from c_key then raise exception 'calibration close: economic_event_key differs from the approved key' using errcode = 'restrict_violation'; end if;
  if v_event.dedupe_status is distinct from 'unique' then raise exception 'calibration close: event dedupe_status is %, expected unique', v_event.dedupe_status using errcode = 'restrict_violation'; end if;
  if v_event.eligible_compute_micros is distinct from c_eligible then raise exception 'calibration close: eligible_compute_micros is %, approved %', v_event.eligible_compute_micros, c_eligible using errcode = 'restrict_violation'; end if;
  if v_event.economic_status is distinct from 'eligible' then raise exception 'calibration close: event economic_status is %, expected eligible', v_event.economic_status using errcode = 'restrict_violation'; end if;
  if v_event.reward_status is distinct from 'eligible' then raise exception 'calibration close: event reward_status is %, expected eligible', v_event.reward_status using errcode = 'restrict_violation'; end if;
  if v_event.protocol_pricing_version is distinct from c_pricing then raise exception 'calibration close: event priced under %, approved %', v_event.protocol_pricing_version, c_pricing using errcode = 'restrict_violation'; end if;

  select * into v_proof from public.proof_records where id = c_proof and usage_event_id = c_event;
  if not found or v_proof.signature is null or v_proof.signature = '' then
    raise exception 'calibration close: approved proof % missing, detached or unsigned', c_proof using errcode = 'restrict_violation';
  end if;

  select points into v_score from public.score_records
   where user_id = c_user and day = c_day and algorithm_version = c_scoring for update;
  if v_score is distinct from c_score then
    raise exception 'calibration close: % score for % is %, approved %', c_scoring, c_day, v_score, c_score using errcode = 'restrict_violation';
  end if;

  select * into v_proto from public.mining_protocol_versions where version = c_protocol for share;
  if not found then raise exception 'calibration close: protocol % is not persisted', c_protocol using errcode = 'restrict_violation'; end if;
  if v_proto.status <> 'active' or v_proto.role <> 'calibration' or v_proto.epoch_emission_points <> 0
     or v_proto.claimable or v_proto.scoring_version <> c_scoring or v_proto.pricing_version <> c_pricing
     or v_proto.emission_algorithm <> 'zero-reward-calibration-v1' or v_proto.network <> 'development' then
    raise exception 'calibration close: protocol % is not the approved zero-reward calibration disposition', c_protocol using errcode = 'restrict_violation';
  end if;

  select count(*) into v_positive from public.reward_allocations where epoch_id = c_epoch and points > 0;
  if v_positive <> 0 then raise exception 'calibration close: % already has positive allocations', c_epoch using errcode = 'restrict_violation'; end if;

  select count(*), coalesce(sum(amount), 0) into v_ledger_rows, v_ledger_total from public.usage_point_ledger;
  select coalesce(sum(amount), 0) into v_balance from public.usage_point_ledger where user_id = c_user;

  -- 2. Writes. Every one is undone by any later RAISE.
  insert into public.reward_epochs
    (id, starts_at, ends_at, reward_pool_points, scoring_version, pricing_version, protocol_version,
     network_score, epoch_kind, state, finalizing_at, claimable, effective_pool_points, undistributed_points)
  values
    (c_epoch, c_day::timestamptz, (c_day + 1)::timestamptz, 0, c_scoring, c_pricing, c_protocol,
     c_score, 'development', 'finalizing', now(), false, 0, 0)
  on conflict (id) do update
    set reward_pool_points = 0, scoring_version = c_scoring, pricing_version = c_pricing, protocol_version = c_protocol,
        network_score = c_score, epoch_kind = 'development', state = 'finalizing',
        finalizing_at = coalesce(public.reward_epochs.finalizing_at, now()), claimable = false,
        effective_pool_points = 0, undistributed_points = 0;
  if v_fail_after = 'epoch' then raise exception 'calibration close: injected failure after epoch write'; end if;
  if v_fail_after = 'finalizing' then raise exception 'calibration close: injected failure after finalizing'; end if;

  update public.reward_epochs set state = 'settled', settled_at = now() where id = c_epoch;
  if v_fail_after = 'settled' then raise exception 'calibration close: injected failure after settled write'; end if;

  -- Zero-point allocation for auditability; never a ledger row.
  insert into public.reward_allocations (epoch_id, user_id, score, network_share, points)
  values (c_epoch, c_user, c_score, 1, 0);
  if v_fail_after = 'allocation' then raise exception 'calibration close: injected failure after allocation'; end if;

  update public.usage_events set economic_status = 'settled'
   where id = c_event and economic_status = 'eligible' and epoch_id = c_epoch;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'calibration close: expected to settle exactly one event, settled %', v_rows using errcode = 'restrict_violation'; end if;
  if v_fail_after = 'event' then raise exception 'calibration close: injected failure after event update'; end if;

  -- 3. Postconditions, inside the transaction, from fresh reads.
  select * into v_event from public.usage_events where id = c_event;
  if v_event.economic_status <> 'settled' or v_event.economic_event_key is distinct from c_key
     or v_event.eligible_compute_micros is distinct from c_eligible or v_event.protocol_pricing_version is distinct from c_pricing
     or v_event.user_id <> c_user or v_event.epoch_id is distinct from c_epoch then
    raise exception 'calibration close: postcondition failed on the event' using errcode = 'restrict_violation';
  end if;
  if not exists (select 1 from public.proof_records where id = c_proof and usage_event_id = c_event and signature is not null and signature <> '') then
    raise exception 'calibration close: postcondition failed on the proof' using errcode = 'restrict_violation';
  end if;
  select points into v_score from public.score_records where user_id = c_user and day = c_day and algorithm_version = c_scoring;
  if v_score is distinct from c_score then raise exception 'calibration close: postcondition failed on the score' using errcode = 'restrict_violation'; end if;

  select * into v_epoch from public.reward_epochs where id = c_epoch;
  if v_epoch.state <> 'settled' or v_epoch.epoch_kind <> 'development' or v_epoch.protocol_version <> c_protocol
     or v_epoch.claimable or v_epoch.reward_pool_points <> 0 or coalesce(v_epoch.effective_pool_points, -1) <> 0
     or coalesce(v_epoch.undistributed_points, -1) <> 0 or v_epoch.scoring_version <> c_scoring or v_epoch.pricing_version <> c_pricing
     or v_epoch.network_score <> c_score then
    raise exception 'calibration close: postcondition failed on the epoch' using errcode = 'restrict_violation';
  end if;

  if (select coalesce(sum(points), 0) from public.reward_allocations where epoch_id = c_epoch) <> 0
     or (select count(*) from public.reward_allocations where epoch_id = c_epoch and points > 0) <> 0 then
    raise exception 'calibration close: postcondition failed: positive allocation' using errcode = 'restrict_violation';
  end if;
  if (select count(*) from public.usage_point_ledger) <> v_ledger_rows
     or (select coalesce(sum(amount), 0) from public.usage_point_ledger) <> v_ledger_total then
    raise exception 'calibration close: postcondition failed: ledger changed' using errcode = 'restrict_violation';
  end if;
  if (select coalesce(sum(amount), 0) from public.usage_point_ledger where user_id = c_user) <> v_balance then
    raise exception 'calibration close: postcondition failed: settled balance changed' using errcode = 'restrict_violation';
  end if;
  if v_fail_after = 'postcondition' then raise exception 'calibration close: injected failure during final postcondition'; end if;

  -- 4. The persisted audit, consistent with audit_epoch().
  return query
    select a.epoch_id, a.state, a.protocol_version, a.scoring_version, a.pricing_version,
           a.network_score, a.distributed_points, a.ledger_points, a.claimable
      from public.audit_epoch(c_epoch) a;
end;
$$;

revoke execute on function public.close_development_calibration_epoch(text) from public;
revoke execute on function public.close_development_calibration_epoch(text) from anon;
revoke execute on function public.close_development_calibration_epoch(text) from authenticated;
grant execute on function public.close_development_calibration_epoch(text) to service_role;

comment on function public.close_development_calibration_epoch(text) is
  'M15E: atomic zero-reward close of the owner-approved development calibration epoch epoch-2026-09-10. All-or-nothing; service_role only; no caller-supplied economic values.';

commit;

-- ROLLBACK (safe at any time before the function has been invoked with --confirm;
-- afterwards the epoch it settled is immutable history and the function is inert):
--   drop function if exists public.close_development_calibration_epoch(text);
--
-- LOCKING: CREATE FUNCTION only. No table lock beyond the catalog.
-- ECONOMIC IMPACT AT APPLY TIME: none. The function does nothing until called.
