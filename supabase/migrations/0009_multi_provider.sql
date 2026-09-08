-- USAGE — multi-provider platform.
--
-- Two things had to become first-class for USAGE to be genuinely
-- provider-neutral rather than a UI over one gateway:
--
--   1. WHICH GATEWAY executed a request. With one gateway it was implicit;
--      with two it is evidence, and it belongs on the record and in the receipt.
--   2. WHETHER a record might double-count compute already counted from
--      another source. The same work can arrive twice -- once routed, later in
--      a provider's own billing export -- and must never be rewarded twice.

-- ------------------------------------------------------------------ cost
--
-- Renamed to say what it is. This column has always held the authoritative
-- provider/gateway cost; "reported" read as if it might be a user's claim.
-- Mining has never used it and still does not: protocol_compute_micros is the
-- economic basis, this is audit and reconciliation.
alter table usage_events rename column reported_cost_micros to actual_cost_micros;

alter table usage_events
  add column if not exists actual_cost_basis text;

alter table usage_events
  add constraint usage_events_actual_cost_basis_check
  check (
    actual_cost_basis is null
    or actual_cost_basis in ('gateway_reported', 'provider_reported', 'estimated', 'unavailable')
  );

-- ---------------------------------------------------------------- gateway
--
-- Null means nobody executed it on the user's behalf: an import is a provider's
-- own record of work that already happened, not a routed request.
alter table usage_events
  add column if not exists gateway_id text;

create index if not exists usage_events_gateway_idx on usage_events (user_id, gateway_id);

-- --------------------------------------------------------- reconciliation
--
--   clear            no other source could plausibly cover this compute
--   matched          matched to another record; exactly one of them earns
--   possible_overlap overlaps a known window, not provably the same work
--   held             overlaps and cannot be separated: reward withheld
--   resolved         settled by a later rule
--
-- `reward_hold` (from 0006, unused until now) is what actually withholds the
-- credit. The proof stays confirmed either way -- withholding a reward is not
-- the same as doubting the evidence.
alter table usage_events
  add column if not exists reconciliation_status text not null default 'clear';

alter table usage_events
  add constraint usage_events_reconciliation_check
  check (reconciliation_status in ('clear', 'matched', 'possible_overlap', 'held', 'resolved'));

create index if not exists usage_events_reconciliation_idx
  on usage_events (user_id, reconciliation_status) where reconciliation_status <> 'clear';

-- ------------------------------------------------------------ provider routes
--
-- A provider is not a gateway. Anthropic is reachable through Vercel and
-- through OpenRouter; "Anthropic routed" alone would imply a direct Anthropic
-- integration that does not exist. So routes are their own rows: one per
-- (provider, gateway) pair, each with its own status.
create table provider_routes (
  provider_slug text not null references providers (slug) on delete cascade,
  gateway text not null,
  status text not null,
  auth_requirement text not null,
  cost_availability text not null,
  note text,
  updated_at timestamptz not null default now(),
  primary key (provider_slug, gateway),
  -- live: exercised in production. tested: implemented and covered by tests.
  -- configured: implemented with a credential present, not yet exercised.
  -- available: implemented and usable. coming_soon: declared, not implemented.
  check (status in ('live', 'tested', 'configured', 'available', 'coming_soon', 'unsupported')),
  check (cost_availability in ('authoritative', 'unavailable'))
);

-- The old boolean-ish columns conflated provider capability with gateway
-- implementation. Import capability stays on the provider (it is the
-- provider's own API); routing moves to provider_routes.
alter table providers drop column if exists routed_mining;
alter table providers drop column if exists verified_import;

alter table providers
  add column if not exists import_status text not null default 'coming_soon',
  add column if not exists import_source text,
  add column if not exists import_account_requirement text,
  add column if not exists import_granularity text,
  add column if not exists import_cost_availability text;

alter table providers
  add constraint providers_import_status_check
  check (import_status in ('live', 'tested', 'configured', 'available', 'coming_soon', 'unsupported'));

alter table providers
  add constraint providers_import_granularity_check
  check (
    import_granularity is null
    or import_granularity in ('per_generation', 'provider_aggregate')
  );

-- ----------------------------------------------------------------------- RLS
alter table provider_routes enable row level security;
create policy "provider routes are public" on provider_routes for select using (true);
revoke insert, update, delete on table provider_routes from anon, authenticated;
grant select on table provider_routes to anon, authenticated;
grant all on table provider_routes to service_role;
