# STATE

## Current milestone

M0 — end-to-end vertical slice on demo data. **Complete.**

## Completed

- Next.js 16 + TS + Tailwind v4 scaffold, dark design system.
- Domain core: micro-USD money, pricing estimates, normalization + idempotency,
  scoring `usage_score_v1`, epoch rewards. 36 unit tests passing.
- Provider adapter interface + registry + three deterministic demo adapters
  (verified / routed / reported).
- Ingestion pipeline (fetch → normalize → dedupe, per-connection failure isolation).
- Landing page and dashboard (spend, tokens, score, network share, epoch estimate,
  distributions, verified-vs-reported, recent activity, connections).
- Supabase schema with RLS: `supabase/migrations/0001_init.sql` (written, NOT applied).

## Current implementation

Demo mode only. `buildDashboard()` runs the adapters in-process on each request;
nothing is persisted. Supabase is not provisioned and no auth exists yet — the
dashboard is open at `/dashboard`.

## Known problems

- No auth or persistence: the schema is written but unused, so nothing yet
  exercises RLS or the DB idempotency constraint.
- Network share uses a *simulated* network denominator (`src/lib/demo/network.ts`).
- Epochs are estimated per request; there is no settlement job writing
  `reward_epochs` / `reward_allocations`.
- Pricing table is placeholder rates for demo models only.
- No E2E tests.

## Next actions

1. Supabase project + auth (magic link), apply `0001_init.sql`, seed the demo
   account through the real tables. **Needs the user to approve creating the project.**
2. Persist the pipeline: write `usage_events` + `usage_daily_aggregates` on sync,
   proving the DB idempotency constraint against a double import.
3. Nightly epoch settlement writing `score_records` and `reward_allocations`.
4. First real provider: verify official API docs first, fill the capability
   register in `docs/ARCHITECTURE.md`, then implement.

## Important commands

```bash
npm run dev        # http://localhost:3000
npm test           # vitest
npm run typecheck
npm run lint
npm run build
```
