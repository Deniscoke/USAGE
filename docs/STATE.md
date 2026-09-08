# STATE

## Current milestone

M7 — Multi-provider platform. **Complete**, except two live runs blocked on
credentials nobody has configured yet (see *Credential blockers*).

USAGE is no longer one gateway with a UI around it: there are two real compute
gateways and one real verified-usage importer, and the mining engine cannot tell
them apart.

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **YES** — migrations 0001-0009 applied |
| GoTrue / RLS runtime | **YES** — 31/31 hosted checks |
| Production receipt signing | **YES** — Ed25519, `usage.receipt.v4` |
| Compute gateways | **2** — `vercel-ai-gateway` (live), `openrouter` (tested) |
| Verified importers | **1** — OpenAI Organization Usage API (tested) |
| Provider registry | 9 providers, 12 routes, published to the database |
| Provider ≠ gateway | **YES** — routes are per (provider, gateway) |
| Routing policy | deterministic, no silent mid-request failover |
| Cross-source reconciliation | **YES** — overlap holds the reward, keeps the proof |
| Epoch lifecycle | open / finalizing / settled, carry-forward |
| Live Claude *model* mining | **YES** — routed / confirmed / eligible |
| Live OpenRouter proof | **NO** — no `OPENROUTER_API_KEY` configured |
| Live OpenAI import | **NO** — no `OPENAI_ADMIN_KEY` configured |
| Network | development epoch only; **Usage Points — Beta** |

## Two gateways, one contract

```
/api/gateway/anthropic/*    Anthropic protocol  -> Vercel AI Gateway
/api/gateway/openrouter/*   OpenAI protocol     -> OpenRouter
```

Both routes are two lines of configuration over `createGatewayRoute`, which
holds the single trust boundary: miner authentication, rate limiting, trust
assessment, server-side attribution, streaming passthrough and `after()`
persistence. Contract tests run against every registered gateway, so a third is
held to the same bar by existing.

Deployed and verified: the OpenRouter surface authenticates a miner and then
answers `503 upstream (openrouter) is not configured` — it stops before spending
anything, which is the correct behaviour with no credential.

## The first verified import

OpenAI Organization Usage API (`/v1/organization/usage/completions`, plus
`/v1/organization/costs`), fetched server-side with an organization admin key.
Aggregated into time buckets, so identity is a SHA-256 over the authoritative
dimensions the API grouped by — organization, bucket, width, model, project,
user, api key, adapter version — and contains nothing about when the import ran.
Re-importing a window inserts zero rows.

An import is a different kind of Proof of Usage to a routed receipt, and the
product says so: `gatewayId` is null, granularity is `provider_aggregate`, and
the proof page names the source API. Consumer ChatGPT accounts cannot do this,
and the registry says that too.

## Never rewarded twice

The same compute can arrive routed and then again inside a provider's daily
total. Aggregates carry no request ids, so the rule refuses the ambiguity rather
than guessing: an aggregate import overlapping routed usage for the same
provider and UTC day is marked `held` with `reward_hold`, keeps its confirmed
signed proof, and is reported as pending rather than scored.

## Credential blockers

Everything is implemented and tested; two live runs need credentials:

```
OPENROUTER_API_KEY   server-only. Unblocks a live OpenRouter routed proof.
OPENAI_ADMIN_KEY     OpenAI ORGANIZATION ADMIN key, not an ordinary API key.
                     Unblocks a live verified organization import.
```

Add either to `.env.local` and to the Vercel project (sensitive, server-only).
Neither has been created and no paid request has been made.

## Known limitations

- Development epoch only. No public network exists; the UI says Beta.
- No live OpenRouter proof and no live OpenAI import yet — fixtures only.
- Provider admin credentials live in server environment configuration. Per-user
  provider credentials will need encrypted secret storage; `provider_connections`
  holds references, never secrets.
- Reconciliation is deliberately coarse: a same-day, same-provider overlap holds
  the whole aggregate. Nothing resolves a hold yet.
- `fraud_status` exists and is unused — deliberately no heuristics.
- Vercel OIDC deployment identity is not configured, so the signing key alone is
  the trust root.
- The Vercel project is not connected to GitHub; deploys are manual.
- Compute Credits and the payment ledger are types and docs only.
- `.usage/hosted-miner.json` holds a plaintext test miner token (gitignored).

## Next recommended milestone

M8 — resolve a hold rather than only detect one: reconcile an aggregate import
against the routed usage inside it and release the remainder. Or the USAGE Miner
as a real distributable, so "Enable Mining" ends in a working tool rather than a
copied key.

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
