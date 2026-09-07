# STATE

## Current milestone

M4B — Trusted Hosted Mining. **Complete.** A request through the hosted gateway
produces a signed, CONFIRMED proof that anyone can verify with the public key.

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **YES** — `usage-denis-mitrovics-projects.vercel.app` |
| Real Supabase runtime | **YES** — migrations 0001-0005 applied, 9 tables live |
| GoTrue tested | **YES** — real sign-up, password sign-in, session, profile trigger |
| RLS runtime tested | **YES** — 23/23 through PostgREST with real user JWTs |
| Receipt signing | **YES** — Ed25519, key held only as a Vercel sensitive variable |
| First production-signed proof | **YES** — `gen_01M1YQ6ASABFFZVB0NK3KXYG7J` |
| First Claude Code hosted proof | **NO** — needs AI Gateway credit (free tier blocks Anthropic models) |
| Proof status | `confirmed` |
| Economic status | `pending_cost` — the Anthropic-compatible surface reports no cost |
| Cost reconciliation | seam exists; only `gateway_reported` implemented |
| Next blocker | AI Gateway credit, then Claude Code through the hosted gateway |

## First trusted proof

```
proof_status    : confirmed
economic_status : pending_cost
verification    : routed / pending
issuer          : usage://issuer/production   key: usage-prod-2026-09-07
canonical hash  : sha256:587d7b7a11f117d725f0e9356ecb902fd5216a019ff9eff49893bf5fd1666733
tokens          : 28 in / 0 cached / 16 out
cost            : unknown (unavailable)
signature       : VALID
```

Verified with nothing but the published public key from `/api/receipts/keys` —
no private key, no Supabase secret, no gateway key. Re-ingesting the same
generation left the event count at 1.

`pending_cost` is the correct outcome, not a shortfall: the proof is real and
signed, and no authoritative cost exists for it yet.

## Two bugs production found that local testing could not

- **The usage write never ran.** A serverless function freezes when its response
  completes, so the fire-and-forget observation write silently disappeared: a
  real request produced a generation and no proof. Now wrapped in Next's
  `after()`. A local dev server keeps running, which is exactly why this was
  invisible until it was hosted.
- **`assessTrust` accepted an unusable signing key.** It only checked the
  variable was non-empty, so a mistyped value made the deployment claim it could
  issue proofs and then throw on the first one. It now derives the public half to
  prove the key works, and reports plainly when it does not.

## Hosted Supabase verification (`npm run usage:verify-hosted`)

23 checks against the live project, all passing. It creates two throwaway users,
exercises the boundaries and deletes them again:

- GoTrue sign-up, password sign-in, session, `getUser()`
- `on_auth_user_created` creates the profile row
- service-role ingestion writes usage; the same generation cannot be stored twice
- unsigned ingestion stays `observed` / `ineligible`
- a user reads only their own usage, aggregates, scores, proofs and profile
- a client cannot insert usage or proofs, promote their own usage, or write
  scores or reward allocations (all `42501 permission denied`)
- a user cannot read a stored miner token hash, or see anyone else's credentials

## Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `/api/gateway/anthropic/[...path]` | miner credential | the gateway itself |
| `/api/gateway/trust` | none (redacted) | which trust signal failed, and why |
| `/api/receipts/keys` | none | published verification keys |

## Known limitations

- Nothing has earned: every proof is `pending_cost` until a cost resolver exists.
- Vercel OIDC deployment identity is not configured, so the signing key alone is
  the trust root. Adding `USAGE_VERCEL_OIDC_ISSUER` + project/owner ids layers a
  second, cryptographic signal on top.
- The Vercel project is not connected to GitHub; deploys are manual
  (`vercel deploy --prod`).
- `.usage/hosted-miner.json` holds a plaintext test miner token (gitignored).
  Revoke that credential once it is no longer needed.
- Local observations still land in `.usage/observations.jsonl` (gitignored),
  which is an inspection artifact, not proof storage.
- The Anthropic-compatible gateway surface returns no cost, so even a hosted
  Claude Code proof will be `confirmed` + `pending_cost` until a cost resolver
  exists. That is expected and acceptable: proof first, economics second.
- Rate limiting is per-process; hosted deployment needs a shared limiter.
- `database.types.ts` is hand-maintained until `db:types` can run.
- Codex is not implemented (still M5).

## Next recommended milestone

M5 — finish hosting with the credentials above and capture the first CONFIRMED
proof, then either Codex miner support or the first real cost resolver.

## Important local commands

```bash
npm run dev
npm run usage:signing-key                  # generate an issuer key pair
npm run usage:verify-receipt -- <file>     # verify a receipt with a public key
npm run usage:verify-hosted                # 23 runtime checks against hosted Supabase
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
npm run miner:summary                      # mining session summary
npm run usage:gateway:probe -- --confirm   # ONE real request, spends credits
npm test && npm run typecheck && npm run lint && npm run build
```
