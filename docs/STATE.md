# STATE

## Current milestone

M4B — Trusted Hosted Mining. **Supabase is live and verified. Vercel is not
deployed yet**, so no CONFIRMED proof exists (see *What I need from you*).

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **NO** — needs your Vercel login |
| Real Supabase runtime | **YES** — migrations 0001-0005 pushed, 9 tables live |
| GoTrue tested | **YES** — real sign-up, password sign-in, session, profile trigger |
| RLS runtime tested | **YES** — 23/23 checks through PostgREST with real user JWTs |
| Receipt signing | **YES** — Ed25519, signed and independently verified end to end locally |
| First production-signed proof | **NO** — no production key exists yet |
| First Claude Code hosted proof | **NO** — blocked on hosting |
| Proof status | all stored proofs are `observed` |
| Economic status | all `ineligible` or `pending_cost`; nothing has earned |
| Cost reconciliation | seam exists; only `gateway_reported` implemented; Anthropic surface reports no cost |
| Next blocker | **you: create the Vercel project and set the signing key** |

## Hosted Supabase verification (`npm run usage:verify-hosted`)

23 checks against the live project, all passing. It creates two throwaway users,
exercises the boundaries and deletes them again:

- GoTrue sign-up, password sign-in, session, `getUser()`
- `on_auth_user_created` creates the profile row
- service-role ingestion writes usage; the same generation cannot be stored twice
- unsigned ingestion stays `observed` / `ineligible` — as it must, since no
  production signing key exists yet
- a user reads only their own usage, aggregates, scores, proofs and profile;
  naming another user's id changes nothing
- a client cannot insert usage or proofs, promote their own usage, or write
  scores or reward allocations (all `42501 permission denied`)
- a user cannot read a stored miner token hash, or see anyone else's credentials

This is what PGlite could not prove: GoTrue, PostgREST and the platform's grants.

## What changed

- **Trust root moved off the environment flag.** `USAGE_TRUST_ENVIRONMENT` is
  now a diagnostic signal only. A proof is CONFIRMED only when signed by a key
  that exists solely on the hosted deployment. Tested: a local process that sets
  the flag, or even holds a key while observing in a development environment,
  cannot produce a confirmed proof.
- **Ed25519 receipt signing + verification.** `verifyUsageReceipt()` needs only
  the receipt and a public key — no database, no secrets. Any mutation of a
  signed field invalidates it.
- **Vercel deployment identity** (`x-vercel-oidc-token`) verified against
  Vercel's JWKS with project/owner/environment checks, fail-closed when
  configured.
- **Proof and economic ledgers separated**: `proof_status` and `economic_status`
  alongside the unchanged `verification_type`. Scoring gates on economic status.
- **Cost reconciliation seam** (`CostResolver`) with only the authoritative
  gateway resolver implemented; estimates are explicitly not payable.
- Supabase publishable/secret key names supported, legacy names still accepted.
- 203 tests pass.

## What I need from you

Supabase is done. What remains needs a Vercel account.

**1. Signing key** — the root of trust. Generate it, paste the private half into
Vercel, and never store it locally:

```bash
npm run usage:signing-key
```

**2. Vercel project**

```bash
npm i -g vercel
vercel link
```

Set these as **Sensitive** environment variables on Production:
`AI_GATEWAY_API_KEY`, `SUPABASE_SECRET_KEY`,
`USAGE_RECEIPT_SIGNING_PRIVATE_KEY`, `USAGE_RECEIPT_SIGNING_KEY_ID`.

Set as normal variables: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `USAGE_RECEIPT_PUBLIC_KEYS`,
`USAGE_RECEIPT_ISSUER`, and optionally `USAGE_VERCEL_OIDC_ISSUER` +
`USAGE_VERCEL_PROJECT_ID` + `USAGE_VERCEL_OWNER_ID`.

Then `vercel deploy --prod` (env changes need a redeploy to take effect).

**3. AI Gateway budget.** The team is still on the free tier: Anthropic models
return 403 and free models are rate-limited. Add a small credit balance and a low
spend cap before any Claude Code traffic. **I have not changed any budget.**

Once those exist, the remaining work is mechanical: sign up on the hosted app,
mint a production miner credential, point the launcher at the hosted URL, run one
tiny Claude Code session, and verify the resulting receipt with the public key.

## Known limitations

- No hosted deployment, so no CONFIRMED proof exists and nothing has earned.
- `USAGE_DEV_MINER_USER_ID` in `.env.local` is a random uuid with no profile row
  in the live database. Local gateway ingestion will fail its foreign key until
  it is replaced with a real profile id, or a real miner credential is minted.
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
