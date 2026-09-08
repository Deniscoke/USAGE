-- Miner credentials carry explicit scopes.
--
-- A device credential was a bearer token with no stated limits. Nothing it
-- could reach was dangerous -- routing, config and heartbeat are the only
-- endpoints that accept it, and clients have no write privilege on usage tables
-- at all -- but "the endpoints happen not to exist" is a property of today's
-- code, not a property of the credential. The next endpoint somebody adds is
-- the one that makes an unscoped token a problem.
--
-- So the limits become data, checked on every request:
--
--   miner:route        send traffic through the user's connections
--   miner:config       read routing configuration for this device
--   miner:heartbeat    report that this device is alive, and which tools it runs
--   miner:rotate       replace this credential with a fresh one
--
-- Deliberately absent, and no scope exists to grant them: changing account
-- settings, retrieving a provider secret, creating a proof, altering a reward,
-- settling points, or reaching another user's data. Those are not things a
-- program on somebody's laptop gets to do, so they are not expressible here.

begin;

alter table public.usage_miner_credentials
  add column if not exists scopes text[] not null
    default array['miner:route', 'miner:config', 'miner:heartbeat', 'miner:rotate'];

comment on column public.usage_miner_credentials.scopes is
  'What this device credential may do. Never includes account, secret, proof, reward or settlement abilities -- no such scope exists.';

-- Existing devices get exactly the abilities they already had, named.
update public.usage_miner_credentials
   set scopes = array['miner:route', 'miner:config', 'miner:heartbeat', 'miner:rotate']
 where scopes is null or cardinality(scopes) = 0;

-- A scope outside the known set can never be stored, so a future bug cannot
-- widen a credential by writing a string nobody implemented.
alter table public.usage_miner_credentials
  drop constraint if exists usage_miner_credentials_scopes_known;

alter table public.usage_miner_credentials
  add constraint usage_miner_credentials_scopes_known check (
    scopes <@ array['miner:route', 'miner:config', 'miner:heartbeat', 'miner:rotate']::text[]
  );

-- Rotation replaces a credential rather than accumulating them: the row that
-- superseded this one, so an audit can follow the chain.
alter table public.usage_miner_credentials
  add column if not exists rotated_to uuid references public.usage_miner_credentials(id),
  add column if not exists rotated_at timestamptz;

comment on column public.usage_miner_credentials.rotated_to is
  'The credential that replaced this one. Set when a device rotates after its token was exposed.';

commit;
