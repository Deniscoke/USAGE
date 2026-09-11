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

## Universal providers (M8)

Any provider speaking a supported protocol can be connected by a user, without
a code change and without touching the mining engine.

```
src/lib/net/ssrf.ts                    outbound request guard
src/lib/secrets/crypto.ts              AES-256-GCM credential encryption
src/lib/protocols/protocol.ts          the protocol boundary
src/lib/protocols/openai-compatible.ts most of the industry
src/lib/protocols/anthropic-compatible.ts
src/lib/providers/connections.ts       create, validate, resolve, revoke
src/lib/compute/protocol-gateway.ts    a connection, as a ComputeGateway
src/app/api/gateway/provider/[connectionId]/[...path]
```

### Provider, protocol, connection

Three separate things, and conflating any two of them breaks something:

| | What it is | Scope |
| --- | --- | --- |
| Definition | what a provider IS | official (shared) or custom (one user) |
| Protocol | the wire format it speaks | `openai_compatible`, `anthropic_compatible` |
| Connection | what a user connected | one user, one credential |

A provider is not its protocol: an Anthropic-compatible endpoint is not
necessarily Anthropic. A connection is not a definition: one person adding
"DeepSeek" must not publish a provider for everybody.

### Connectable is not mining eligible

`deriveMiningEligibility` is the whole rule:

```
not routable / not authenticated        -> unsupported
no token usage OR no request identity   -> analytics_only
no approved protocol price for a model  -> pending_pricing
otherwise                               -> eligible_route
```

Request identity is non-negotiable. Without a stable per-request id there is no
dedupe key, and a synthetic one would make duplicates invisible rather than
impossible -- so there is simply no proof.

`pending_pricing` is the anti-fraud property: a custom provider cannot declare
its own prices and mine against them. `protocol_model_key` is set only by
server-side mapping onto an approved immutable snapshot, exact matches only, and
no client role can write it.

### The SSRF guard

Accepting user-supplied URLs turns the server into a request proxy, and a
request proxy inside a cloud network reaches instance metadata and internal
services. `assertSafeUrl` resolves the hostname and requires EVERY answer to be
a public unicast address, over https, on a normal port. Redirects are followed
manually and re-checked, because a public URL that 302s to 169.254.169.254 is
exactly as dangerous as pointing there directly. A stored base URL is
re-validated on every request, because DNS is not a constant.

Twenty-one tests cover it, including IPv4-mapped IPv6 loopback and a hostname
that resolves publicly on the first lookup and privately on the second.

### Credentials

AES-256-GCM under a server-held key. `provider_secrets` has no client grant at
all -- not select, not insert, not for the user who supplied the secret. They
supplied it; they do not need it back, and a read path is a leak waiting for a
bug. `provider_connections` carries only a handle.

Supabase Vault is the right long-term home and the schema is shaped for it:
`secret_id` is opaque, so swapping the store changes one module. Vault is not
available in the in-process Postgres the integration tests run against, and a
credential path that cannot be tested is worse than one that can.

### The client never chooses an upstream

A request names a connection id. The server resolves it, scoped to the
authenticated user, checks revocation, re-validates the URL, and decrypts the
credential for that one call. A caller can pick *which of its own validated
connections* to use and nothing else. `provider_connections` is server-written
as of this milestone: 0002 had granted clients full write access, which was
harmless when a connection was a label and is not harmless now that it carries
a base URL and a mining eligibility.

### Failover does not apply here

A custom connection is an explicit billing relationship with the user's own
credential. Rerouting it through another provider would silently turn a BYOK
request into a USAGE-paid one, so it never happens. Gateway fallback stays only
where semantics are known equivalent.

## Reward eligibility and production trust (M9)

```
src/lib/protocol/reward-policy.ts   proof truth vs reward eligibility
src/lib/secrets/store.ts            SecretStore: vault | aes
src/lib/net/ssrf.ts                 now pins the connection to the validated IP
```

### Two different questions

```
did this compute happen?  -> proof_status    (evidence)
should it earn USAGE?     -> reward_status   (policy)
```

A CONFIRMED proof does not imply a reward, and nothing in the reward layer ever
downgrades or deletes proof evidence. Free hosted inference is real compute,
really observed and really provable -- and paying for it would make bot farming
the cheapest way to mine the moment Usage Points have value.

```
proof -> protocol compute value -> REWARD POLICY -> eligible_compute_micros
      -> mining score -> epoch reward
```

`protocol_compute_micros` still ignores what anyone paid, so two identical
requests measure identically. `eligible_compute_micros` is what survives policy,
and scoring reads that. A held record still says what it *would* be worth, so
releasing a hold is a policy decision rather than a re-measurement.

### Economic source is derived, never declared

| Source | v1 | Why |
| --- | --- | --- |
| `metered_paid` | eligible | a source the user does not control billed them |
| `byok` | held | their own key, cost not established |
| `subscription` | held | flat rate has no per-request cost |
| `free` | **ineligible** | the one hard no |
| `promotional` | held | USAGE's own gateway budget paid |
| `unknown` | held | no trustworthy evidence |

The ordering in `deriveEconomicSource` matters:

1. **A stated zero is always accepted.** It can only reduce a reward, so nobody
   has a motive to lie in that direction, and refusing it would let free compute
   quietly earn.
2. **A stated positive cost is evidence only from a source the user does not
   control.** A custom endpoint saying "this cost $500" is a claim: the same
   person may own the endpoint and the USAGE account. `endpointTrusted` is set
   server-side from the connection's definition origin, never by a client.
3. **USAGE-funded traffic is `promotional`,** whatever it cost. Rewarding it
   would be USAGE paying twice for the same dollar.

Every decision stores its `reward_policy_version`. `usage-reward-policy-v0` is
the grandfather for rows written before the layer existed, so settled epochs
stay reproducible and are never silently re-judged.

### SecretStore

`SecretStore` has two backends and the application never learns which answered.
Production uses **Supabase Vault** through four SECURITY DEFINER functions with
`search_path = ''`, every object schema-qualified, EXECUTE revoked from
public/anon/authenticated and granted only to `service_role`. They are not a
general secret-reading RPC: the owning user id is a required argument and is
checked against the row, so even service_role cannot enumerate another user's
credentials. `vault.decrypted_secrets` is never exposed to a client role.

The AES backend remains for local development and the in-process Postgres the
integration tests run against.

### DNS rebinding is actually fixed

M8 validated the hostname and then let the HTTP client resolve it again, which
is a TOCTOU window: an attacker's resolver can answer publicly on the first
lookup and `127.0.0.1` on the second. `safeFetch` now connects through an undici
dispatcher whose DNS lookup can only return the addresses `assertSafeUrl`
validated. TLS servername and Host still use the hostname, so certificates are
unaffected. Tested against a real loopback server: the flipped answer is never
even requested, and the local service records zero connections.

## Provider connection profiles (provider ≠ protocol)

```
src/lib/providers/profiles.ts   server-controlled profiles: host, auth, probe, documented capabilities
src/lib/providers/validate.ts   non-generative validation with three verdicts
scripts/revalidate-connection.ts  re-check an existing connection with its stored key
```

A provider is a company; a protocol is a wire format. Two providers can both
speak OpenAI's inference format and still differ in where their API lives,
which header carries the key, whether a model list exists, and what a
key-only probe can prove. Treating "OpenAI-compatible" as "api.openai.com
semantics" is how a real OpenAI key entered against `https://openai.com` was
reported as invalid: the website answered 403 and the probe called that a
rejected credential.

| Provider | Base URL (fixed) | Auth | Probe (non-generative) | Prefix | Verified |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `https://api.openai.com` | Bearer | `GET /v1/models` | `v1` | docs, 2026-09-10 |
| Anthropic | `https://api.anthropic.com` | `x-api-key` + `anthropic-version` | `GET /v1/models` | `v1` | docs, 2026-09-10 |
| OpenRouter | `https://openrouter.ai/api` | Bearer | `GET /v1/key` (model list is public, proves nothing) | `v1` | docs + live, 2026-09-10 |
| OpenRouter — Anthropic surface (M16C0) | same connection, `POST /api/v1/messages` at `/api/gateway/provider/<id>/anthropic` | Bearer **and** `x-api-key` (same key); OAuth `anthropic-beta` value dropped | none (surface of an already-validated connection) | `v1` | docs (Anthropic Messages reference, Claude Code cookbook), 2026-09-11; fixtures only, no live proof yet |
| Mistral | `https://api.mistral.ai` | Bearer | `GET /v1/models` | `v1` | docs, 2026-09-10 |
| xAI | `https://api.x.ai` | Bearer | `GET /v1/models` | `v1` | docs (base/auth) + live 401 probe, 2026-09-10 |
| Google Gemini (OpenAI surface) | `https://generativelanguage.googleapis.com/v1beta/openai` | Bearer | `GET /models` | *(none — base carries the version)* | docs, 2026-09-10 |
| Custom | typed, normalised | protocol's documented header | `GET /v1/models` | `v1` | — |

Rules: a known provider's host is fixed by the server (a typed URL whose host
belongs to a known provider is treated as that provider); a custom endpoint
keeps every path segment and loses only a trailing `/v1`; `upstreamPath` never
doubles `/v1` and drops it where the profile says the base carries its
version. Generation-time capabilities (usage, streaming, request identity)
come from the profile's documentation or an observed generation — never from
a successful model list. A recognised profile host counts as a trusted
endpoint for economic evidence; a custom host is the user's.

Three verdicts: **rejected** only on the documented probe's 401 (or 403 on
the provider's real API); **inconclusive** for a missing model list, a 403
from a non-API host, 429, timeouts and malformed bodies — the key is saved
with status `validating` ("credential saved — validation incomplete");
**accepted** otherwise. A rejection stores nothing and returns the user to
the same form. "Test connection" re-runs the same probe with the stored key.

## Proof of economic usage (M14)

```
src/lib/protocol/economic-unit.ts   the unit, its identity, evidence, verification policy
src/lib/protocol/funding.ts         funding evidence from the connection row
src/lib/protocol/snapshot.ts        what a future settled snapshot may read
src/lib/db/economic-dedupe.ts       at most one credit per economic key
supabase/pending/0018_economic_unit.sql   prepared, NOT applied
```

### The unit

One **EconomicComputeUnit** is one unique AI inference that may earn at most
one reward. A local telemetry event, a receipt, a gateway log line and a
provider import row are *evidence about* a unit, never units themselves. The
canonical unit is a `usage_events` row; there is no second table, because a
second truth eventually disagrees with the first.

Three questions are answered independently and never collapsed:

| Question | Column / field |
| --- | --- |
| Did compute happen? | `verification_status`, `proof_status` |
| Is it unique, not already rewarded? | `dedupe_status` (`unique` / `duplicate` / `conflict` / `unkeyed`) |
| Is its funding reward-eligible? | economic verification → `economic_source_class` → `reward_status` |

### Identity

`economic_event_key = "ecu1:" + sha256(version, namespace, provider, kind, id)`,
derived **only** from an authoritative identity: the provider's own request id
(`request-id` / `x-request-id` on the upstream response) first, the gateway's
generation id second, an import bucket identity last. The namespace is the
system that *issued* the id, not the one that observed it, so USAGE's gateway
and a provider import that both see `req_…` derive the same key. A device may
report an id and be correlated by it; it never mints a key. Nothing else is an
ingredient — not a timestamp, not token counts, not a local session or event
id, not a device signature, not a client UUID — and a client-submitted hash is
never accepted. No identity → `NULL` → the unit cannot become economically
verified.

### Authority scope and the reward owner (M14B)

Every identity USAGE anchors a unit on was researched for *where* it is unique:

| Identity | Scope | Basis |
| --- | --- | --- |
| Anthropic `request-id` (`req_…`) | global | "Every API response includes a unique request-id header"; support locates a request from the id alone |
| OpenAI `x-request-id` (`req_…`) | global | documented unique request identifier for reporting to OpenAI |
| OpenRouter `gen-…` | global | `GET /api/v1/generation?id=` takes the id as its only parameter. OpenRouter documents **no** request-id header, so an `x-request-id` seen from it is a proxy's and is never an identity |
| Vercel `gen_<ulid>` | global | `GET /v1/generation?id=` by id alone; ULID |
| OpenAI org import bucket | tenant | the bucket identity carries the organization id the admin API authenticated |
| user-controlled endpoint (custom connection) | **connection** | the server may return any id; namespace = `connection:<server-issued uuid>`, never a client label |

Because every trusted identity is global or tenant-scoped by construction, the
key carries **no USAGE user id**. Consequences, all tested on PGlite:

- **Cross-user replay:** the same request id, generation id or import identity
  claimed by two accounts is one unit; the second claim is stored as held
  evidence pointing at the first (`economic_duplicate_of`). Credits: 1.
- **Legitimate scope collision:** the same request id from two user-controlled
  endpoints is two units (both `byok`, both held — scope distinguishes compute,
  it does not make anything paid).
- **Reward owner** is the `user_id` of the row that *is* the unit. Nothing
  reassigns it: clients cannot update `user_id` (grants), and 0018 makes
  `user_id` immutable for every row at the database. No separate owner column:
  it would be a second copy of the same fact.
- A provider request id anchors a unit only for providers that document one
  as unique (`DOCUMENTED_REQUEST_ID_PROVIDERS`); otherwise the gateway's
  generation id does. A trusted gateway's generation id is namespaced by the
  gateway provider, not by the connection that relayed it.

Dedupe is therefore global: `loadEventsByEconomicKey(keys)` takes no user.

### Evidence authority, by field

Researched against the surfaces USAGE actually uses (September 2026). Authority
is field-specific; a device is authoritative for exactly one fact.

| Field | Order | Notes |
| --- | --- | --- |
| request identity | provider > usage_gateway > import > device | admin exports carry no per-request ids |
| token usage | provider > usage_gateway > import > device | |
| actual cost | provider > usage_gateway > import; **never device** | Claude Code's `cost_usd` is the tool's own estimate |
| funding class | provider account surface > usage_gateway > import; **never device** | OpenRouter `/api/v1/key#is_free_tier`; USAGE's own key = `usage_credit` |
| model | provider > usage_gateway > device | |
| "it was observed" | device only | the whole of what an Ed25519 device signature proves |
| protocol value, eligibility, reward status | USAGE policy, exclusively | |

What each surface actually exposes (`AUTHORITATIVE SERVER` = hosted USAGE code
read it off the wire; `PROVIDER` = the provider states it about itself;
`DEVICE` = software on the user's machine says so):

| Surface | Identity | Usage | Cost | Funding |
| --- | --- | --- | --- | --- |
| Vercel AI Gateway | `id` / `providerMetadata.gateway.generationId` (`gen_<ulid>`) — PROVIDER; upstream `request-id` — AUTHORITATIVE SERVER | response `usage` — AUTHORITATIVE SERVER; `/v1/generation` native counts — PROVIDER | `/v1/generation.total_cost` (debited from balance) — PROVIDER; `is_byok` — PROVIDER | `/v1/credits` gives balance and `total_used` only; **purchased vs free monthly credit is not distinguishable per request or per account via API** (BYOK requires purchased credit; the dashboard Routing filter shows system vs BYOK) → USAGE's own key is `usage_credit`, everything else UNKNOWN |
| OpenRouter | completion `id` (`gen-…`) — PROVIDER; `x-request-id` — AUTHORITATIVE SERVER | `usage` — AUTHORITATIVE SERVER; `/generation` native counts — PROVIDER | `usage.cost` ("total amount charged to your account"), `/generation.total_cost`, `upstream_inference_cost`, `is_byok` — PROVIDER | `/api/v1/key.is_free_tier` = "whether the user has paid for credits before" — PROVIDER, **account-level, not per request**; `usage`/`usage_daily` aggregate spend — PROVIDER |
| Anthropic / Claude Code | `request-id` header (`req_…`), unique per response, also in error bodies — PROVIDER; Claude Code OTel `request_id` — DEVICE | OTel token counts — DEVICE | OTel `cost_usd` — DEVICE (estimate) | UNKNOWN (no customer surface reconciles a request id; Admin usage API is aggregate) |
| Codex 0.153.3 (real wire) | **none** — no request or response id on any event | `codex.sse_event(response.completed)` counts + shared `model` — DEVICE | `codex.turn_cost.usage.estimated_usd` — DEVICE (estimate, not read) | UNKNOWN (`auth_mode: Chatgpt` = subscription, not read as funding) |

### Classification: cost > 0 is not payment

`classifyEconomicSource` (economic-verification-v1) is stricter than the M9
rule in front of which it sits. A positive list-price cost is charged against
promotional credit exactly as it is against purchased credit, and the response
looks identical, so cost proves that compute *happened* and what it was
*worth* — never that anyone *paid*. Payment is a fact about the account, and
only the provider's account surface can state it.

| Funding class (server-derived) | Class | v1 |
| --- | --- | --- |
| USAGE's own key (`usage_credit`) | promotional | held |
| provider says never purchased (`free_tier_account`) | promotional | held |
| authoritative cost = 0 | free | **ineligible** |
| user-controlled endpoint | byok | held |
| provider says BYOK upstream (`byok_upstream`) | byok | held |
| provider says paid account + authoritative cost > 0 + trusted endpoint | metered_paid | **eligible** |
| flat plan | subscription | held |
| anything else | unknown | held |

Protocol compute value (`protocol_compute_micros`, from the frozen pricing
snapshot), actual cost (`actual_cost_micros`, the provider's figure) and
funding (`raw_metadata.funding_class`) remain three fields. A held record still
says what it would be worth.

### economic-verification-v1

Decides whether the evidence is strong enough to hand the reward policy a class
at all, and records `economic_verification_{status,reason,policy_version}` on
every unit. `verified` needs an authoritative identity, trusted evidence,
authoritative usage, uniqueness and — for `metered_paid` — provider-stated paid
funding. `byok` is verified only when the upstream account is proven paid,
which no surface USAGE uses can do today, so it is held. Device-only evidence
is `not_verified` (`local_only`), signed or not. `usage-reward-policy-v1` is
unchanged; it now receives classes it could not have been lied to about.

### At most one credit

`applyEconomicDedupe` runs before every insert: a record whose key is already
held by another event (a different source's view of the same request) is stored
as evidence with `reward_hold`, `eligible_compute_micros = 0`,
`dedupe_status = duplicate` and a pointer to the unit. The natural key still
drops exact replays. Correlation gained a third outcome: a device observation
whose model or counts disagree with the trusted record beyond 1 % is a
**conflict** — the observation does not rise, the event's reward is held, and
the disagreement is recorded. Holding is the one economic effect a device
upload can have, and it only ever reduces what is paid.

Migration 0018 (prepared, not applied) gives the key and statuses real columns,
a unique partial index on `(user_id, economic_event_key) where dedupe_status =
'unique'`, a trigger making a settled row's economic columns immutable, and
append-only triggers on the ledger and allocations. Until it is approved, the
ingestion code is the enforcement and `src/lib/db/economic-unit.test.ts` holds
it to the invariant: replay ×1000 → one unit; local + routed + import → three
evidence rows, one unit, one credit; a signed 10⁸-token forgery → nothing
economic anywhere; a spoofed funding class → rejected at every door.

### What `metered_paid` proves, and what it does not

OpenRouter's `is_free_tier` is an *account* fact ("has paid for credits
before"); `usage.cost` / `total_cost` is a per-inference *charge*; `is_byok`
and `upstream_inference_cost` describe the user's own upstream key. Vercel's
`/v1/credits` gives balance and lifetime spend only. **No surface USAGE uses
can say, per request, whether purchased or bonus/promotional/monthly-free
credit paid for it** on an account that has purchased. `metered_paid` means
exactly *paid-capable account + positive charged inference + endpoint the
user does not control* — "paid_account_metered", not source-of-funds
provenance. The name is kept; M15 must read it with that meaning. The
conservative rule follows: no provider statement of a paid account →
promotional, held; USAGE's own key → promotional, always.

### Immutable history and the corrections model (M14B)

Once an epoch is settled, nothing that explains its points may move, and
0018 makes the database refuse it whoever asks (service role included):

| Table | After settlement |
| --- | --- |
| `usage_events` (settled row) | economic, identity, usage, model, epoch, verification and owner columns frozen; DELETE refused; `user_id` frozen on every row |
| `reward_epochs` (settled) | pool, network score, scoring version, bounds, state, kind, settlement time frozen; DELETE refused; open epochs free |
| `score_records` | rows whose `(day, algorithm_version)` fall in a settled epoch: UPDATE/DELETE refused; other versions and open days free |
| `reward_allocations`, `usage_point_ledger` | append-only |
| `protocol_model_prices` | rates frozen (identical republish allowed); DELETE refused |
| `protocol_pricing_versions` | only `status` may change; DELETE refused |
| `reward_policy_versions` | only `status`/`description` may change; DELETE refused |

Allowed on purpose: provenance enrichment on a settled event
(`provenance_sources`, `correlation_status`), status transitions of pricing
and policy versions, and everything on open epochs and unsettled rows.

**History is not edited.** A future correction is a new append-only record —
a compensating ledger entry or allocation with an explicit reason, the policy
version that authorised it, and a reference to what it corrects — settled
under its own epoch. The correction system is not built; the schema now
refuses the alternative.

### What a future snapshot could read

`src/lib/protocol/snapshot.ts` is not a snapshot. It states what a settled
allocation must be able to name — allocation id, user, epoch, settled points,
scoring version, reward policy version, economic verification policy version,
proof reference — and which rows are refused: unconfirmed, reported-only,
held, unpriced, unsettled, duplicate or conflict, free or promotional. Local
observations are never candidates: their table has no economic column.

## Miner distribution (M16D)

The website is the official download surface; GitHub Releases are the binary
origin. Neither repository imports the other.

- **Origin.** `Deniscoke/USAGE-Miner`, built and released only by its own
  workflow from a GitHub-hosted runner. A locally built executable is never a
  release artifact.
- **Asset names are stable**, without a version:
  `USAGE-Miner-Windows-x64-Setup.exe`, `USAGE-Miner-Windows-x64.exe`,
  `SHA256SUMS.txt`, `release.json`. A versioned name would change every link
  in the product on every release. The version lives in the tag, the PE
  version resource and `release.json`.
- **The site reads, it does not proxy.** `src/lib/miner/distribution.ts`
  resolves the newest non-draft release from the GitHub API and reads that
  release's own manifest and checksum file; the bytes are served by GitHub to
  the browser. There is no endpoint that fetches a file by a URL a visitor
  supplies.
- **Every figure comes from the release it describes.** A checksum is taken
  from the release's manifest, then its `SHA256SUMS.txt`, then the digest
  GitHub recorded at upload — never from the manifest compiled into this
  server, which describes a different build.
- **Fail soft, never loud.** Rate limited, unreachable or unparsable ends at
  the last build known to be downloadable, marked `source: "pinned"`.
- **`signed` is never inferred.** It is true only when the release's own
  manifest says so, and that manifest is written by the workflow step that has
  just verified an Authenticode signature against the expected publisher.
- **Version policy is not distribution.** The page's update wording comes from
  the published version; whether an old build may still route requests is
  decided server-side against `MINIMUM_MINER_VERSION` on every request.

### `usage://` deep links — designed, deliberately not built

A website button that opens the installed app is the obvious next step, and
the obvious next step is a protocol handler registered for the whole user
account. Not now, and the reasons are worth recording:

- A registered scheme is callable by **any** page the user visits, not only by
  USAGE. `usage://tool/claude-code` would mean a random site could ask the
  miner to launch a local AI tool, so the handler would need its own
  confirmation UI and origin check — a security surface bigger than the
  convenience it buys.
- It is an install-time registry write, which is exactly the kind of
  machine-wide change the miner otherwise avoids.
- There is nothing it enables. The app is already running or one Start Menu
  click away, and pairing is a browser flow that completes on its own.

If it is ever built: one verb only (`usage://open`), no parameters that select
a tool, a connection or a credential, a visible confirmation in the app for
anything beyond raising the window, and registration under HKCU only.

### Download analytics

None. No event is recorded when somebody clicks the download button, and the
page does not fingerprint. A download count is not worth a request from a
visitor who has not signed in, and it would need a table to hold it. Release
asset download counts are already visible on GitHub if the question ever
matters.

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
| Local Claude Code / Codex telemetry | Device-attested at most (M13). Claude Code carries the provider request id and can be correlated exactly; Codex 0.153.3 carries model and counts but no id (real wire capture, M14). |
