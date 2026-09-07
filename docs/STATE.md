# STATE

## Current milestone

M4 — Trusted Usage Miner V0. **Complete.** Claude Code can run through the USAGE
Gateway and produce real, deduplicated proof receipts from real AI compute.

## Verification status

| Item | Status |
| --- | --- |
| First live Gateway proof | **PASS** (`gen_01M1XPMK09E2SFK3R2AJ0VYN0A`, 28 in / 16 out, receipt hashed, re-ingest 0 new) |
| Claude Code through USAGE Gateway | **PASS** (streamed, clean exit, 2 generations captured) |
| Trusted hosted production gateway | **NO** — the gateway has only ever run locally |
| Real Supabase runtime verified | **NO** — Docker unavailable; PGlite proves the SQL, not GoTrue/PostgREST |
| Current economic trust status | **All observed usage is PENDING** and earns nothing |

## What works

- **USAGE Gateway** at `/api/gateway/anthropic/[...path]`: authenticates a miner
  credential, forwards to the Vercel AI Gateway with the server-side key, and
  observes the response. Streaming passes through byte-for-byte; tool calls,
  caching, beta headers and error bodies are untouched.
- **Miner credentials**: `usgm_` tokens, SHA-256 stored, revocable, shown once.
  Invalid, malformed and revoked credentials are rejected before any upstream
  call, so a rejected miner can never spend.
- **Proof receipts** with a deterministic `sha256:` hash over a documented
  canonical form, stored on `proof_records` with trust environment and adapter
  version.
- **Trust separation**: hosted → routed/confirmed (earns); local → routed/pending
  (earns nothing); fixture → reported/unverifiable (earns nothing); unknown cost →
  pending regardless.
- **Mining session summary** (`npm run miner:summary`) derived from observed
  usage through the existing scorer and epoch logic.
- Everything from M1–M3 unchanged: normalization, RLS, persistence, scoring v1,
  epochs, idempotency.
- 167 tests pass (unit + Postgres integration via PGlite).

## Why everything is currently PENDING

Two independent reasons, both deliberate:

1. The gateway runs on this machine. A local process is not a trust anchor, so
   its observations are `routed / pending`. Only `USAGE_TRUST_ENVIRONMENT=production`
   on trusted hosted infrastructure promotes them, and that infrastructure does
   not exist yet.
2. The Anthropic-compatible gateway surface returns no cost, so proxied traffic
   is cost-unknown. Unknown cost is held as pending rather than scored as $0.

## External account constraint

The Vercel team is on the **AI Gateway free tier**: Anthropic models return 403
("free tier users do not have access to this model") and free models are
rate-limited. The live proofs above used free-tier models
(`inclusionai/ling-3.0-flash-fin`, `perplexity/sonar`). Claude Code therefore had
to be pointed at a non-Anthropic model, which it warns about
(`unrecognized_model`) but handles.

Before any meaningful Claude Code traffic, add a small AI Gateway credit budget
and set a low spend cap. **No budget was changed** — that is your call.

## Local miner setup (development only)

```bash
npm run miner:token                    # prints the token once + the hash line
# add USAGE_DEV_MINER_TOKEN_HASH and USAGE_DEV_MINER_USER_ID to .env.local
npm run dev
$env:USAGE_MINER_TOKEN = "usgm_..."    # PowerShell, session only
npm run miner:claude                   # or: ./scripts/start-claude-miner.ps1
npm run miner:summary                  # what the session was worth
```

The launcher sets session-scoped variables only and never touches
`~/.claude/settings.json` or your Claude login.

## Known limitations

- No hosted deployment, so no economically valid proof exists yet.
- Local observations land in `.usage/observations.jsonl` (gitignored) rather than
  a database. That is an inspection artifact, not proof storage.
- Rate limiting is per-process and in-memory; a hosted deployment needs a shared
  limiter.
- `database.types.ts` is hand-maintained until `db:types` can run.
- Some models report `input_tokens: 0` on the Anthropic-compatible stream; USAGE
  records what was reported rather than estimating.
- Codex is not implemented (M5). The miner, receipt, hashing, ingestion and
  scoring layers are provider-neutral and ready for it.
- No epoch settlement job; no E2E tests.

## Next recommended milestone

M5 — either (a) deploy the gateway to trusted hosted infrastructure with a real
Supabase, which is what turns PENDING into CONFIRMED and finally exercises
GoTrue/RLS at runtime, or (b) Codex miner support over the same boundary. (a) is
the higher-value step: nothing can actually earn until it is done.

## Important local commands

```bash
npm run dev                                # http://localhost:3000
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
npm run miner:summary                      # mining session summary
npm run usage:gateway:probe                # dry run, costs nothing
npm run usage:gateway:probe -- --fixtures  # free fixture path
npm run usage:gateway:probe -- --confirm   # ONE real request, spends credits
npm run db:start / db:reset / db:types     # local Supabase (needs Docker)
npm test && npm run typecheck && npm run lint && npm run build
```
