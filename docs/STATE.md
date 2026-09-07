# STATE

## Current milestone

M4B — Trusted Hosted Mining. **Code complete and locally verified. Not yet
hosted:** creating the Vercel project and the Supabase project needs your login,
so those steps are waiting on you (see *What I need from you*).

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **NO** — needs your Vercel login |
| Real Supabase runtime | **NO** — needs your Supabase project |
| GoTrue tested | **NO** — never run against a live auth server |
| RLS runtime tested | **PGlite only** — real migrations, real policies, not the Supabase runtime |
| Receipt signing | **YES** — Ed25519, signed and independently verified end to end locally |
| First production-signed proof | **NO** — no production key exists yet |
| First Claude Code hosted proof | **NO** — blocked on hosting |
| Proof status | all stored proofs are `observed` |
| Economic status | all `ineligible` or `pending_cost`; nothing has earned |
| Cost reconciliation | seam exists; only `gateway_reported` implemented; Anthropic surface reports no cost |
| Next blocker | **you: create the Supabase and Vercel projects** |

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

Nothing here can be done without your accounts. In order:

**1. Supabase project** (free tier is fine)

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push        # applies migrations 0001-0005
```

Then from the Supabase dashboard collect: project URL, publishable key, secret key.

**2. Signing key** (never leaves your hands until you paste it into Vercel)

```bash
npm run usage:signing-key
```

**3. Vercel project**

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

**4. AI Gateway budget.** The team is still on the free tier: Anthropic models
return 403 and free models are rate-limited. Add a small credit balance and a low
spend cap before any Claude Code traffic. **I have not changed any budget.**

Once those exist, the remaining work is mechanical: sign up on the hosted app,
mint a production miner credential, point the launcher at the hosted URL, run one
tiny Claude Code session, and verify the resulting receipt with the public key.

## Known limitations

- No hosted deployment, so no CONFIRMED proof exists and nothing has earned.
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
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
npm run miner:summary                      # mining session summary
npm run usage:gateway:probe -- --confirm   # ONE real request, spends credits
npm test && npm run typecheck && npm run lint && npm run build
```
