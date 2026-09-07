# STATE

## Current milestone

M5 — Economic Usage Mining V1. **Complete**, except the live Claude Code session,
which is blocked on AI Gateway credit (see *Blocker*).

Confirmed AI compute now becomes deterministic off-chain Usage Points:

```
confirmed signed proof → protocol compute value → daily mining score
                       → fixed-pool epoch settlement → Usage Points ledger
```

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **YES** |
| Real Supabase runtime | **YES** — migrations 0001-0006 applied |
| GoTrue / RLS runtime | **YES** — 31/31 hosted checks |
| Production receipt signing | **YES** — Ed25519, key only on the deployment |
| Protocol pricing | **YES** — `usage-pricing-v2` current, `v1` frozen and still resolvable |
| First production mined proof | **YES** — `gen_01M1YRG2S6FR63R22P51S1KHN5` |
| Epoch settlement + ledger | **YES** — pool distributed exactly, re-run credits 0 |
| Live Claude model mining | **YES** — anthropic/claude-3-haiku, routed/confirmed/eligible |
| Live Claude *Code* mining | **NO** — see Blocker |
| Network | development epoch only; **Usage Points — Beta** |

## First mined proof (production)

```
model            : nvidia/nemotron-3-nano-30b-a3b
generation       : gen_01M1YRG2S6FR63R22P51S1KHN5
tokens           : 24 in / 0 cached / 24 out
verification     : routed
proof_status     : confirmed        signature: VALID (usage-prod-2026-09-07)
protocol compute : 7 micro-USD      (usage-pricing-v1)
actual cost      : unavailable
economic_status  : eligible
daily score      : 2.6458           (usage_score_v1)
epoch            : epoch-2026-09-07, 100,000 points distributed, re-run credited 0
```

`eligible` with no actual cost is the milestone's central decision working as
intended: the protocol values verified compute, and a missing invoice says
nothing about whether the compute happened.

## Idempotency (explicit)

Verified on the hosted database, no model call:

```
first ingest inserted  : 1
second ingest inserted : 0
total records          : 1
```

## Live Claude proof (production)

```
model            : anthropic/claude-3-haiku      provider: anthropic
generation       : gen_01M1YSKKSGPBYJ6X5CQ3ENPQ6W   (streamed)
tokens           : 0 in / 0 cache read / 0 cache write / 10 out
verification     : routed        proof_status: confirmed
signature        : VALID (usage-prod-2026-09-07)
protocol compute : 13 micro-USD  (usage-pricing-v2)
actual cost      : unavailable
economic_status  : eligible
daily score      : 3.6056        (usage_score_v1)
```

Input tokens are recorded as 0 because that is what the upstream reported in
`message_start` for this model. USAGE records what was observed and never
substitutes an estimate.

## Blocker: Claude Code specifically

The team is **still on the AI Gateway free tier**, despite the credit purchase.
Of the 16 Anthropic models in the catalog, exactly one is reachable:

```
anthropic/claude-3-haiku     200 OK
anthropic/claude-haiku-4.5   403      anthropic/claude-sonnet-5    403
anthropic/claude-sonnet-4    403      anthropic/claude-sonnet-4.5  403
```

Balance is unchanged at $4.99 of free credit ($0.008 used), and there is only one
Vercel team (`denis-mitrovics-projects`), so the purchase did not land on the
account that holds the gateway key.

Claude Code was launched through the hosted gateway from an empty directory and
authenticated correctly, but `claude-3-haiku` (a March 2024 model) returns
upstream **500** on the tool-calling payload Claude Code sends. A single plain
streaming request to the same model through the same gateway succeeds — the
gateway is fine; the model is too old for an agentic client.

**To unblock:** confirm the credit purchase applied to the
`denis-mitrovics-projects` team, then re-run the launcher with
`anthropic/claude-haiku-4.5`.

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
- `.usage/hosted-miner.json` holds a plaintext test miner token (gitignored).

## Next recommended milestone

M6 — either Codex miner support over the same boundary, or the first real actual
cost resolver for reconciliation. Neither is required for mining to work.

## Important local commands

```bash
npm run dev
npm run usage:verify-hosted                # 31 runtime checks against hosted Supabase
npm run usage:pricing:snapshot -- <v>      # capture a new pricing snapshot
npm run usage:pricing:publish -- <v>       # mirror it into the database
npm run usage:settle-epoch [YYYY-MM-DD]    # settle an epoch into Usage Points
npm run usage:verify-receipt -- <file>     # verify a receipt with a public key
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
npm test && npm run typecheck && npm run lint && npm run build
```
