-- 0024 — the wallet: money paid in, never points.
--
-- WHAT THIS IS
-- A ledger of CREDITS ONLY: grants USAGE makes, top-ups somebody paid for,
-- refunds and corrections. It is denominated in integer micro-USD, like every
-- other money column in this schema.
--
-- WHAT IT DELIBERATELY IS NOT
-- It is not a balance table, and it holds no debits. Spend is still derived
-- from `usage_events` -- the same persisted units everything else is measured
-- from -- so the balance shown to a person cannot drift from what their
-- traffic actually cost. Balance = sum(entries) - funded spend. One number,
-- two sources, neither of them a counter the chat maintains for itself.
--
-- AND IT IS NOT POINTS
-- Wallet credit buys inference. USAGE Points are an off-chain, non-transferable
-- reputation record with no monetary value. There is deliberately no column,
-- constraint or function anywhere that converts one into the other, and adding
-- one would turn Points into something purchasable with money. Do not add one.

create table if not exists public.usage_wallet_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- grant: USAGE's money, given. topup: somebody paid for it.
  -- refund: money given back, so the credit leaves (negative).
  -- adjustment: an operator correction, either direction, always with a note.
  kind text not null check (kind in ('grant', 'topup', 'refund', 'adjustment')),

  -- Signed integer micro-USD. Never zero: an entry that moves nothing is a
  -- bug, not a record.
  amount_micros bigint not null check (amount_micros <> 0),
  currency text not null default 'USD' check (currency = 'USD'),

  -- The idempotency key. For a payment this is the processor's intent id; for
  -- the starting grant it is the grant's version. The unique index below is
  -- what makes crediting the same payment twice impossible rather than
  -- merely unlikely.
  reference text,
  note text,

  created_at timestamptz not null default now(),
  -- 'system' for automatic grants, an operator identifier otherwise.
  created_by text not null default 'system'
);

-- A refund removes credit, a grant adds it. Anything else is a typo.
alter table public.usage_wallet_entries
  drop constraint if exists usage_wallet_entries_direction;
alter table public.usage_wallet_entries
  add constraint usage_wallet_entries_direction check (
    (kind in ('grant', 'topup') and amount_micros > 0)
    or (kind = 'refund' and amount_micros < 0)
    or kind = 'adjustment'
  );

create unique index if not exists usage_wallet_entries_reference_key
  on public.usage_wallet_entries (user_id, reference)
  where reference is not null;

create index if not exists usage_wallet_entries_user_created_idx
  on public.usage_wallet_entries (user_id, created_at desc);

alter table public.usage_wallet_entries enable row level security;

-- A person reads their own ledger and nothing else. Nobody writes from a
-- browser: credit is created by trusted server-side code only, the same rule
-- that keeps clients off the usage tables.
drop policy if exists "wallet entries are readable by their owner" on public.usage_wallet_entries;
create policy "wallet entries are readable by their owner"
  on public.usage_wallet_entries
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.usage_wallet_entries from authenticated, anon;
grant select on public.usage_wallet_entries to authenticated;

-- Trusted server-side code writes credit; nothing else does. Granted
-- explicitly rather than relying on a default privilege, the same way every
-- other table in this schema is granted.
grant all on table public.usage_wallet_entries to service_role;

comment on table public.usage_wallet_entries is
  'Credits only (grants, top-ups, refunds). Spend is derived from usage_events. Never convertible to USAGE Points.';
