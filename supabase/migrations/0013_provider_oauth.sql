-- USAGE — one-click provider connection (OAuth PKCE).
--
-- Pasting an API key is the single worst step in onboarding: it asks a
-- non-technical user to find a settings page, create a credential, understand
-- what it grants, and copy a secret between two websites.
--
-- Where a provider offers OAuth, none of that is necessary: the user clicks
-- Connect, signs in at the provider, approves, and comes back connected.
--
-- PKCE state has to live somewhere the browser cannot forge. A cookie would
-- work, but a server-side row binds the pending authorization to a user id that
-- the callback can verify independently of anything the browser sends back.

create table provider_oauth_requests (
  -- The `state` parameter. Random, single-use, and the only thing the provider
  -- hands back to identify the request.
  state text primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  provider_slug text not null,
  -- PKCE verifier. Never leaves the server; only its SHA-256 challenge is sent
  -- to the provider, so intercepting the redirect is not enough to steal the
  -- resulting credential.
  code_verifier text not null,
  redirect_to text,
  created_at timestamptz not null default now(),
  -- Authorization codes expire in ten minutes upstream; the pending request
  -- should not outlive them.
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz
);

create index provider_oauth_requests_user_idx on provider_oauth_requests (user_id);
create index provider_oauth_requests_expiry_idx on provider_oauth_requests (expires_at);

-- ----------------------------------------------------------------------- RLS
--
-- No client role has any privilege here, at all. The verifier is a secret for
-- the duration of the flow, and there is no reason a browser needs to read or
-- write this table -- it only ever carries the opaque `state` in a URL.
alter table provider_oauth_requests enable row level security;

revoke all on table provider_oauth_requests from anon, authenticated;
grant all on table provider_oauth_requests to service_role;

-- How a provider connection was authorized, so the product can say "connected
-- with OpenRouter" rather than implying a key was pasted.
alter table provider_connections
  add column if not exists auth_method text not null default 'api_key';

alter table provider_connections
  add constraint provider_connections_auth_method_check
  check (auth_method in ('api_key', 'oauth'));

-- Non-secret account context the provider reports about itself: spend totals,
-- credit limit, whether the account is on a free tier. Useful to show, and
-- `is_free_tier` is trusted economic evidence -- it comes from the provider,
-- not from the user.
alter table provider_connections
  add column if not exists account_context jsonb;
