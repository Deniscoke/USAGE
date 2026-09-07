# ARCHITECTURE

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Vitest + PGlite · Supabase
(Postgres + Auth, local CLI stack) · Vercel target.

No state library, no chart library, no queue, no blockchain. Charts are
server-rendered SVG.

## Data flow

```
authenticated user
        │
        ▼
provider adapter ──raw──▶ normalize() ──▶ NormalizedUsageRecord
                                              │
                                        dedupeUsageRecords()      (in memory)
                                              │
                                              ▼
                                    usage_events  ◀── unique natural key
                                              │           (in the database)
                        ┌─────────────────────┴───────────────────┐
                        ▼                                         ▼
             usage_daily_aggregates                        score_records
              (aggregateDaily)                              (scoreRecords,
                        │                                    versioned)
                        └─────────────────┬───────────────────────┘
                                          ▼
                              loadDashboardSnapshot()   (as the user, RLS)
                                          ▼
                               buildDashboardView()     (pure)
                                          ▼
                                     /dashboard
```

Ingestion writes; the dashboard only reads. The page never calls an adapter.

## Layout

```
src/lib/domain/       framework-free core: types, money, pricing, normalize,
                      scoring, epoch  (unit tested)
src/lib/providers/    adapter interface, deterministic RNG, registry,
                      demo/{provider-api,gateway,local-cli}
src/lib/pipeline/     collect (fetch→normalize→dedupe), dashboard (view model)
src/lib/db/           ingest (trusted write path), supabase-store, rows
                      (row↔domain mapping), usage-repository (reads), profile
src/lib/supabase/     env, server/browser/admin clients, database.types.ts
src/lib/auth/         pure route-gating rules
src/lib/demo/         simulated network denominator for network share
src/proxy.ts          session refresh + route gating (Next 16 "proxy")
src/app/              landing, /login, /sign-up, /dashboard, auth actions
src/components/       ui primitives, SVG charts, auth form
src/test/             PGlite harness + SQL IngestStore for integration tests
supabase/             config.toml, migrations/, seed.sql
```

## Key decisions

**Money as integer micro-USD.** Usage costs are routinely sub-cent; cents lose
them and floats drift over millions of events. `usdStringToMicros` parses
provider decimal strings without touching a float. DB columns are `BIGINT`.
Every value crossing the DB boundary passes `toSafeInteger`, which throws rather
than silently losing precision (PostgREST returns bigint as a JSON number).

**Adapters are the only place a provider's wire format exists.** Each adapter
declares its own raw row type; `toIntegration()` type-erases it at the registry
seam. Adding a real provider = one file + one registry line.

**Idempotency in the schema, not in luck.** `usageEventKey()` mirrors the DB
unique constraint `(user_id, provider, source, external_reference)`. Ingestion
inserts with "ignore duplicates", so re-syncing an overlapping window is a no-op.

**Aggregates and scores are persisted, not recomputed per page view.** After
inserting events, ingestion re-derives the *whole* affected day from stored
events and upserts `usage_daily_aggregates` and `score_records`. Full-day
recomputation (rather than incremental deltas) makes repeated ingestion
convergent. The four layers stay separate — raw usage, daily aggregation, score,
reward — and aggregation lives in the domain, not in one opaque SQL statement.

**The dashboard reads as the user.** `loadDashboardSnapshot` uses the
cookie-scoped Supabase client, so Postgres RLS decides what comes back. The
service role is never used for a dashboard read.

**Verification is a server-side boundary.** Clients have no INSERT, UPDATE or
DELETE privilege on `usage_events`, `usage_daily_aggregates`, `score_records`,
`proof_records` or `reward_allocations` (migration 0002). Verification type is
assigned by the adapter during trusted ingestion, so a client cannot submit
`{"verification": "verified"}` — it cannot submit usage at all.

**Profiles are created by a database trigger** (`on_auth_user_created`), not by
signup code: it cannot be bypassed by a signup path we forget to update and it
runs in the same transaction as the user row. `ensureProfile` is an idempotent
repair for users created before the trigger existed.

**Scoring is a versioned registry.** `getScoringAlgorithm(version)` throws on
unknown versions. `score_records` is unique per `(user, day, algorithm_version)`
so v2 can be computed alongside v1 without rewriting history.

**Sqrt applies to the daily total, not per event.** Splitting one request into a
thousand must not multiply the score; tested at both the domain and DB level.

**Epoch settlement uses largest-remainder.** Integer allocations sum exactly to
the pool, order-independently. There is no settlement job yet: the current epoch
estimate is derived per request from today's stored score.

**Demo data is deterministic and enters through the real pipeline.**
`mulberry32(hashSeed(provider, day))` gives identical output everywhere.
`seed.sql` deliberately inserts no usage rows — hand-written usage would bypass
the architecture and show numbers no ingestion path could produce.

**`database.types.ts` uses `type`, not `interface`.** PostgREST's generics
require `Record<string, unknown>`, and TypeScript only grants implicit index
signatures to type aliases. An interface there silently resolves the entire
schema to `never` and every insert becomes a type error with a misleading
message.

## Database

`supabase/migrations/`:

- `0001_init.sql` — tables, enums, RLS enabled with `auth.uid()` policies.
- `0002_grants_and_profiles.sql` — privilege split (user-owned vs trusted
  tables), service-role grants, and the profile trigger.

Users may read their own rows everywhere and write only `profiles` and
`provider_connections`. `reward_epochs` is public parameter data, readable by
anyone. Provider secrets are never stored in `provider_connections`; it holds a
`secret_ref` pointing at a server-side store.

## Testing

Domain logic is unit tested. Persistence and authorization are tested against a
**real Postgres** — PGlite (in-process WASM) running the project's actual
migrations, with a small shim providing what the Supabase platform normally
supplies (`auth.users`, `auth.uid()`, the `anon`/`authenticated`/`service_role`
roles). Queries in those tests run as `authenticated` with a JWT claim, exactly
as a PostgREST request would, so "user A cannot read user B" is a real
assertion rather than a mock. No Docker required.

`src/test/sql-ingest-store.ts` implements the same `IngestStore` port over SQL,
which is how the ingestion pipeline itself is exercised end to end.

## Adding a real provider (checklist)

1. Verify current **official** API docs. Record the capability table:
   provider, available API, required account type, auth method, available usage
   fields, cost data?, per-user data?, freshness, verification strength, known
   limitations. Add it below.
2. Implement `src/lib/providers/<provider>/index.ts` against
   `UsageProviderAdapter`, with a deterministic `externalReference`.
3. Register it in `src/lib/providers/registry.ts`.
4. Test normalization + idempotency against a captured fixture.
5. Secrets: server-side only, referenced by `provider_connections.secret_ref`.

### Provider capability register

| Provider | Status |
| --- | --- |
| demo-provider | Synthetic. Stands in for an authoritative usage/cost API (verified). |
| demo-gateway | Synthetic. Stands in for USAGE-operated gateway traffic (routed). |
| demo-cli | Synthetic. Stands in for local dev-tool telemetry (reported, cost estimated). |

No real provider has been verified or implemented yet.
