# STATE

## Current milestone

M5B — Real Claude Code mining. Two tasks:

- **A. Claude subscription passthrough** — implemented and verified end to end.
  **Blocked externally**: Vercel refuses BYOK on the free tier.
- **B. Epoch lifecycle** — implemented, migrated, and verified.

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **YES** |
| Real Supabase runtime | **YES** — migrations 0001-0007 applied |
| GoTrue / RLS runtime | **YES** — 31/31 hosted checks |
| Production receipt signing | **YES** — Ed25519, key only on the deployment |
| Protocol pricing | **YES** — `usage-pricing-v2` current, `v1` frozen and still resolvable |
| Live Claude *model* mining | **YES** — anthropic/claude-3-haiku, routed/confirmed/eligible |
| Claude subscription passthrough | **CODE YES / UPSTREAM NO** — see Blocker |
| Epoch lifecycle open/finalizing/settled | **YES** |
| Deterministic epoch assignment + carry-forward | **YES** |
| Network | development epoch only; **Usage Points — Beta** |

## A. Claude subscription passthrough

Vercel documents two authentication shapes for Claude Code, and USAGE now
implements both. Which one applies is decided per request, from what the client
presented:

```
API key mode       Authorization: Bearer <AI_GATEWAY_API_KEY>
subscription mode  Authorization: <Claude's own credential, forwarded opaquely>
                   x-ai-gateway-api-key: Bearer <AI_GATEWAY_API_KEY>
```

Three identities, never merged:

1. the Claude subscription credential — authenticates the *user* to Anthropic;
2. the USAGE miner token (`x-usage-miner-token`) — authenticates the caller to
   *USAGE*, and is consumed and stripped at the boundary;
3. `AI_GATEWAY_API_KEY` — authenticates *USAGE* to Vercel, server-side only.

The subscription credential is treated as opaque cargo. It is never persisted,
logged, hashed into a proof, put in metadata, returned to a browser, or copied
into Supabase; `logGatewayRequest` now serializes an explicit field allowlist so
an accidental extra field cannot reach stdout. Tests assert all of it, including
that a valid subscription with no miner credential is rejected *before* any
upstream call — so an unidentified caller can never spend compute.

## B. Epoch lifecycle

The problem this fixes: an allocation id is `<epoch>:<user>` with a unique index
on the ledger, so an epoch credits exactly once — which meant settling an epoch
that was still collecting silently stranded every proof that arrived afterwards.

```
OPEN        accepts usage; live score; ESTIMATE only, ledger untouched
FINALIZING  stops accepting usage; allocations computed
SETTLED     allocations immutable; ledger credited exactly once
```

`settleEpoch` refuses an OPEN epoch (`not_finalizing`) and a SETTLED one
(`already_settled`). `npm run usage:settle-epoch` now runs the two phases
explicitly. Verified against production:

```
$ npm run usage:settle-epoch -- 2026-09-07
Refused: epoch-2026-09-07 is already settled.
Settled allocations are immutable; nothing was changed.
```

### Epoch assignment rule (v1)

An event belongs to exactly one epoch, decided once at ingestion and never
revised:

1. the epoch containing `occurred_at`;
2. if that epoch is no longer OPEN when the proof is ingested, the first OPEN
   epoch at or after the ingestion instant, marked `carried_forward`.

So late compute is never discarded and a settled allocation is never rewritten.
`usage_events.epoch_id` records the assignment and settlement works from it, not
from the timestamp. Daily aggregates stay keyed by occurrence day (they describe
usage as it happened); scores are keyed by assigned epoch (they are economic).

### Estimated versus settled

The dashboard shows both, and they never merge. Estimated Usage Points are a
projection from a live score against a fixed pool while the epoch is OPEN, and
are never written to the ledger. Settled Usage Points come only from a settled
epoch allocation.

## Blocker: the AI Gateway account is still free tier

One Claude Code session was launched from an empty temporary directory through
the hosted gateway, in subscription mode, with no model pinned. The chain worked:
Claude Code authenticated, USAGE forwarded the subscription credential to
`https://ai-gateway.vercel.sh/claude-code`, injected its own key in
`x-ai-gateway-api-key`, and Vercel replied:

```
403  Bring Your Own Key (BYOK) is available only with paid credits.
```

That is Vercel refusing subscription passthrough on a free-tier team — not a
routing, auth or model problem. The request produced no generation, so correctly
no usage event and no proof: a failed request is not evidence that compute
happened.

**To unblock:** purchase AI Gateway credits for `denis-mitrovics-projects`, then
re-run:

```powershell
$env:USAGE_MINER_TOKEN = "usgm_..."
./scripts/start-claude-miner.ps1 -GatewayUrl https://usage-ten.vercel.app/api/gateway/anthropic -Auth subscription
```

## Production state

```
epoch-2026-09-07   state=settled   pool=100,000   network score 3.6056

events
  inclusionai/ling-3.0-flash-fin    routed/pending_cost    0 uUSD
  nvidia/nemotron-3-nano-30b-a3b    routed/settled         7 uUSD  usage-pricing-v1
  anthropic/claude-3-haiku          routed/settled        13 uUSD  usage-pricing-v2

ledger  100,000 Usage Points, one allocation
```

`epoch-2026-09-08` has no record, which by the lifecycle rule means OPEN.

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
npm run usage:settle-epoch [YYYY-MM-DD]    # finalize, then settle, an epoch
npm run usage:verify-receipt -- <file>     # verify a receipt with a public key
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
npm test && npm run typecheck && npm run lint && npm run build
```
