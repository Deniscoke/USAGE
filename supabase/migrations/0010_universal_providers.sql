-- USAGE — universal provider connections.
--
-- The product rule: if you use an AI provider, you should be able to connect
-- it. That means USAGE can no longer be a finite list of AI companies compiled
-- into the code.
--
-- The rule it must NOT break: connectable is not mining eligible. A connection
-- earns only when the evidence it produces meets the protocol's trust bar, and
-- nothing here weakens that bar.
--
-- The shape:
--   provider_definitions   what a provider IS       (shared, or user-created)
--   provider_connections   what a USER connected     (already exists, extended)
--   provider_secrets       encrypted credentials     (never plaintext)
--   provider_models        upstream model identity   (not protocol pricing)

-- ------------------------------------------------------ provider definitions
--
-- Official definitions are shared (owner_user_id null) and curated. A custom
-- definition belongs to the user who created it, so one person adding
-- "DeepSeek" does not publish a provider for everybody.
--
-- Capabilities are DISCOVERED, never declared by the user. Every flag defaults
-- to false: an unprobed provider is assumed to support nothing, because
-- assuming otherwise is how a connection ends up claiming to mine when it
-- cannot.
create table provider_definitions (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  display_name text not null,
  -- Registry family (anthropic, openai, ...) when this is a known lab. Null for
  -- a provider USAGE has no curated knowledge of.
  provider_family text,
  protocol text not null,
  -- official: curated by USAGE. community_supported: a known-compatible service.
  -- custom: created by a user for their own use.
  origin text not null default 'custom',
  default_base_url text,
  owner_user_id uuid references profiles (id) on delete cascade,

  supports_models boolean not null default false,
  supports_streaming boolean not null default false,
  supports_usage boolean not null default false,
  supports_request_identity boolean not null default false,
  supports_cost boolean not null default false,
  supports_cache_usage boolean not null default false,
  supports_reasoning_usage boolean not null default false,

  -- The strongest evidence this definition could ever produce. Routed for a
  -- protocol USAGE executes; reported for anything self-declared.
  verification_capability text not null default 'reported',
  status text not null default 'active',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (protocol in ('openai_compatible', 'anthropic_compatible', 'usage_import', 'custom_unsupported')),
  check (origin in ('official', 'community_supported', 'custom')),
  check (verification_capability in ('verified', 'routed', 'reported')),
  check (status in ('active', 'deprecated', 'blocked')),
  -- An official definition belongs to nobody; a custom one must have an owner.
  check ((origin = 'custom') = (owner_user_id is not null))
);

-- A slug is unique per owner, and once globally for official definitions.
create unique index provider_definitions_official_slug_idx
  on provider_definitions (slug) where owner_user_id is null;
create unique index provider_definitions_owned_slug_idx
  on provider_definitions (owner_user_id, slug) where owner_user_id is not null;

-- ---------------------------------------------------------- provider secrets
--
-- Encrypted with AES-256-GCM under a server-held key (see
-- src/lib/secrets/crypto.ts). The database never holds a usable credential:
-- a dump without the key is inert.
--
-- Deliberately its own table rather than a column on the connection, so the
-- ciphertext is never selected by an ordinary connection read, and so a future
-- move to Supabase Vault changes one table and one module.
--
-- NO client role has any privilege here. Not select, not insert. The only
-- reader is the service role, on the server, when it needs to make a request.
create table provider_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  -- Opaque ciphertext: v1.<iv>.<tag>.<ciphertext>.
  ciphertext text not null,
  -- Last four characters, so a UI can identify a key without holding it.
  hint text,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create index provider_secrets_user_idx on provider_secrets (user_id);

-- ------------------------------------------------------- provider connections
--
-- One row per credential a user connected. The definition says what the
-- provider is; this says what THIS user set up.
alter table provider_connections
  add column if not exists definition_id uuid references provider_definitions (id) on delete restrict,
  add column if not exists protocol text,
  add column if not exists base_url text,
  -- Handle into provider_secrets. Never a credential.
  add column if not exists secret_id uuid references provider_secrets (id) on delete set null,
  add column if not exists connection_status text not null default 'validating',
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists mining_eligibility text not null default 'unsupported',
  add column if not exists validated_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_error_code text;

alter table provider_connections
  add constraint provider_connections_protocol_check
  check (
    protocol is null
    or protocol in ('openai_compatible', 'anthropic_compatible', 'usage_import', 'custom_unsupported')
  );

-- Not collapsed into connected/not connected: "the credential is wrong" and
-- "this provider does not report usage" are different problems with different
-- fixes, and a user cannot act on a single red dot.
alter table provider_connections
  add constraint provider_connections_status_check
  check (connection_status in (
    'validating', 'active', 'limited', 'invalid_credentials',
    'unsupported_usage', 'pending_pricing', 'error', 'revoked'
  ));

alter table provider_connections
  add constraint provider_connections_mining_check
  check (mining_eligibility in ('eligible_route', 'pending_pricing', 'analytics_only', 'unsupported'));

create index if not exists provider_connections_definition_idx
  on provider_connections (definition_id);

-- ------------------------------------------------------------ provider models
--
-- Upstream model identity, kept separate from USAGE protocol model identity.
--
-- Model ids are NOT globally unique -- two providers can both serve
-- "llama-3.1-70b" at different prices from different weights. Canonical
-- identity is therefore (definition, upstream id), and `protocol_model_key`
-- is the deliberate, nullable bridge to a priced protocol model.
--
-- A null protocol_model_key means PENDING_PRICING, forever, until an approved
-- pricing snapshot covers it. That is the anti-fraud property: a custom
-- provider cannot declare its own prices and mine against them.
create table provider_models (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references provider_definitions (id) on delete cascade,
  upstream_model_id text not null,
  display_name text,
  -- Set only by trusted server-side mapping onto an approved pricing snapshot.
  protocol_model_key text,
  -- Whether the user selected this model for routing.
  enabled boolean not null default true,
  status text not null default 'discovered',
  discovered_at timestamptz not null default now(),

  unique (definition_id, upstream_model_id),
  check (status in ('discovered', 'enabled', 'disabled', 'unsupported'))
);

create index provider_models_definition_idx on provider_models (definition_id);

-- ----------------------------------------------------------------------- RLS
alter table provider_definitions enable row level security;
alter table provider_secrets enable row level security;
alter table provider_models enable row level security;

-- Official definitions are public; a custom definition is visible only to the
-- user who created it.
create policy "read official or own definitions" on provider_definitions
  for select using (owner_user_id is null or auth.uid() = owner_user_id);

-- Models follow their definition's visibility.
create policy "read models of visible definitions" on provider_models
  for select using (
    exists (
      select 1 from provider_definitions d
      where d.id = provider_models.definition_id
        and (d.owner_user_id is null or d.owner_user_id = auth.uid())
    )
  );

-- provider_secrets has NO select policy and no client grant at all. There is
-- deliberately no path by which a signed-in user can read ciphertext, their own
-- included: they supplied the secret, they do not need it back, and a read path
-- is a leak waiting for a bug.

revoke all on table provider_secrets from anon, authenticated;
revoke insert, update, delete on table provider_definitions from anon, authenticated;
revoke insert, update, delete on table provider_models from anon, authenticated;

grant select on table provider_definitions to authenticated;
grant select on table provider_models to authenticated;
grant all on table provider_definitions to service_role;
grant all on table provider_models to service_role;
grant all on table provider_secrets to service_role;

-- ------------------------------------------- provider_connections is now server-written
--
-- 0002 granted clients full write access to their own connections, which was
-- harmless when a connection was just a label. It is not harmless now: a
-- client-written row could carry an arbitrary base_url (bypassing validation
-- and capability discovery) or declare its own mining_eligibility.
--
-- Connections are therefore created and updated only by trusted server code.
-- Clients keep read access, and may rename their own connection -- nothing
-- else, because nothing else is theirs to decide.
revoke insert, update, delete on table provider_connections from anon, authenticated;
grant update (account_label) on table provider_connections to authenticated;
