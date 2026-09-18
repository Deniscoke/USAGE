-- USAGE — provider billing evidence (M17C). Additive only.
--
-- A third evidence lane, next to LOCAL TELEMETRY (0017) and ROUTED VERIFIED
-- COMPUTE (usage_events). This one holds aggregates a provider's own billing
-- system reports about the person's account, fetched by USAGE's server over an
-- authenticated call it made itself. It starts with GitHub Copilot personal
-- AI-credit usage (GET /users/{username}/settings/billing/ai_credit/usage).
--
-- WHAT IT IS: provider-authoritative billing evidence. Aggregates per day or
-- per month, per product/sku/model/unit. No request identity exists upstream,
-- so nothing here can be correlated with a request and nothing is.
--
-- WHAT IT IS NOT: Economic Compute. It never writes usage_events, never feeds
-- scoring, settlement, the ledger or the wallet, and `reward_eligible` is
-- pinned to false by a CHECK so no code path -- including the service role --
-- can mark a row otherwise. Enabling rewards for this lane would be a new,
-- separately approved migration, not a flag.
--
-- WHO WRITES: only server code after a direct, authenticated GitHub fetch
-- (src/lib/provider-billing/sync.ts). There is no API route that accepts
-- billing JSON from a browser or a miner; clients hold SELECT on their own rows
-- and nothing else.

-- ------------------------------------------------------------------ accounts
--
-- One row per connected provider billing account.
--
-- SYBIL NOTE: unique (provider, provider_principal_id) binds one GitHub account
-- to at most one USAGE account, for the life of the row -- a disconnect keeps
-- the row (and the binding), so the same GitHub account cannot be passed from
-- USAGE account to USAGE account to multiply anything later. This lane earns
-- nothing today; the constraint exists so that stays cheap to reason about if
-- that ever changes. Releasing a binding is an operator action.
create table if not exists public.provider_billing_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null,
  -- The provider's immutable numeric account id, as text. Canonical identity.
  provider_principal_id text not null,
  -- Mutable (GitHub users can rename). Informational, and used only as the
  -- {username} path value -- re-resolved from GET /user on every sync.
  provider_login text,
  billing_scope text not null default 'unknown',
  status text not null default 'connected',
  -- What the provider granted, as last observed (e.g. 'plan:read').
  permission_state text not null default 'unknown',
  -- ONE Vault/AES secret holding both tokens as a bundle, so a refresh-token
  -- rotation is a single write: the old pair stops working upstream the moment
  -- GitHub rotates, so the new pair must land together or not at all. Null
  -- once disconnected. Never a credential itself.
  token_secret_id uuid references public.provider_secrets (id) on delete set null,
  secret_backend text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  -- The REST API version this account was last read with.
  api_version text,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error_class text,
  last_manual_sync_at timestamptz,
  -- Short lease so a cron run and a manual refresh never refresh the same
  -- (rotating) refresh token concurrently.
  sync_lease_until timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_billing_accounts_provider_check check (provider in ('github')),
  constraint provider_billing_accounts_principal_check check (provider_principal_id ~ '^[0-9]{1,20}$'),
  constraint provider_billing_accounts_scope_check
    check (billing_scope in ('personal', 'no_data_or_managed', 'permission_insufficient', 'unavailable', 'unknown')),
  constraint provider_billing_accounts_status_check
    check (status in ('connected', 'degraded', 'needs_reauth', 'revoked')),
  constraint provider_billing_accounts_backend_check
    check (secret_backend is null or secret_backend in ('vault', 'aes')),
  constraint provider_billing_accounts_principal_key unique (provider, provider_principal_id),
  constraint provider_billing_accounts_user_key unique (user_id, provider)
);

create index if not exists provider_billing_accounts_sync_idx
  on public.provider_billing_accounts (status, last_sync_at);

-- ----------------------------------------------------------------- snapshots
--
-- Immutable audit of what the provider actually said. The exact response text
-- is kept (not jsonb) so its SHA-256 stays verifiable and every decimal stays
-- exactly as GitHub wrote it. The body is the billing aggregate only: it
-- names the GitHub login, which the owner already knows, and carries no token
-- and no header.
--
-- Deduplication: an identical response to the same request is recorded once
-- (unique on account, request key and hash). A CHANGED response is always a
-- new row, so a provider correction never overwrites the evidence it replaced.
create table if not exists public.provider_billing_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.provider_billing_accounts (id) on delete cascade,
  provider text not null,
  principal_id text not null,
  -- 'YYYY-MM' for a month request, 'YYYY-MM-DD' for a day request.
  request_key text not null,
  period_year integer not null,
  period_month integer,
  period_day integer,
  query_filters jsonb not null default '{}'::jsonb,
  api_version text not null,
  http_status integer not null,
  fetched_at timestamptz not null default now(),
  response_sha256 text not null,
  response_text text not null,
  constraint provider_billing_snapshots_sha_check check (response_sha256 ~ '^[0-9a-f]{64}$'),
  constraint provider_billing_snapshots_month_check check (period_month is null or period_month between 1 and 12),
  constraint provider_billing_snapshots_day_check check (period_day is null or period_day between 1 and 31),
  constraint provider_billing_snapshots_dedupe_key unique (account_id, request_key, response_sha256)
);

create index if not exists provider_billing_snapshots_account_idx
  on public.provider_billing_snapshots (account_id, fetched_at desc);

create or replace function public.provider_billing_snapshots_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A cascade from deleting the owning profile is the one legitimate removal
  -- (account deletion); it arrives with the account row already gone.
  if tg_op = 'DELETE' and not exists (
    select 1 from public.provider_billing_accounts a where a.id = old.account_id
  ) then
    return old;
  end if;
  raise exception 'provider_billing_snapshots is append-only: billing evidence is immutable'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists provider_billing_snapshots_append_only on public.provider_billing_snapshots;
create trigger provider_billing_snapshots_append_only
  before update or delete on public.provider_billing_snapshots
  for each row execute function public.provider_billing_snapshots_immutable();

-- -------------------------------------------------------------------- usage
--
-- Current normalized state, one row per identity. fetched_at is NOT part of
-- the identity, so re-polling the same period converges on the same row; a
-- changed value bumps `revision` and repoints `current_snapshot_id`, while
-- `first_snapshot_id` and every snapshot in between are kept.
--
-- Decimals: every provider number is stored twice -- the exact decimal text
-- from the response (authority) and a scaled integer for arithmetic
-- (micro-USD for money, micro-units for quantities). Never a float.
create table if not exists public.provider_billing_usage (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.provider_billing_accounts (id) on delete cascade,
  provider text not null,
  principal_id text not null,
  billing_scope text not null,
  period_kind text not null,
  period_start date not null,
  product text not null,
  sku text not null,
  model text not null,
  unit_type text not null,
  price_per_unit_text text not null,
  price_per_unit_micros bigint not null,
  gross_quantity_text text not null,
  gross_quantity_micro_units bigint not null,
  discount_quantity_text text not null,
  discount_quantity_micro_units bigint not null,
  net_quantity_text text not null,
  net_quantity_micro_units bigint not null,
  gross_amount_text text not null,
  gross_amount_micros bigint not null,
  discount_amount_text text not null,
  discount_amount_micros bigint not null,
  net_amount_text text not null,
  net_amount_micros bigint not null,
  authoritative boolean not null default true,
  economic_authority text not null default 'provider_billing',
  reward_eligible boolean not null default false,
  first_snapshot_id uuid not null references public.provider_billing_snapshots (id),
  current_snapshot_id uuid not null references public.provider_billing_snapshots (id),
  revision integer not null default 1,
  -- Set when a later response for the same period no longer lists this item
  -- (a provider correction that removed it). Cleared if it reappears. Rows
  -- are never deleted.
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_billing_usage_period_kind_check check (period_kind in ('day', 'month')),
  constraint provider_billing_usage_month_start_check
    check (period_kind <> 'month' or extract(day from period_start) = 1),
  constraint provider_billing_usage_scope_check check (billing_scope in ('personal')),
  constraint provider_billing_usage_authoritative_check check (authoritative = true),
  constraint provider_billing_usage_authority_check check (economic_authority = 'provider_billing'),
  -- The lane's defining invariant. Not a default a writer can override.
  constraint provider_billing_usage_reward_check check (reward_eligible = false),
  constraint provider_billing_usage_revision_check check (revision >= 1),
  constraint provider_billing_usage_identity_key unique
    (provider, principal_id, billing_scope, period_kind, period_start, product, sku, model, unit_type)
);

create index if not exists provider_billing_usage_account_period_idx
  on public.provider_billing_usage (account_id, period_kind, period_start);

-- ----------------------------------------------------------------------- RLS
--
-- Owner reads own rows; no client role writes anything. The service role
-- (server-side sync only) bypasses RLS to write.
alter table public.provider_billing_accounts enable row level security;
alter table public.provider_billing_snapshots enable row level security;
alter table public.provider_billing_usage enable row level security;

drop policy if exists provider_billing_accounts_owner_read on public.provider_billing_accounts;
create policy provider_billing_accounts_owner_read on public.provider_billing_accounts
  for select to authenticated using (user_id = auth.uid());

drop policy if exists provider_billing_snapshots_owner_read on public.provider_billing_snapshots;
create policy provider_billing_snapshots_owner_read on public.provider_billing_snapshots
  for select to authenticated using (
    exists (select 1 from public.provider_billing_accounts a where a.id = account_id and a.user_id = auth.uid())
  );

drop policy if exists provider_billing_usage_owner_read on public.provider_billing_usage;
create policy provider_billing_usage_owner_read on public.provider_billing_usage
  for select to authenticated using (
    exists (select 1 from public.provider_billing_accounts a where a.id = account_id and a.user_id = auth.uid())
  );

-- The second factor, as 0027 does for every per-user table (its coverage test
-- fails if a per-user table is added without this).
drop policy if exists "require second factor" on public.provider_billing_accounts;
create policy "require second factor" on public.provider_billing_accounts as restrictive for all to authenticated
  using ((select public.session_satisfies_second_factor()))
  with check ((select public.session_satisfies_second_factor()));
drop policy if exists "require second factor" on public.provider_billing_snapshots;
create policy "require second factor" on public.provider_billing_snapshots as restrictive for all to authenticated
  using ((select public.session_satisfies_second_factor()))
  with check ((select public.session_satisfies_second_factor()));
drop policy if exists "require second factor" on public.provider_billing_usage;
create policy "require second factor" on public.provider_billing_usage as restrictive for all to authenticated
  using ((select public.session_satisfies_second_factor()))
  with check ((select public.session_satisfies_second_factor()));

revoke all on public.provider_billing_accounts from anon, authenticated;
revoke all on public.provider_billing_snapshots from anon, authenticated;
revoke all on public.provider_billing_usage from anon, authenticated;

-- Accounts: column-level SELECT. The secret reference and the sync lease are
-- server bookkeeping; a browser has no reason to see even the opaque handle.
grant select (
  id, user_id, provider, provider_principal_id, provider_login, billing_scope, status,
  permission_state, access_token_expires_at, api_version, last_sync_at, last_success_at,
  last_error_class, disconnected_at, created_at, updated_at
) on public.provider_billing_accounts to authenticated;
grant select on public.provider_billing_snapshots to authenticated;
grant select on public.provider_billing_usage to authenticated;

grant all on table public.provider_billing_accounts to service_role;
grant all on table public.provider_billing_snapshots to service_role;
grant all on table public.provider_billing_usage to service_role;

-- ------------------------------------------------------- miner protocol v2
--
-- The server constant already advertises v2 (src/lib/miner/release.ts); the
-- reference table catches up. Informational: nothing enforces it.
insert into public.miner_protocol_versions (version, minimum_supported, released_at, notes)
values ('miner-protocol-v2', '0.4.0', '2026-09-18',
        'Local telemetry uploads, device signing keys and per-tool mappings.')
on conflict (version) do nothing;
