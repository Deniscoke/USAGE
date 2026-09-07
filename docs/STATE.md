# STATE

## Current milestone

M2 — auth + real persistence. **Code complete; not yet run against a live
Supabase stack** (see Database state).

## What works

- Supabase Auth (email/password) with cookie sessions via `@supabase/ssr`:
  `/sign-up`, `/login`, sign-out action. `src/proxy.ts` refreshes the session
  and redirects unauthenticated visitors away from `/dashboard`.
- Profiles created by the `on_auth_user_created` trigger, plus an idempotent
  `ensureProfile` repair path.
- Trusted server-side ingestion: demo adapters → normalize → dedupe →
  `usage_events` → `usage_daily_aggregates` → `score_records`. Idempotent:
  re-running stores no duplicates.
- Dashboard reads stored rows through the *user's* RLS-scoped client and derives
  its view model purely. It no longer calls adapters at render time.
- Privilege split: clients cannot insert, update or delete usage, aggregates or
  scores at all, so verification level cannot be self-declared.
- 75 tests pass, including integration tests against a real Postgres (PGlite)
  running the actual migrations: RLS isolation between users, idempotency,
  micro-USD round trip, split-request anti-gaming, verification boundary.

## What remains demo / simulated

- All usage comes from the three demo adapters. No real provider exists.
- The network denominator for network share is simulated
  (`src/lib/demo/network.ts`) and labelled as such in the UI.
- Epoch rewards are estimated per request. There is no settlement job, and
  `reward_epochs` / `reward_allocations` are unwritten.

## Database state

Schema and migrations are committed and verified by tests, but **the local
Supabase stack has never been started here: Docker is not installed on this
machine**, so `npm run db:start` / `npm run db:reset` could not be run, no
`.env.local` exists, and no real GoTrue signup has been exercised.

To finish verification on a machine with Docker:

```bash
npm run db:start      # prints URL + keys
cp .env.example .env.local   # fill in the printed values
npm run db:reset      # apply migrations + seed
npm run dev           # sign up, then press "Load demo usage"
npm run db:types      # regenerate src/lib/supabase/database.types.ts
```

Until then the dashboard renders a "Database not configured" state instead of
crashing.

## Auth state

Email/password only, confirmations disabled locally (`supabase/config.toml`).
No password reset, OAuth, or profile editing UI — out of scope for M2.

## Known limitations

- `src/lib/supabase/database.types.ts` is hand-maintained until `db:types` can
  run against a live stack; it must stay in sync with `supabase/migrations`.
- Demo ingestion is a development-only server action (disabled in production
  unless `USAGE_ALLOW_DEMO_INGEST=true`).
- No E2E tests; the auth redirect is covered by unit tests of the pure routing
  rules, not by a browser run.
- Dashboard loads 90 days of aggregates per request with no caching.

## Next recommended milestone

M3 — first real provider integration: verify official API capabilities, fill the
capability register in `docs/ARCHITECTURE.md`, store credentials via
`provider_connections.secret_ref`, and add a sync trigger. Epoch settlement
(writing `reward_epochs` / `reward_allocations`) is the natural follow-up.

## Important local commands

```bash
npm run dev          # http://localhost:3000
npm run db:start     # local Supabase (requires Docker)
npm run db:reset     # re-apply migrations + seed.sql
npm run db:types     # regenerate database types from the local stack
npm test             # unit + Postgres integration tests (no Docker needed)
npm run typecheck && npm run lint && npm run build
```
