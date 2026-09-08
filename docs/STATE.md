# STATE

## Current milestone

M8 — Universal provider connections. **Complete.**

A user can now connect a provider USAGE has never heard of, from the product,
with no environment variables and no terminal. Adding a provider requires no
change to the mining engine.

The rule it does not break: **connectable is not mining eligible.**

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **YES** — migrations 0001-0010 applied |
| GoTrue / RLS runtime | **YES** — 31/31 hosted checks |
| Production receipt signing | **YES** — Ed25519, `usage.receipt.v4` |
| Built-in compute gateways | **2** — `vercel-ai-gateway` (live), `openrouter` (tested) |
| Custom provider connections | **YES** — universal route, deployed |
| Routable protocols | **2** — OpenAI compatible, Anthropic compatible |
| Verified importers | **1** — OpenAI Organization Usage API (tested) |
| Credential encryption | **YES** — AES-256-GCM, key configured in production |
| SSRF protection | **YES** — 21 tests, DNS-resolved, redirect-rechecked |
| Capability discovery | **YES** — probed, never inferred from a name |
| Unknown model behaviour | confirmed proof, `pending_pricing`, earns nothing |
| Network | development epoch only; **Usage Points — Beta** |

## How a provider gets connected

```
/providers/add  →  name + protocol + base URL + API key
                →  SSRF guard validates the destination
                →  models probe authenticates and discovers models
                     (no inference request: testing cannot cost provider credit)
                →  credential encrypted, connection stored with a discovered
                   capability set and an honest mining outcome
```

Four honest outcomes, all of them valid:

```
eligible_route    usage + request identity + an approved price → earns
pending_pricing   provable compute, no approved price          → earns nothing
analytics_only    no usage, or no request identity             → earns nothing
unsupported       cannot be observed at all                    → earns nothing
```

## The universal route

```
/api/gateway/provider/[connectionId]/[...path]
```

One route for every provider a user connects. The client names a connection id,
never a URL: the server resolves it scoped to the authenticated user, checks
revocation, re-validates the destination, and decrypts the credential for that
one call. Deployed and verified — unauthenticated is 401 before any lookup, and
a connection belonging to someone else is 404, indistinguishable from one that
does not exist.

Everything after the observation is the pipeline that already existed. The
mining engine never learns which provider a request came from.

## Security posture changes

- `provider_connections` is now **server-written**. 0002 granted clients full
  write access, which was harmless when a connection was a label; it is not
  harmless now that a row carries a base URL and a mining eligibility. Clients
  keep read access and may rename their own connection.
- `provider_secrets` has **no client grant at all** — not even for the user who
  supplied the credential.
- `protocol_model_key` is server-only, so a custom provider cannot price itself
  into rewards.

## Known limitations

- Development epoch only. No public network exists; the UI says Beta.
- No live OpenRouter proof and no live OpenAI import — neither credential
  exists (`OPENROUTER_API_KEY`, `OPENAI_ADMIN_KEY`), and no paid request was
  made. No live custom-provider proof either, for the same reason.
- Credentials are encrypted with a server key rather than Supabase Vault. The
  schema is shaped for Vault; `secret_id` is opaque, so the swap is one module.
  Rotating `USAGE_SECRET_ENCRYPTION_KEY` orphans stored credentials.
- Capability discovery reads what a protocol documents plus what the models
  endpoint proves. Cache, reasoning and cost support are confirmed only when a
  real generation reports them; until then they show as unavailable.
- Model selection is discovered and stored, but there is no per-model
  enable/disable UI yet.
- Reconciliation is coarse: a same-day, same-provider overlap holds the whole
  aggregate. Nothing resolves a hold yet.
- Vercel OIDC deployment identity is not configured, so the signing key alone is
  the trust root.
- The Vercel project is not connected to GitHub; deploys are manual.
- `.usage/hosted-miner.json` holds a plaintext test miner token (gitignored).

## Next recommended milestone

M9 — resolve a reconciliation hold rather than only detect one, or a per-model
management surface so a user can choose which discovered models route through
USAGE. Neither blocks anything today.

## Important local commands

```bash
npm run dev
npm run usage:verify-hosted                # 31 runtime checks against hosted Supabase
npm run usage:pricing:snapshot -- <v>      # capture a new pricing snapshot
npm run usage:pricing:publish -- <v>       # mirror it into the database
npm run usage:providers:publish            # mirror the provider registry and routes
npm run usage:settle-epoch [YYYY-MM-DD]    # finalize, then settle, an epoch
npm run usage:verify-receipt -- <file>     # verify a receipt with a public key
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
npm test && npm run typecheck && npm run lint && npm run build
```
