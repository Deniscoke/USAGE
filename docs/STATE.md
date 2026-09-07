# STATE

## Current milestone

M3 — first real Proof of Usage path (Vercel AI Gateway → ROUTED). **Code
complete. No live gateway request has been made** (see Live probe below).

## What works

- **Routed proof path**: gateway observation → `VercelGatewayAdapter` →
  normalized usage → trusted ingestion → `usage_events` + `proof_records` →
  aggregates → `usage_score_v1` → dashboard. Exercised end to end against a real
  Postgres.
- Live gateway traffic is ROUTED / confirmed (weight 1.0) and scores through the
  same pipeline as VERIFIED. It is never labelled provider-VERIFIED.
- Idempotent on the gateway generation id: re-ingesting an observation inserts
  0 events and adds no duplicate provenance.
- Gateway cost is used verbatim (rounded half-up into micro-USD, with the
  rounding recorded) or marked unknown. It is never estimated.
- Malformed metadata and failed requests (401/402/429/5xx/timeout/network) are
  operational errors that create no usage.
- Provenance: every event gets a proof row (source, kind, external reference,
  observed/ingested timestamps, adapter version, whitelisted metadata).
- Dashboard distinguishes Verified / Routed / Reported, and labels Demo,
  Fixture and live Routed evidence separately.
- Earlier milestones unchanged: auth, RLS, persistence, epochs, demo adapters.
- 125 tests pass (unit + Postgres integration via PGlite).

## Evidence classes right now

| Class | Source | Weight | Status |
| --- | --- | --- | --- |
| Demo | three synthetic adapters | verified/routed/reported as simulated | working |
| Fixture | captured-shape gateway payloads | REPORTED, 0.0 | working, free |
| Real ROUTED | one live request through Vercel AI Gateway | ROUTED, 1.0 | implemented, **never executed** |
| Real VERIFIED | Anthropic/OpenAI admin APIs | 1.0 | not implemented |

Fixtures are classified REPORTED on purpose: USAGE did not observe them, so they
cannot become rewardable routed evidence anywhere, including production.

## Live probe: not executed

`npm run usage:gateway:probe` currently runs as a **dry run** and prints what a
real call would do. No `AI_GATEWAY_API_KEY` is configured here and a real request
spends AI Gateway credits, so none was made. To produce the first genuine ROUTED
event:

```bash
# set AI_GATEWAY_API_KEY in .env.local (server-side only), then:
npm run usage:gateway:probe -- --confirm
npm run usage:gateway:probe -- --confirm --user <profile-uuid>   # also persists
```

Free alternative that exercises the same path:

```bash
npm run usage:gateway:probe -- --fixtures --user <profile-uuid>
```

## Database state

Migrations 0001–0003 are committed and applied by the test suite against a real
Postgres. **The local Supabase stack still has never been started here: Docker is
not installed on this machine.** So `npm run db:start` / `db:reset` have not run,
no `.env.local` exists, and no GoTrue signup has been exercised. PGlite proves
the SQL, the RLS policies and the privilege model; it does **not** prove Supabase
Auth or PostgREST runtime behaviour.

Outstanding verification item: **run migrations and the auth/RLS flows against an
actual Supabase/Postgres stack.**

## Known limitations

- `src/lib/supabase/database.types.ts` is hand-maintained until `db:types` can
  run against a live stack.
- No historical gateway reconciliation: Custom Reporting (`GET /v1/report`) is
  plan-gated and deliberately not depended on.
- Network denominator for network share remains simulated
  (`src/lib/demo/network.ts`), labelled as such in the UI.
- No epoch settlement job; `reward_epochs` / `reward_allocations` are unwritten.
- Demo ingestion is a development-only server action; the probe is a
  development-only CLI.
- No E2E tests.

## Next recommended milestone

M4 — either (a) epoch settlement, writing `reward_epochs` and
`reward_allocations` from stored scores, or (b) the first VERIFIED provider:
verify the Anthropic or OpenAI organization usage/cost API against current
official docs, fill the capability register in `docs/ARCHITECTURE.md`, and store
credentials via `provider_connections.secret_ref`. Running the live gateway probe
once (with a key) is a small, high-value step that can happen independently.

## Important local commands

```bash
npm run dev                                # http://localhost:3000
npm run db:start                           # local Supabase (requires Docker)
npm run db:reset                           # re-apply migrations + seed
npm run db:types                           # regenerate database types
npm run usage:gateway:probe                # dry run, explains and costs nothing
npm run usage:gateway:probe -- --fixtures  # free fixture path
npm run usage:gateway:probe -- --confirm   # ONE real request, spends credits
npm test                                   # unit + Postgres integration tests
npm run typecheck && npm run lint && npm run build
```
