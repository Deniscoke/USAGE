# STATE

## Current milestone

M6 — Product Platform. **Complete.** The proven engine is now a product a person
can use: sign up, choose an AI tool, enable mining, use AI, watch USAGE.

The proof/mining engine is unchanged. What is new is everything around it.

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **YES** |
| Real Supabase runtime | **YES** — migrations 0001-0008 applied |
| GoTrue / RLS runtime | **YES** — 31/31 hosted checks |
| Production receipt signing | **YES** — Ed25519, key only on the deployment |
| Protocol pricing | **YES** — `usage-pricing-v2` current, `v1` frozen and resolvable |
| Mining protocol config | **YES** — `mining-dev-v1`, versioned emission |
| Provider registry | **YES** — 9 providers, published to the database |
| Compute gateway abstraction | **YES** — 1 implementation (`vercel-ai-gateway`) |
| Import adapter boundary | **YES** — abstraction + registry, no external adapter yet |
| Epoch lifecycle | **YES** — open / finalizing / settled, carry-forward |
| Estimated vs settled balance | **YES** — separate everywhere, ledger only on settle |
| Live Claude *model* mining | **YES** — routed / confirmed / eligible |
| Claude subscription passthrough | **CODE YES / UPSTREAM NO** — free-tier BYOK block |
| Network | development epoch only; **Usage Points — Beta** |

## Product surfaces

```
/               USE AI. MINE USAGE.        (public)
/providers      coverage table, from the registry only  (public, static)
/onboarding     what AI do you use → Enable Mining
/dashboard      balance, mining status, activity, connected AI
/proofs/[id]    friendly Proof of Usage, with re-verified signature
/settings       account, connections, miner credentials, privacy
/api/miner/status   miner auth, routing config, liveness
```

`/onboarding`, `/dashboard`, `/settings` and `/proofs` are gated in the proxy and
by RLS.

## What the platform now guarantees

- **The registry cannot overstate itself.** A provider claiming routed mining
  "via" a gateway must name a gateway that exists; a test fails otherwise. Every
  `coming_soon` carries a reason, shown in the UI.
- **A miner cannot report its own numbers.** The miner API authenticates, hands
  back routing config and records liveness. There is no write path for tokens,
  cost, proof status, protocol compute or points, and there must never be one.
- **Estimated is not a balance.** Only a settled epoch credits the ledger.
- **The network denominator is real.** `epoch_network_totals` is an
  aggregate-only security-definer view; with one participant the share is
  honestly 100% and the UI says "development network".
- **Emission lives in one place.** `mining-dev-v1` carries epoch length,
  emission, scoring version and pricing version together.

## Known limitations

- Development epoch only. No public network exists; the UI says Beta.
- Actual gateway cost stays unavailable on the Anthropic-compatible surface. The
  cost resolver seam exists; only `gateway_reported` is implemented, and actual
  cost never changes a settled allocation under mining v1.
- `fraud_status` and `reward_hold` columns exist and are unused — deliberately no
  heuristics yet.
- Vercel OIDC deployment identity is not configured, so the signing key alone is
  the trust root.
- The Vercel project is not connected to GitHub; deploys are manual.
- No external import adapter is implemented. The boundary and registry exist;
  every provider's verified import is `coming_soon` and says so.
- Compute Credits and the payment ledger are types and docs only.
- `.usage/hosted-miner.json` holds a plaintext test miner token (gitignored).

## Next recommended milestone

M7 — the USAGE Miner as a real distributable (CLI or installer) so "Enable
Mining" ends in a working tool rather than a copied key, plus the first import
adapter to prove the pull boundary against a live provider API.

## Important local commands

```bash
npm run dev
npm run usage:verify-hosted                # 31 runtime checks against hosted Supabase
npm run usage:pricing:snapshot -- <v>      # capture a new pricing snapshot
npm run usage:pricing:publish -- <v>       # mirror it into the database
npm run usage:providers:publish            # mirror the provider registry
npm run usage:settle-epoch [YYYY-MM-DD]    # finalize, then settle, an epoch
npm run usage:verify-receipt -- <file>     # verify a receipt with a public key
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
npm test && npm run typecheck && npm run lint && npm run build
```
