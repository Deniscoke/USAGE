# ARCHITECTURE

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Vitest · Supabase Postgres +
Auth (schema written, not provisioned) · Vercel target.

No state library, no chart library, no queue, no blockchain. Charts are
server-rendered SVG.

## Data flow

```
provider adapter          normalization            domain                 UI
─────────────────────────────────────────────────────────────────────────────
fetchUsage()  ──raw──▶  normalize()  ──▶  NormalizedUsageRecord
                                              │
                                        dedupeUsageRecords()   (idempotency)
                                              │
                              ┌───────────────┼────────────────┐
                              ▼               ▼                ▼
                       aggregateDaily   scoreDaily()     totalsBy*()
                                              │
                                        estimateReward()  (fixed epoch pool)
                                              │
                                        buildDashboard() ──▶ /dashboard
```

`buildDashboard()` (`src/lib/pipeline/dashboard.ts`) is the whole vertical slice
and the only thing the UI calls.

## Layout

```
src/lib/domain/       framework-free core: types, money, pricing, normalize,
                      scoring, epoch  (all unit tested)
src/lib/providers/    adapter interface, deterministic RNG, registry,
                      demo/{provider-api,gateway,local-cli}
src/lib/pipeline/     collect (fetch→normalize→dedupe), dashboard (view model)
src/lib/demo/         simulated network denominator for network share
src/app/              landing page, /dashboard
src/components/       ui primitives, SVG charts
supabase/migrations/  0001_init.sql
```

## Key decisions

**Money as integer micro-USD.** Usage costs are routinely sub-cent; cents lose
them and floats drift over millions of events. `usdStringToMicros` parses
provider decimal strings without ever touching a float. DB columns are `BIGINT`.

**Adapters are the only place a provider's wire format exists.** Each adapter
declares its own raw row type; `toIntegration()` type-erases it at the registry
seam so a heterogeneous registry stays type-safe and no `any` leaks out. Adding a
real provider = one file + one registry line.

**Idempotency in the schema, not in luck.** `usageEventKey()` mirrors the DB
unique constraint `(user_id, provider, source, external_reference)`. Re-syncing
an overlapping window is a no-op in memory and on insert. Adapters must make
`externalReference` deterministic for a given underlying event.

**Cost provenance is explicit.** `reportedCostMicros = null` means the source
gave no money and USAGE estimated it from `domain/pricing.ts`. The UI marks
those with `est`. Estimated cost never becomes authoritative.

**Scoring is a versioned registry.** `getScoringAlgorithm(version)` throws on
unknown versions rather than silently falling back. Scores carry their version;
`score_records` is unique per `(user, day, algorithm_version)` so v2 can be
computed alongside v1.

**Sqrt applies to the daily total, not per event.** Otherwise splitting one
request into a thousand would multiply the score.

**Epoch settlement uses largest-remainder.** `allocateEpochRewards` guarantees
integer allocations that sum exactly to the pool: no points minted or lost to
rounding, and the result is order-independent.

**Demo data is deterministic.** `mulberry32(hashSeed(provider, day))` — identical
output on every machine and every render, so screenshots and tests are stable.
It is labelled as demo everywhere it appears.

**Failure isolation.** `collectUsage` treats provider responses as untrusted and
records per-connection failures instead of failing the whole sync.

## Database

`supabase/migrations/0001_init.sql`: profiles, provider_connections,
usage_events, usage_daily_aggregates, proof_records, score_records,
reward_epochs, reward_allocations. RLS is on for every user-owned table with
`auth.uid()` policies; usage/score/allocation rows are read-only to users and
written by server-side sync (service role). Provider secrets are never stored in
`provider_connections` — it holds a `secret_ref` pointing at a server-side store.

## Adding a real provider (checklist)

1. Verify current **official** API docs. Record the capability table:
   provider, available API, required account type, auth method, available usage
   fields, cost data?, per-user data?, freshness, verification strength, known
   limitations. Add it to this file.
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
