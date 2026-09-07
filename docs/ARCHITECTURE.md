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
                      demo/{provider-api,gateway,local-cli},
                      vercel-gateway/{observation,adapter,fixtures,probe}
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
scripts/              gateway-probe.ts (dev-only, the only code that can spend)
supabase/             config.toml, migrations/, seed.sql
```

## Key decisions

**Money as integer micro-USD.** Usage costs are routinely sub-cent; cents lose
them and floats drift over millions of events. `usdStringToMicros` parses
provider decimal strings without touching a float. DB columns are `BIGINT`.
Every value crossing the DB boundary passes `toSafeInteger`, which throws rather
than silently losing precision (PostgREST returns bigint as a JSON number).

**Two ingestion modes.** `pull` adapters fetch history on a schedule; the
gateway is `observation` mode — evidence is captured at request time by
USAGE-controlled infrastructure and pushed in, because there is nothing to pull.
`listPullIntegrations()` keeps the demo sync from trying to poll it.

**Routed is not verified.** A request USAGE itself sent through the Vercel AI
Gateway is *observed* (ROUTED, weight 1.0), not attested by the provider's
billing system (VERIFIED). The distinction is preserved end to end; only an
authoritative provider/billing API may ever produce VERIFIED.

**Fixtures are REPORTED, by definition.** A captured payload was not observed by
anyone, so `deriveVerification("fixture")` classifies it REPORTED /
unverifiable — weight 0.0. That makes it structurally impossible for fixture
data to earn rewards without adding a special case to the scorer, and fixture
external references live in a `fixture:` namespace that cannot collide with or
impersonate a real `live:<generationId>`.

**Gateway cost is authoritative or unknown — never estimated.** When the gateway
reports a cost it is parsed by `usdCostToMicros`, which rounds half-up at the
micro boundary (providers quote more precision than micro-USD; truncating
sub-micro costs to zero would under-report real spend) and records whether it
rounded. When the gateway reports nothing, cost is `null` / 0 with
`cost_basis: "unavailable"`. The local price table is for demo models only and
is never applied to real gateway traffic.

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

**Provenance for every event.** Ingestion writes a `proof_records` row for each
event it creates: proof kind, proof source, external reference, observed and
ingested timestamps, adapter version, and a whitelisted metadata object the
adapter chose. Raw provider payloads are never stored, and re-ingesting an
observation cannot accumulate duplicate provenance (unique on
`usage_event_id, proof_kind`).

**A failed request is not usage.** `classifyGatewayFailure` maps 401/403, 402,
429, 5xx, timeouts and network errors to operational failures, and malformed
metadata (no generation id, no token counts, negative counts, non-USD cost) is
rejected by `assertObservation`. None of these create a usage event: without
trustworthy evidence that billable usage occurred, guessing would fabricate
economic value.

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

Gateway evidence has two modes. **Fixture mode** (`fixtures.ts`, and
`npm run usage:gateway:probe -- --fixtures`) replays schema-realistic payloads
through the whole path with no network and no cost. **Real mode**
(`-- --confirm`) makes exactly one small request and is the only code in the
repository that can spend money; it refuses to run without the flag and without
a server-side credential.

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
| vercel-ai-gateway | **Implemented.** See below. |

### Vercel AI Gateway (verified against official docs, April 2026)

| | |
| --- | --- |
| Available API | AI SDK v6 (`generateText` with a `provider/model` string routes through the gateway). |
| Required account | Vercel team with AI Gateway enabled. Free tier includes monthly credits. |
| Auth | `AI_GATEWAY_API_KEY`, or `VERCEL_OIDC_TOKEN` from `vercel env pull`. Server-side only. |
| Usage fields | `usage.inputTokens`, `usage.outputTokens`, `usage.totalTokens`, `usage.inputTokenDetails.{noCacheTokens,cacheReadTokens,cacheWriteTokens}`, `usage.outputTokenDetails.{textTokens,reasoningTokens}`. All optional. |
| Cost | `providerMetadata.gateway.cost` (decimal USD). Not always present. |
| Request identity | `providerMetadata.gateway.generationId`; falls back to `response.id`. |
| Provider identity | Gateway routing metadata when present, else the model slug prefix. |
| Data freshness | At request time. |
| Verification strength | ROUTED — observed by USAGE, not attested by the provider's billing system. |
| Known limitations | No historical backfill without Custom Reporting (`GET /v1/report`), which is plan-gated, so the first proof path deliberately does not depend on it. Model slugs change; the probe resolves one from `gateway.getAvailableModels()` rather than hardcoding. |

Token mapping: `inputTokens` is inclusive of cache reads, so USAGE stores
`inputTokens - cacheReadTokens` as fresh input and the cache reads separately.
Reasoning tokens are a breakdown of output tokens (already counted, and billed
as output), so they are recorded in proof metadata for explainability rather
than added to any total.

### Not implemented (future VERIFIED sources)

| Provider | Why not yet |
| --- | --- |
| Anthropic Usage & Cost Admin API | Requires organization/admin credentials. |
| Anthropic Claude Code Analytics API | Requires organization/admin access. |
| OpenAI Organization Usage/Costs API | Requires organization/admin access. |
| Local Claude Code / Codex telemetry | REPORTED until a stronger attestation design exists. |
