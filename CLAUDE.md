# CLAUDE.md — USAGE operating rules

Stable conventions for this repository. Not a changelog (see `docs/STATE.md`).

## What this is

USAGE turns verifiable AI consumption into a measurable reputation system.
Read `docs/PRODUCT.md` for the thesis and `docs/ARCHITECTURE.md` for the shape.

## Hard rules

1. **No blockchain, no token, no smart contracts.** USAGE Points are off-chain,
   non-transferable, and carry no monetary value. Never imply otherwise in UI copy.
2. **Never fabricate a provider integration.** Verify current official API docs
   before implementing one, and record the capability table in
   `docs/ARCHITECTURE.md`.
3. **Privacy:** store usage metadata only. Never persist prompts, completions,
   conversations or source code. Never log secrets.
4. **Money is integer micro-USD** (`BIGINT` / `number` of micros). No floats in
   cost paths. Parse provider amounts from strings via `usdStringToMicros`.
5. **Scores and rewards always carry their algorithm version.** Introduce
   `usage_score_v2` as a new algorithm in the registry; never rewrite history.
6. **Reported usage has zero economic weight.** It is displayed, never rewarded.
7. **Rewards come from a fixed epoch pool.** Never a fixed points-per-token rate.
8. Secrets stay server-side. `.env.example` holds names only, never values.
9. Do not create billable cloud resources without asking. Local development uses
   the Supabase CLI stack, not a hosted project. `npm run usage:gateway:probe`
   spends real credits and must never be run without `--confirm` and approval.
10. **The root of trust is the receipt signing key, never an environment
    variable.** `USAGE_TRUST_ENVIRONMENT` is a diagnostic signal only. A proof
    is CONFIRMED only when signed by a key that exists solely on trusted hosted
    infrastructure. Never add a code path where a claim, header or env flag can
    substitute for that signature.
11. **Verification type is assigned by trusted server-side ingestion.** Clients
    have no write privilege on usage tables. Never add one. Gateway traffic USAGE
    routes itself is ROUTED, never provider-VERIFIED; fixtures are REPORTED.
    Only `verification_status = 'confirmed'` earns; development-observed and
    cost-unknown usage stays `pending`.
12. **Dashboard reads run as the signed-in user** so RLS applies. The service
    role is for ingestion only, never for serving a read.
13. **Say before you migrate production.** A schema change against the hosted
    database is called out explicitly and agreed before it runs — not mentioned
    afterwards in a summary, and not folded silently into a larger task.
    Migrations are usually safe and this one is not a prohibition; it is a
    refusal to let production DDL become routine background noise, because the
    day it is not safe is the day nobody was watching.

    The one exception is an active production security or correctness incident,
    where waiting is the greater risk. Say so at the time, and say why.

    Applies to `supabase db push`, `apply_migration`, and anything else that
    alters the hosted schema. Local stacks, PGlite tests and migration *files*
    are not covered — writing a migration is ordinary work; running it against
    production is not.

## Conventions

- Next.js App Router + TypeScript + Tailwind v4. Server components by default;
  add `"use client"` only when interaction genuinely requires it.
- No new dependencies without a clear reason. Charts are hand-rolled SVG.
- Domain logic lives in `src/lib/**` and stays framework-free and unit-tested.
  React components read it; they never reimplement it.
- Provider wire formats exist only inside `src/lib/providers/<provider>/`.
  Everything downstream consumes `NormalizedUsageRecord`.
- Colour encodes verification level only: verified green, routed blue,
  reported grey. Numbers use `.tnum` (tabular mono).
- `src/lib/supabase/database.types.ts` must use `type`, not `interface`
  (PostgREST generics need implicit index signatures; an interface resolves the
  whole schema to `never`).
- Demo usage enters through the real ingestion pipeline. Never hand-write usage
  rows or dashboard totals.
- Proof status and economic status are separate. A confirmed proof with unknown
  cost is `pending_cost`, not unconfirmed and not zero.
- Provider cost is authoritative or unknown. Never estimate a cost for real
  provider traffic, and keep `cost_basis` explicit.
- `AI_GATEWAY_API_KEY` is server-only and is never forwarded, logged, echoed in
  a response, or handed to a miner. Miners get their own `usgm_` credential.
- Gateway logs may carry ids, model, status, latency, tokens and cost. Never
  prompts, responses, tool arguments, or credentials.

## Checks before calling a milestone done

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Fix root causes; do not suppress errors.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
