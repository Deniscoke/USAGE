# ARCHITECTURE

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Vitest + PGlite · Supabase
(Postgres + Auth, local CLI stack) · Vercel target.

No state library, no chart library, no queue, no blockchain. Charts are
server-rendered SVG.

## Data flow

```
Claude Code (miner token)
        │
        ▼
USAGE Gateway  /api/gateway/anthropic/v1/messages
        │  authenticates the miner, attaches attribution,
        │  forwards with the USAGE-owned AI Gateway key
        ▼
Vercel AI Gateway ──▶ provider ──▶ model
        │
        ▼
response streams back untouched; USAGE reads only usage metadata
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
src/lib/gateway/      anthropic (proxy rules), usage-extract (JSON + SSE),
                      observability (safe logging, rate limit, dev sink)
src/lib/miner/        token (mint/hash/read), credentials (resolve, revoke)
src/lib/db/           ingest (trusted write path), supabase-store, rows
                      (row↔domain mapping), usage-repository (reads), profile
src/lib/supabase/     env, server/browser/admin clients, database.types.ts
src/lib/auth/         pure route-gating rules
src/lib/demo/         simulated network denominator for network share
src/proxy.ts          session refresh + route gating (Next 16 "proxy")
src/app/              landing, /login, /sign-up, /dashboard, auth actions,
                      api/gateway/anthropic/[...path] (the USAGE Gateway)
src/components/       ui primitives, SVG charts, auth form
src/test/             PGlite harness + SQL IngestStore for integration tests
scripts/              gateway-probe.ts (dev-only, the only code that can spend),
                      miner-token.ts, miner-summary.ts, start-claude-miner.ps1
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

**Mining rewards verified compute, not what anyone paid.** This is the central
economic decision. Two identical requests must mine identically whether one was
billed at list price and the other covered by BYOK, promotional credits, an
enterprise contract or free-tier credit — none of which say anything about how
much compute happened.

So there are two numbers, and they are never conflated:

| | |
| --- | --- |
| `protocol_compute_micros` | deterministic value from a frozen pricing snapshot. The economic basis for mining. |
| `reported_cost_micros` | what the gateway said it cost, when it says anything. Analytics and reconciliation only. |

`protocol_compute_micros` is **not a cost** and is never called one in the code
or the UI. A confirmed proof is `eligible` as soon as an approved snapshot
prices its model, even when no invoice exists anywhere.

**Pricing snapshots are frozen, not fetched.** `src/lib/pricing/usage-pricing-v1.ts`
is generated once from the AI Gateway catalog, reviewed, committed, and then
never edited: mining must not change because a price list changed on a website
overnight. A price change means `usage-pricing-v2`, and historical proofs keep
the version they were priced with. `usage:pricing:publish` refuses to touch a
version that has already priced events.

Valuation is integer-only. `priceTokens` uses BigInt because the intermediate
product overflows exact float range ($30/M × 10⁹ tokens is past 2⁵³), rounds
half-up at the micro boundary, and prices each token class separately —
including cache reads, which cost a tenth of fresh input on Anthropic models.

**An unpriced model waits rather than being guessed at.** A confirmed proof for
a model no snapshot covers becomes `pending_pricing`: the proof is sound, only
its value is unknown. Inventing a price would invent money.

**The proof ledger and the economic ledger move separately.**

| Column | Question | Values |
| --- | --- | --- |
| `verification_type` | what kind of evidence? | verified / routed / reported |
| `proof_status` | do we attest it happened? | observed / confirmed / rejected |
| `economic_status` | may it earn now? | eligible / pending_pricing / pending_cost / settled / ineligible |

**Settlement is idempotent by construction.** An allocation id is
`<epoch>:<user>` with a unique index on the ledger, so running settlement twice
credits nothing the second time. Largest-remainder allocation means the
distributed total equals the pool exactly — no points created or destroyed by
rounding. Counted events move to `settled` so they cannot be counted again.

Usage Points are an off-chain protocol accounting unit: not money, not a
security, not a claim on any future token. Everything shipped so far is a
**development epoch**, recorded as such in `reward_epochs.epoch_kind`.

**The root of trust is a signing key, not an environment variable.** This is
the single most important property in the system, so it is worth stating
negatively: `USAGE_TRUST_ENVIRONMENT=production` proves nothing, because anyone
can set it on their own machine. A SHA-256 receipt hash proves nothing about
origin either, because anyone can invent a receipt and hash it.

What actually roots trust is possession of `USAGE_RECEIPT_SIGNING_PRIVATE_KEY`,
an Ed25519 key held only as a Vercel sensitive variable on the hosted
deployment. A proof is CONFIRMED only if it carries a signature that verifies
against the published USAGE public key. A local gateway cannot produce one, so
it cannot mint economic value no matter what it says about itself.

Layered on top, when configured: **Vercel deployment identity**. Every Vercel
Function invocation carries a signed OIDC token on `x-vercel-oidc-token`.
`src/lib/trust/vercel-oidc.ts` verifies it against Vercel's JWKS and checks
project id, owner id and `environment=production`. A developer can pull a real
OIDC token locally with `vercel env pull`, but only for the *development*
environment, so the check still separates the deployment from a laptop. When it
is configured and fails, issuance is refused (fail closed). When it is not
configured, the signing key alone is the root — documented rather than implied.

`assessTrust()` returns both the decision and the individual signals, so a
diagnostic can say exactly why a proof was or was not confirmed.

**Three questions, three columns.**

| Column | Question | Values |
| --- | --- | --- |
| `verification_type` | what kind of evidence is this? | verified / routed / reported |
| `proof_status` | do we attest that it happened? | observed / confirmed / rejected |
| `economic_status` | may it earn right now? | eligible / pending_cost / ineligible |

A genuine hosted request whose cost has not reconciled is **routed + confirmed +
pending_cost**: a real proof that is not yet payable. Calling it unconfirmed
because a billing figure is missing would be false, and scoring it as $0 would
be worse. Scoring gates on `economic_status`, so the proof ledger and the
economic ledger move independently and points are never minted twice.

**Cost is a separate layer.** `src/lib/domain/cost.ts` defines the reconciliation
seam: `CostResolver` implementations answer "what did this generation cost?"
independently of the proof. Only `gateway_reported` is implemented. A future
price-table resolver produces `costBasis: "estimated"` with an explicit
`pricingSource`/`pricingVersion`, and an estimate never makes usage eligible —
it is not an invoice.

**The USAGE Gateway owns the trust boundary.** A miner client authenticates
with its own revocable credential and gets to *initiate* a request; the server
decides what evidence that produces. Nothing in the request body or headers can
influence verification type, token counts, cost, or the identity a proof is
bound to. The upstream AI Gateway key never leaves the server: client
`authorization`, `x-api-key`, `x-ai-gateway-api-key` and the miner header are
all stripped before forwarding, and the equivalent response headers are stripped
on the way back.

**Miner credentials are hashed, never stored.** A token is 256 bits of CSPRNG
output prefixed `usgm_`; only its SHA-256 lands in the database. A slow KDF would
add latency to every request while defending against a dictionary attack that
cannot exist against random 256-bit secrets. The plaintext is shown once.

**A subscription-authenticated Claude Code keeps its own `Authorization`**, so
the miner token is also accepted on `x-usage-miner-token` (set via
`ANTHROPIC_CUSTOM_HEADERS`). Only miner-shaped values are ever *read* as
credentials — another provider's secret is never compared, logged, or forwarded.

**Three trust environments, one vocabulary.**

| Observed by | verification_type | verification_status | Earns |
| --- | --- | --- | --- |
| Trusted hosted USAGE infrastructure | routed | confirmed | yes |
| A gateway on someone's own machine | routed | pending | no |
| A captured fixture | reported | unverifiable | no |
| Any of the above with unknown cost | (unchanged) | pending | no |

The public vocabulary did not change: a locally observed request genuinely was
routed. What gates the economics is `verification_status`, which the scorer now
requires to be `confirmed` (`isEconomicallyEligible`). `USAGE_TRUST_ENVIRONMENT`
is the only thing that can promote an environment to `production`, and it is
server configuration, never a request field.

**Unknown cost is pending, not zero.** Scoring `$unknown` as `$0` would quietly
assert that real compute was worthless. Such usage is stored, displayed, and
counted in `pending_cost_micros` until a cost is known.

**Proof receipts are hashed over a canonical form.** `canonicalReceipt` emits a
fixed field order as `key=value` lines (not `JSON.stringify`, whose key order and
number formatting are not guaranteed stable) and `null` for unknown values.
`observedAt` is deliberately excluded so re-ingesting the same generation
produces the same hash. `src/lib/domain/receipt.ts` documents the exact covered
fields; prompts, responses and credentials are not among them.

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

## Product platform (M6)

Four registries, all of which the UI reads rather than restates.

```
src/lib/providers/catalog.ts    what each provider supports, and what it does not
src/lib/compute/registry.ts     gateways that can execute and observe a request
src/lib/imports/adapter.ts      the pull half: historical usage from admin APIs
src/lib/protocol/emission.ts    epoch length, emission, scoring and pricing, versioned
```

**The honesty rule.** A capability is `available` only when an implementation
exists. `unresolvedGatewayReferences()` fails a test if a provider claims routed
mining "via" a gateway that was never written, so the registry cannot drift into
marketing.

**ComputeGateway** is the execution boundary: it decides where a request goes
and how USAGE authenticates upstream, and reports what it observed. It does not
decide verification type, proof status, economic status or points — those are
derived downstream from the trust environment and the signing key. A dishonest
gateway implementation could lie about tokens; it still could not mint a
confirmed proof, because it does not hold the key. `vercelComputeGateway` is the
production implementation and wraps the code proven in M3–M5B unchanged.

**Emission** is one versioned bundle (`mining-dev-v1`), so the number 100000
exists in exactly one place and a protocol change is a new version rather than
an edit. There is deliberately no field anywhere that converts tokens or dollars
into points at a fixed rate.

### The three ledgers

They answer different questions and are never merged (`src/lib/protocol/ledgers.ts`):

| Ledger | Question | Where | Unit |
| --- | --- | --- | --- |
| Compute | What AI compute happened? | `usage_events`, `proof_records` | tokens, protocol micro-USD |
| Reward | How many Usage Points were earned? | `reward_allocations`, `usage_point_ledger` | whole points |
| Payment | Who paid for the compute? | **not implemented** | micro-USD of real money |

Compute Credits (pre-funded money) are not Usage Points (earned rewards). They
are different units in different ledgers with different legal character, and no
code converts one into the other.

### The network denominator

A user's share needs the network's total score, which no user can read under
RLS. `epoch_network_totals` is a security-definer view exposing day,
algorithm version, total score and participant count — aggregates only, no user
ids. An invoker view would return only the caller's own score and quietly report
a 100% share, which is worse than useless.

With one participant the share really is 100%; the product says "development
network" rather than inventing other miners.

### Crypto readiness (not crypto)

`profiles.wallet_address` is a nullable label and `point_balance_snapshots`
records per-epoch credits immutably, so a future claim dataset can be built
without migrating history. There is no chain, no token, no custody, no trading,
and no mapping from a point to a token.

## Multi-provider (M7)

Two real gateways and one real importer, all downstream of the same normalized
record. The mining engine cannot tell them apart, and that is the point.

```
src/lib/compute/gateway.ts            the ComputeGateway contract
src/lib/compute/vercel-gateway.ts     Anthropic-protocol, live in production
src/lib/compute/openrouter-gateway.ts OpenAI-protocol, tested, no live proof yet
src/lib/compute/registry.ts           registry + deterministic routing policy
src/lib/gateway/handler.ts            ONE trust boundary, shared by both routes
src/lib/imports/openai-org/           the first verified import
src/lib/db/reconciliation.ts          cross-source double-reward protection
```

### Provider is not gateway

The registry separates them, because "Anthropic routed" would imply a direct
Anthropic integration that does not exist. Anthropic is reachable through the
Vercel AI Gateway and through OpenRouter; each is a `GatewayRoute` with its own
status, auth requirement and cost availability. Import capability stays on the
provider, since it is the provider's own API.

Statuses mean exactly one thing each: `live` (exercised in production),
`tested` (implemented and covered by tests), `configured` (implemented with a
credential present), `available` (implemented and usable), `coming_soon`
(declared, not implemented). A test asserts that only routes with a real
production proof claim `live`.

### One trust boundary

Adding a second gateway meant either duplicating the auth/trust/signing path or
extracting it. It is extracted: `createGatewayRoute` carries miner
authentication, rate limiting, trust assessment, attribution, streaming
passthrough and `after()` persistence, and each route file only says which
gateway and which error shape. Two gateways with two copies of that logic would
become two security models.

Receipts are now `usage.receipt.v4`, adding a signed `gatewayId`. With one
gateway it was implicit; with two it is evidence. v2 and v3 keep verifying
against the exact field list they were signed with.

### Routing policy

`selectGateway(provider)` is deterministic and does NOT retry across gateways at
runtime. Fallback applies only when the preferred gateway has no credential at
all -- a configuration fact known before anything is sent. Failing over
mid-request would change which credential paid, which account the usage appears
under, and which upstream terms applied, and would make a proof's recorded
gateway a guess rather than evidence.

### Imports are a different kind of proof

An import is not a routed receipt and the code never pretends otherwise:

| | Routed | Verified import |
| --- | --- | --- |
| Who observed it | USAGE, first-hand | The provider, after the fact |
| Identity | provider generation id | deterministic bucket identity |
| Granularity | one request | a time bucket |
| `gatewayId` | the gateway that ran it | null |
| Receipt `clientType` | the tool | `import` |

Organization usage has no request ids, so identity is a SHA-256 over the
authoritative dimensions the API grouped by: organization, bucket start, bucket
width, model, project, user, api key, plus the adapter version. It contains
nothing about when the import ran, which is what makes re-importing a window a
no-op.

`verified + confirmed` still requires a trusted server fetch with an admin
credential AND a production signature. A client uploading a file can never
produce it; there is no write path.

### Cross-source reconciliation

The same compute can arrive twice -- routed when USAGE executed it, then inside
the provider's own daily total. Perfect matching is impossible (aggregates carry
no request ids), so the rule refuses to pay into the ambiguity rather than
guessing:

1. identical external identity -> the natural key already deduped it;
2. aggregate import overlapping routed usage for the same provider and UTC day
   -> `reconciliation_status = held`, `reward_hold = true`;
3. otherwise -> `clear`.

A held record keeps its confirmed, signed proof. Withholding a reward is not the
same as doubting the evidence, and `isEconomicallyEligible` checks the hold
before anything else, so held compute is reported as pending rather than scored
or discarded.

### Cost

`actual_cost_micros` (renamed from `reported_cost_micros`, which read like a
user's claim) holds the authoritative provider or gateway cost, with
`actual_cost_basis` saying who said so. OpenRouter reports one per request;
the Anthropic-compatible Vercel surface does not. Mining has never used it and
still does not -- `protocol_compute_micros` is the economic basis, so a route
that happens to report its bill earns exactly the same as one that does not.

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

### Hosting

The application deploys as-is to Vercel; there is no separate service. Trusted
issuance requires, as sensitive environment variables on the production
deployment: `AI_GATEWAY_API_KEY`, `SUPABASE_SECRET_KEY`, and
`USAGE_RECEIPT_SIGNING_PRIVATE_KEY` + `USAGE_RECEIPT_SIGNING_KEY_ID`. The
Supabase URL and publishable key are public by design.

Schema reaches hosted Supabase through the existing migrations
(`supabase link --project-ref <ref>` then `supabase db push`); tables are never
hand-made in the dashboard.

Changing a Vercel environment variable requires a redeploy before it takes
effect.

### USAGE Gateway endpoints

| | |
| --- | --- |
| Anthropic surface | `POST /api/gateway/anthropic/v1/messages` (also `/v1/messages/count_tokens`, and GET for model discovery) |
| Client auth | `x-usage-miner-token`, `Authorization: Bearer usgm_…`, or `x-api-key` |
| Upstream | `https://ai-gateway.vercel.sh/claude-code` (override with `USAGE_UPSTREAM_BASE_URL`) |
| Upstream auth | `AI_GATEWAY_API_KEY`, server-side only |
| Attribution | server-set `providerOptions.gateway.{user,tags}`; user is the internal uuid, never an email |
| Streaming | SSE passes through byte-for-byte; usage is read from `message_start` + `message_delta` |

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
| Known limitations | No historical backfill without Custom Reporting (`GET /v1/report`), which is plan-gated, so the first proof path deliberately does not depend on it. Model slugs change; the probe resolves one from `gateway.getAvailableModels()` rather than hardcoding. **The Anthropic-compatible surface returns no cost**, so gateway-proxied traffic is always cost-unknown and therefore economically pending; the AI SDK surface does return `providerMetadata.gateway.cost`. Some models report `input_tokens: 0` in `message_start` on that surface — USAGE records what was reported and never substitutes an estimate. |

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
