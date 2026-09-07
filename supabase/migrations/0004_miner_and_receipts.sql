-- USAGE — miner credentials, proof hashes, and pending economic cost.

-- ------------------------------------------------------- miner credentials
--
-- The credential a miner client (Claude Code today, Codex later) presents to
-- the USAGE Gateway. It is NOT the AI Gateway key: users never hold our
-- upstream credential.
--
-- Only a hash is stored. The plaintext is shown once at creation and is
-- unrecoverable afterwards, so a database leak cannot be replayed against the
-- gateway.
create table usage_miner_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  name text not null default 'default',
  -- SHA-256 of the plaintext token. The token is 256 bits of CSPRNG output, so
  -- there is no dictionary to attack and no need for a slow KDF; a password
  -- would be a different story.
  token_hash text not null unique,
  -- Non-secret prefix so a user can tell their credentials apart in a list.
  token_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index usage_miner_credentials_user_idx on usage_miner_credentials (user_id);

alter table usage_miner_credentials enable row level security;

-- Users may see and revoke their own credentials. They may not create them
-- client-side (the server generates the secret) and must never read a hash.
create policy "read own miner credentials" on usage_miner_credentials
  for select using (auth.uid() = user_id);

create policy "revoke own miner credentials" on usage_miner_credentials
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on table usage_miner_credentials from anon, authenticated;
grant select (id, user_id, name, token_prefix, created_at, last_used_at, revoked_at)
  on table usage_miner_credentials to authenticated;
grant update (revoked_at, name) on table usage_miner_credentials to authenticated;
grant all on table usage_miner_credentials to service_role;

-- ------------------------------------------------------------- proof hashes
--
-- Tamper-evident provenance: a deterministic hash over the canonical, non-secret
-- receipt (see src/lib/domain/receipt.ts). Not a signature and not a chain --
-- the point is that a stored proof can be recomputed and compared.
alter table proof_records
  add column if not exists proof_hash text,
  -- Where the observation was made: only trusted hosted infrastructure can
  -- produce economically valid ROUTED evidence.
  add column if not exists trust_environment text;

create index if not exists proof_records_proof_hash_idx on proof_records (proof_hash);

-- ------------------------------------------------------- pending economic cost
--
-- Cost that belongs to otherwise-valid usage whose economic weight cannot yet be
-- established: the gateway reported no cost, or the observation came from
-- untrusted (development) infrastructure. Tracked separately so it is never
-- silently scored as zero dollars of real spend.
alter table score_records
  add column if not exists pending_cost_micros bigint not null default 0;
