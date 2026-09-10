# M15 — Mining economics red team and Sybil resistance

Research, simulation and candidate design. **Nothing in this milestone changes
production scoring, pricing, policy, the open epoch, or the schema.** The only
code added is a simulator (`src/lib/domain/tokenomics/`), its tests, and a
read-only results script (`npm run usage:m15:simulate`).

Calibration point: the real M14C unit (`usage_events` `c75acc2e`, 1 micro-USD
of `openai/gpt-5-nano` on 2026-09-10) scores exactly `1.0000` under v1, and the
simulator reproduces that figure (test "the real M14C unit scores exactly as
production recorded").

---

## 1. The current mechanism (usage_score_v1), read from code

| Stage | Where | What actually happens |
| --- | --- | --- |
| Economic unit | `usage_events` row, 0018 | one row per authoritative compute identity; `dedupe_status = unique` |
| Protocol compute | `src/lib/pricing/compute.ts` `protocolComputeValue` | Σ over token classes of `priceTokens(rate, tokens)`; each class rounded **half-up to whole micro-USD independently**; cache read/write fall back to the input rate when the snapshot has no separate price; reasoning rate is `null → 0` |
| Eligible compute | `reward-policy-v1` `decideReward` | `eligible_compute_micros = protocol_compute_micros` when `reward_status = eligible`, else 0 |
| Aggregation | `src/lib/db/ingest.ts` → `scoreRecords(events)` | events grouped by **`(user_id, epoch_id)`**, where `epoch_id = epoch-<UTC day of occurred_at>` (carried forward to the first open epoch if that one closed) |
| Transformation | `src/lib/domain/scoring.ts` V1 | `points = round4( sqrt( Σ eligible_micros / 1e6 ) × 1000 )` — **sqrt of the daily USD sum per account** |
| Epoch user score | `score_records(user_id, day, algorithm_version)` | one row per (user, day); `points` above |
| Network score | `finalizeEpoch` | Σ `points` over all users for that day with `points > 0` |
| Network share | `networkShare` | `user / network` |
| Estimate | `estimateReward` | `floor(share × pool)`, non-binding |
| Settlement | `settleEpoch` → `allocateEpochRewards` | largest-remainder integer split of the pool; allocation id `<epoch>:<user>` unique; ledger append-only (0018 triggers) |
| Emission | `src/lib/protocol/emission.ts` `MINING_DEV_V1` | **100,000 points per daily epoch**, network `development` |

**Aggregation key: `user_id × UTC day`.** Not provider, not device, not
connection, not economic unit. Device, connection, key and model are invisible
to the score. The USAGE account is the only identity the concave step sees.

Confirmed: the transformation is exactly `sqrt(daily eligible protocol
compute in USD) × 1000`, four-decimal rounding, per account, per day.

---

## 2. The account-splitting property (formal)

Let `f` be the per-account transformation and `C` an actor's eligible compute
on one day. One account scores `S₁ = f(C)`. `n` accounts holding `C/n` each
score `Sₙ = n·f(C/n)`.

For `f(x) = √x`: `Sₙ = n·√(C/n) = √n·√C`, so **`Sₙ / S₁ = √n`**, independent of `C`.

For `f(x) = x^α`: `Sₙ / S₁ = n^(1−α)`. For `f(x) = log(1+x)` the ratio grows
without bound as `n → ∞` until `C/n ≪ 1`, then approaches `C / log(1+C)`.

| n | √n (v1 score multiplier) |
| --- | --- |
| 2 | 1.414 |
| 5 | 2.236 |
| 10 | 3.162 |
| 100 | 10.000 |
| 1000 | 31.623 |

Every strictly concave `f` applied per account rewards splitting, because
Jensen's inequality gives `n·f(C/n) ≥ f(C)` with equality only for linear `f`.
This is not a tuning problem; it is the definition of concavity.

The *reward* multiplier is smaller than the score multiplier because the pool
is fixed and the attacker dilutes themself as their share grows
(`share = S/(S+H)` is concave in `S`). Simulated against 99 honest users
spending ≈$1 each, an attacker with $10:

| accounts | score × | share | points | reward × | honest reward × |
| --- | --- | --- | --- | --- | --- |
| 1 | 1.000 | 3.04% | 3,042 | 1.000 | 1.000 |
| 2 | 1.414 | 4.25% | 4,248 | 1.396 | 0.988 |
| 10 | 3.162 | 9.03% | 9,030 | 2.968 | 0.938 |
| 100 | 10.000 | 23.88% | 23,900 | 7.857 | 0.785 |
| 1000 | 31.623 | 49.80% | 49,836 | 16.383 | 0.517 |

**Maximum observed reward multiplier: 16.4× at 1000 accounts** (the score
multiplier is 31.6×; the pool's fixed size absorbs the rest). The tests in
`simulator.test.ts` §6 assert this and are designed to fail v1.

---

## 3. Simulation methodology

`src/lib/domain/tokenomics/simulator.ts`:

- A **unit** is `{accountId, principalId, deviceId, connectionId, model, day, computeMicros, actualCostMicros}`.
- A **rule** is `{key: account | principal, fn, timeBucket: day | epoch}`. Production v1 is `{account, sqrt, day}`.
- `scoreEpoch` groups by `(key, day)`, transforms, sums per key, computes
  network share and a largest-remainder integer allocation exactly like
  `allocateEpochRewards`. For `key: principal` the principal's score is
  distributed to its accounts pro rata to compute, so "reward owner = account"
  is preserved while the concave step sees the whole actor.
- Populations are built with a seeded PRNG (mulberry32, seed 42) and a
  log-normal-ish spread. No network, no database, no randomness outside the seed.
- `splitExperiment` holds an actor's compute fixed and varies exactly one
  representation dimension (accounts, devices, connections, requests, days).
- `paidFarm` computes the break-even value-per-point at which real spend is
  recovered. `P` is a normalised sweep, **not a token price**.

All numbers below are from `npm run usage:m15:simulate` (pool 100,000/epoch).

---

## 4. Baseline populations (v1)

| population | Gini of points | observation |
| --- | --- | --- |
| A: 100 equal honest | 0.000 | 1,000 points each |
| B: 99 normal + 1 whale 100× | 0.209 | whale has 47.8% of compute, gets 9.0% of reward |
| D: 990 small + 10 whales 250× | 0.242 | whales have 69.5% of compute, get 13.5% of reward |

v1 dampens whales strongly. That is exactly the property an honest whale can
recover by splitting (§2), so **whale dampening and Sybil bonus are the same
number seen from two sides**.

E, F, G (many devices / connections / keys under one account): reward
identical (§7–8). H (many USAGE accounts, one actor): §2/§6, the attack.

---

## 5. Attack results

### Request splitting (§5) — SAFE, one caveat
Simulator: 1 / 10 / 100 / 10,000 requests of the same daily compute → reward ×1.0000.
Real `scoreRecords`: 100 records = 1 record of the same total (tested).

Caveat, from the real pricing code: `priceTokens` rounds each token class
**half-up to whole micro-USD per request**. gpt-5-nano input is 0.05 micro per
token: 10 tokens → 1 micro (real 0.5), 9 tokens → 0. Ten 10-token requests
are worth 10 micro; one 100-token request is worth 5. The leak is **absolute,
≤ 0.5 micro per component per request**, so doubling $1 of protocol value this
way takes ~2,000,000 requests. The M14C unit itself is an instance
(`cost_rounded: true`, actual $0.0000005 → 1 micro). Not economically
exploitable at any plausible request rate; worth fixing in a future pricing
version by accumulating in nano-USD or rounding per day. Dedupe is untouched.

### Account splitting (§6) — CRITICAL, v1 fails
Table in §2. 2 accounts already give +39.6%; the ≤1% invariant is violated at
the first split.

### Device splitting (§7) — SAFE
1 vs 100 devices: ×1.0000. Devices are not a scoring key; local telemetry
creates no economic unit (M14 tests). No vulnerability.

### Connection / key / model splitting (§8) — SAFE *within one account*
100 connections, 50 models, 10 provider accounts under one USAGE account:
×1.0000. **Limitation:** the only thing multiple provider accounts buy an
attacker is more USAGE accounts (§6). USAGE cannot see whether two provider
accounts belong to one person unless the provider exposes a stable principal
(§8 of this document, below).

### Provider-account splitting — UNDETECTABLE today
See §8 audit. No provider gives a normal inference key a stable *payer*
identity that USAGE can rely on, except partially OpenRouter (`creator_user_id`
on the OAuth-minted key) and xAI (`user_id`, `team_id`).

### Day splitting (§12) — INTENDED but real: √d
v1 keys by day, so `C` over `d` days scores `√d × f(C)`. Simulated: 2 days
×1.41, 7 days ×2.63, 30 days ×5.38 in *reward* (score ×√d exactly). Each day
has its own pool, so this is "compute spread over d epochs takes a share of d
pools", which is what daily epochs mean. It is a multiplier relative to
bursting, and it is the largest legitimate one. Midnight-boundary bursts are
just d = 2 (×1.41). Nothing resets at settlement beyond the day boundary.

### Cheap-model / pricing arbitrage (§10) — NONE in protocol value; real at the edges
Protocol value per class is the frozen v2 list rate, and paid OpenRouter
charges list rate, so **score per real dollar is 1.0 for every model and token
class** when billed at list. Arbitrage exists only where actual ≠ list:
- provider discounts USAGE cannot see (batch APIs ~50%, committed use, promos)
  → policy already holds `promotional` and `byok`; a *paid* account with a
  negotiated discount would earn at list;
- sub-micro rounding (above);
- **cache-read fallback**: `nvidia/nemotron-3-nano-30b-a3b` has no cache-read
  price, so cache reads are valued at the full input rate. If its provider
  bills cache reads cheaper, cache-heavy traffic mines above cost on that model.
- zero-priced models (`inclusionai/ling-3.0-flash-*`) mine nothing.

### Cache farming (§11) — SAFE where priced
Anthropic/OpenAI cache reads are valued at 10–12% of input (tested). Reasoning
tokens add 0 on top of output (rate `null`). Reward follows protocol value, not
displayed token totals. The nemotron fallback is the one gap.

### Paid Sybil farm (§9) — the identity question in money
Same $10 real spend, split across identities, v1:

| identities | points | share | break-even value / point |
| --- | --- | --- | --- |
| 1 | 3,042 | 3.0% | 3.29e-3 |
| 10 | 9,030 | 9.0% | 1.11e-3 |
| 100 | 23,900 | 23.9% | 4.18e-4 |
| 1000 | 49,836 | 49.8% | 2.01e-4 |

Under linear scoring the row is flat (≈8,380 points, 1.19e-3 $/point). Wash
farming becomes rational the moment the market value of a point exceeds the
break-even; under v1 that threshold **falls ~√n with identity count**, so
concavity makes the farm cheaper the more it is split. Paid compute is not
Sybil resistance; it only sets the entry price per identity.

### Multi-epoch farming (§13)
v1 has no cross-epoch state at all (no caps, no reputation), so there is
nothing to reset. Any v2 with per-principal history must key that history to
the principal, not to the account, device or connection — reconnecting a
provider today revives the same connection row (M14C fix), which is the right
direction, but a new USAGE account is a clean slate by construction.

### Collusion (§14)
10 genuine humans coordinated economically get exactly the √10 = 3.16× score
of one human with the same spend; 100 get 10×. **Proof of personhood does not
touch this**: they are distinct humans. A payer reimbursing humans is
indistinguishable from humans spending. No mechanism in this document prevents
it; principal-concave scoring caps the *unit* of collusion at "one funding
source" only where the funding source is visible, and linear scoring makes
collusion pointless (n humans earn exactly n shares).

---

## 6. The reward principal

Definition: **the entity across which eligible compute is summed before any
concave transformation.** Reward *ownership* can stay with the USAGE account
regardless.

| candidate | Sybil resistance | privacy | availability | portability | recoverability | false merges | false splits | complexity | centralisation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A USAGE account (today) | none | best | always | n/a | email | none | every extra account | none | USAGE |
| B provider billing account | good *if exposed* | payer id hash stored | OpenRouter (partial), xAI; not OpenAI/Anthropic/Google/Mistral via inference key | per provider | provider | shared team keys | one person, many providers | medium | provider |
| C provider org / workspace | good | org id hash | admin keys only | per provider | provider | teams merge many humans | many orgs per person | high | provider |
| D verified human | best for bots | ZK if World ID | limited geography, friction | portable | protocol recovery | none | none | high | World / Human.tech |
| E wallet | none | pseudonymous | always | portable | seed loss | none | infinite | low | none |
| F installation / device | none, privacy-hostile | worst | always | none | none | shared PCs | many devices | low | USAGE |
| G economic funding source (card / bank) | good | terrible, KYC-adjacent | via provider only | no | n/a | families | many cards | very high | banks |
| H linked-principal graph (B+D+risk) | best achievable | depends | incremental | yes | yes | tunable | tunable | highest | mixed |

USAGE can prove today: A always; B for OpenRouter OAuth (`creator_user_id`)
and xAI (`user_id`/`team_id`); nothing else. **Do not choose a principal USAGE
cannot prove.**

---

## 7. Provider principal evidence (official docs, current)

| provider | what a normal inference key can learn | stable payer identity? |
| --- | --- | --- |
| OpenRouter | `GET /api/v1/key` → `label, limit, usage*, byok_usage*, is_free_tier` ([docs](https://openrouter.ai/docs/api-reference/limits)). The key object returned by the OAuth PKCE exchange and by the keys API carries **`creator_user_id`** (`user_…`) ([create key docs](https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key)); observed live in M14C on `/api/v1/key`. | **Partial: yes.** `creator_user_id` is the OpenRouter user who authorised the key. Not documented as a stability guarantee; one human can hold several OpenRouter accounts. |
| OpenAI | Response header `openai-organization` (org slug) and request headers `OpenAI-Organization` / `OpenAI-Project` ([reference](https://developers.openai.com/api/reference/overview)). Org/project ids (`org-…`, `proj_…`) are enumerable only through the Administration API with an **admin key** ([list projects](https://developers.openai.com/api/reference/go/resources/admin/subresources/organization/subresources/projects/methods/list)). | **Org slug via header: yes, weak.** It identifies the org, not the payer; personal orgs are 1:1 with a person but anyone can create many. Not exposed as a documented stable id to inference keys. |
| Anthropic | Admin API (`/v1/organizations/me`, `/users/user_…`, `/workspaces/wrkspc_…`, `/api_keys/apikey_…` with `principal.user_id`) requires an **Admin key or `org:admin` OAuth**; "unavailable for individual accounts" ([Admin API](https://platform.claude.com/docs/en/manage-claude/admin-api)). A normal key exposes nothing about its org. | **No** for inference keys. |
| Google Gemini | Keys are bound to a Google Cloud project for billing; "standard keys don't identify a caller" ([API keys](https://ai.google.dev/gemini-api/docs/api-key)). No project id in responses. | **No.** |
| Mistral | Keys are scoped to a workspace; `workspace_id` appears only in the Admin API, which needs a dedicated admin key ([Admin API](https://docs.mistral.ai/admin/admin-api/overview), [API keys](https://docs.mistral.ai/admin/identity-access/api-keys)). | **No** for inference keys. |
| xAI | `GET /v1/api-key` returns `api_key_id, user_id, team_id, name, acls, …` ([reference](https://docs.x.ai/developers/rest-api-reference/inference/other)). | **Yes:** `team_id` (billing team) and `user_id`. Whether the inference key may call it is not stated; must be probed with a real key before relying on it. |
| Vercel AI Gateway | Key is team-scoped, deactivated when its creator leaves the team ([auth docs](https://vercel.com/docs/ai-gateway/authentication-and-byok)). No team id exposed to the key holder. | **No.** (And USAGE's own gateway key is `promotional` by policy anyway.) |

Conclusion: a **provider billing principal is provable today for OpenRouter
OAuth connections and probably xAI, and for nobody else.** An API key is not
a person and not an account.

---

## 8. Proof of personhood (design only, nothing integrated)

| | World ID | Human Passport |
| --- | --- | --- |
| guarantee | one nullifier per (human, app, action); Orb level is a strong uniqueness signal; Device/Document levels weaker ([concepts](https://docs.world.org/world-id/concepts)) | composite score from stamps (KYC, biometrics, web3/web2 activity) plus model-based Sybil detection of addresses ([docs](https://docs.passport.human.tech/)) |
| privacy | ZK proofs, unlinkable across apps | stamps encrypted, user-controlled; score is a probability, not a proof |
| availability | Orb locations limited geographically; Device/Document broader | global, web-based |
| friction | app install + verification; Orb visit for top level | wallet + collecting stamps |
| centralisation | World Foundation / Tools for Humanity operate Orbs and the app | Human.tech operates scoring |
| cost | SDK free (IDKit, open source) | free core |
| bot resistance | strong at Orb level | statistical |
| multi-account | one World ID per human, enforced by iris uniqueness | not enforced; score can be replicated with effort |
| collusion | none (distinct humans) | none |

**Would optional PoP materially improve reward integrity?** Yes for the
*bot / synthetic account* half of Sybil: a `verified_human` principal with
Orb-level uniqueness bounds one human to one concave bucket. It does nothing
for collusion, key lending, or paid humans. It should stay optional and
additive (a principal-linking signal with a confidence weight), never a KYC
gate, never biometric-mandatory. **Not needed now**: at 2 real users there is
nothing to protect, and today's binding constraint is the principal, not the
human.

---

## 9. The three families, quantified

$10 attacker vs 99 honest, 100-way account split; whale = one honest $100 user:

| rule | 100-way split reward × | attacker share after split | 100× whale share |
| --- | --- | --- | --- |
| linear | 1.002 | 8.4% | 47.8% |
| account-concave sqrt (v1) | 7.857 | 23.9% | 9.0% |
| principal-concave sqrt, principal known | 0.996 | 3.0% | 9.0% |
| principal-concave sqrt, principal unknown | 7.857 | 23.9% | = v1 |

The last row is the whole result: **principal-concave is exactly v1 for every
actor whose principal USAGE cannot see.** It is only better where the
principal is proven.

Other concave functions (analytic, $100 actor):

| function | 100× whale scores × | 2-way split | 10-way | 100-way | 1000-way |
| --- | --- | --- | --- | --- | --- |
| linear | 100 | 1.000 | 1.000 | 1.000 | 1.000 |
| sqrt / pow0.5 | 10 | 1.414 | 3.162 | 10.0 | 31.6 |
| pow0.6 | 15.8 | 1.320 | 2.512 | 6.31 | 15.8 |
| pow0.7 | 25.1 | 1.231 | 1.995 | 3.98 | 7.94 |
| pow0.8 | 39.8 | 1.149 | 1.585 | 2.51 | 3.98 |
| pow0.9 | 63.1 | 1.072 | 1.259 | 1.585 | 1.995 |
| log1p | 6.7 | 1.704 | 5.196 | 15.0 | 20.7 |
| capped $10/day | 10 | 2.000 | 10.0 | 10.0 | 10.0 |
| knee $1 then sqrt | 10 | 1.414 | 3.162 | 10.0 | 10.0 |

For power laws `dampening × split = n` exactly. You cannot buy whale dampening
without paying the same factor in Sybil bonus. Caps are worse: they are
*maximally* splittable up to the cap.

---

## 10. The hard invariant

> For a fixed set of authoritative units and a fixed principal, rearranging
> them across accounts, devices, connections, keys and models changes the
> principal's reward by ≤ 1%.

- Devices, connections, keys, models, requests: **holds under v1 today** (×1.0000, tests §7–8, §5).
- Accounts: **violated under v1** (×1.396 at n = 2).
- Principal-concave: **holds for accounts (×0.996) where the principal is
  identified** (tests §20), and **cannot be enforced at all where it is not** —
  an unlinkable account is a new principal by definition. This is a statement
  about information, not cryptography: no signature scheme can prove two
  strangers are the same payer.

---

## 11. Risk engine vs reward formula

Keep them separate. The reward formula is deterministic, versioned
(`usage_score_v*`, `usage-reward-policy-v*`, `usage-pricing-v*`) and
explainable per event. Risk signals — many accounts sharing one
`creator_user_id`, one device, identical timing, rapid churn, shared funding —
may **hold, flag, or route to review**, recorded as an explicit
`reward_status = held` with a `reward_reason`, exactly as `promotional` and
`byok` are held today. No opaque score ever edits an immutable allocation.

Device identity stays what it is now: telemetry provenance and rate-limit
material. It is not a principal and must not become one (§21 of the brief).

---

## 12. usage_score_v2 candidates

### Candidate 1 — LINEAR (`score = Σ eligible_compute_micros` per account per epoch)
- principal: none needed; representation-neutral by construction
- evidence: what exists today
- Sybil: **neutral** (×1.000 at any n); no bonus, no penalty
- whales: proportional (100× compute → 100× score, 47.8% share in the test)
- privacy: none
- attack cost: none needed — the attack has no payoff
- complexity: trivial; new algorithm version in the registry
- migration: none (new `algorithm_version` rows; history untouched)

### Candidate 2 — PRINCIPAL-CONCAVE (`Σ over principal per day → sqrt → pro-rata to accounts`)
- principal: `provider_account_identity_hash` from OpenRouter `creator_user_id`
  / xAI `team_id`, falling back to the USAGE account
- evidence: the hash column already exists (0011) but is `null` everywhere; it
  would need to be written at OAuth connect / validation
- Sybil: ×0.996 where linked; **= v1 (×7.9 at n = 100) where not**
- whales: dampened like v1 (9.0%)
- privacy: stores a salted hash of a provider user id
- attack cost: one provider account per USAGE account (≈ free)
- complexity: medium; cross-user aggregation at scoring time
- migration: none strictly (column exists), but a backfill job

### Candidate 3 — LINEAR NOW, CONCAVE-BY-CONFIDENCE LATER
`score = Σ compute × (1 − λ·(1 − g(compute_principal)))` … in plain words:
linear for everyone; a concave *bonus* applied only to compute whose principal
is proven (PoP or provider principal), never a concave *penalty* on unlinked
compute. Unlinked compute can never earn more than linear; proven principals
earn a whale-dampened share **among themselves**.
- Sybil: unlinked actors gain nothing by splitting (linear); linked actors
  cannot split (principal)
- whales: proportional until they prove a principal, then dampened relative to
  other proven principals
- privacy: opt-in
- complexity: high; two-pool allocation needs its own analysis
- migration: none until adopted

### Recommendation: **Candidate 1, linear, as usage_score_v2 — until a trustworthy principal exists for most compute.**

Why: the simulations show that every concave per-account rule pays a Sybil
bonus equal to its whale dampening, and that principal-concave only helps for
the ≈ one provider (OpenRouter OAuth) where a principal is visible. With two
real users and one eligible unit, whale dampening protects nobody and the
Sybil bonus is a standing invitation. Linear makes account count, device
count, key count and day count all irrelevant, which satisfies the hard
invariant everywhere, including where the principal is unknown.

Remaining attack under linear: **whales dominate proportionally, and
collusion/paid-human farming earns exactly its spend share.** A fixed pool
still means every extra dollar dilutes everyone, so wash compute is a transfer
from other miners, not money creation, and it is rational only when a point is
worth more than its break-even (§9 table, flat 1.19e-3 in the test).

Privacy cost: none. Identity dependency: none.

---

## 13. The formal answer to §24

**Can USAGE have concave rewards + permissionless pseudonymous accounts + no
scarce identity resource + Sybil resistance? No.**

Sketch: with no scarce identity resource, creating an account has cost 0, so
an actor with compute `C` can hold `n` accounts for any `n`. Sybil resistance
means `n·f(C/n) ≤ (1+ε)·f(C)` for all `n`. For strictly concave `f`, Jensen
gives `n·f(C/n) > f(C)` with the gap unbounded as `n` grows (for `sqrt`, `√n`).
So any strictly concave per-account `f` is Sybil-exploitable, and the only `f`
satisfying the bound for all `n` is linear (up to `ε`). Concavity therefore
requires the aggregation key to be a scarce resource (a proven principal, a
human, a payer), which contradicts "no scarce identity resource". This is the
same impossibility that underlies quadratic funding's dependence on identity.

What is possible: linear rewards without identity; concave rewards **over a
scarce principal** for the subset of compute where that principal is proven;
risk holds for the rest. Nothing in between is honest.

---

## 14. Open questions for the owner

1. Is whale dominance under linear scoring acceptable for the beta network, or
   is dampening worth a provable principal requirement for anyone who wants it?
2. Should OpenRouter `creator_user_id` (already observed live) be hashed and
   stored at connect time now, as evidence only, so a later v3 has history?
3. Should the pricing snapshot v3 fix sub-micro rounding (accumulate in
   nano-USD, round per day) and add a cache-read price for nemotron?
4. Day multiplier √d: keep daily epochs (and accept that steady users out-earn
   bursty ones) or move to longer epochs under linear (where it stops mattering)?

None of these are implemented. Production scoring is unchanged.


---

# M15B — Linear beta decision, precision, cache pricing, bootstrap emission

## Owner decision (locked, 2026-09-10)

**Beta recommendation: `usage_score_v2` = LINEAR eligible protocol compute.**

Reasons: account splitting neutral, device splitting neutral, connection and
key splitting neutral, no identity dependency, deterministic, provider-neutral,
privacy-neutral. **Accepted trade-off: whales receive proportional influence.**
No account concavity. No principal concavity yet. No provider-principal
requirement for beta participation. Epoch-2026-09-10 stays open.

## usage_score_v2 (candidate, DRAFT, inactive)

`score_v2 = Σ eligible_compute_micros` per account per epoch. Registered in
`src/lib/domain/scoring.ts` with `status: "draft"` and `unit: "eligible
protocol micro-USD (integer)"`. No sqrt/log/power, no cap of any kind.
Integer in, integer out; non-integers are refused. `CURRENT_SCORING_VERSION`
and `mining-dev-v1` still say `usage_score_v1`. `finalizeEpoch` and
`settleEpoch` now refuse any non-active scoring version, so a draft can be
simulated and previewed but cannot settle (tested).

Invariants under linear (simulator, 99 honest, attacker $10; tests in
`m15b.test.ts`):

| dimension | 1 vs n | attacker score difference | reward difference |
| --- | --- | --- | --- |
| accounts | 1 vs 1000 | 0 | at most 0.2% (integer largest-remainder across 1000 rows) |
| devices | 1 vs 100 | 0 | 0 |
| connections / keys | 1 vs 100 | 0 | 0 |
| models | 1 vs 50 | 0 | 0 |
| requests | 1 vs 10,000 | 0 | 0 |

The score difference is exactly zero because the linear rule is integer
micros; the only non-zero figure is point rounding when a pool is split over
1000 rows, which favours nobody in expectation.

Whales (§11), 100 honest at $1, exactly as accepted:

| whale compute share | 1% | 5% | 10% | 25% | 50% | 75% | 90% |
| --- | --- | --- | --- | --- | --- | --- | --- |
| whale reward share | 1.00% | 5.00% | 10.00% | 25.00% | 50.00% | 75.00% | 90.00% |

## Precision: pico-USD exact valuation (`src/lib/pricing/exact.ts`)

Prices are integer micro-USD per million tokens, so **one token is worth
exactly `price` pico-USD** (10^-12 USD). `value_pico = price × tokens`: no
division, no rounding, any integer price, any token count. Per-day sums are
BigInt (a $100,000 day is 10^17 pico, beyond 2^53). Rounding to micro-USD, if
a legacy column needs it, happens once per aggregate.

| representation | exact for every integer price? | JS Number safe? | verdict |
| --- | --- | --- | --- |
| micro per request (today) | no: half-up per class per request | yes | the leak (at most 0.5 micro per class per request) |
| nano-USD | only when `price × tokens` divides by 1000 (true for every current price, not guaranteed) | to about $9M/day | fragile |
| **pico-USD** | **yes, always** | needs BigInt | **recommended** |
| rational num/den | yes | needs BigInt | pico *is* this with a fixed denominator; two columns for nothing |
| daily aggregate before rounding | yes, if the aggregate is kept in pico | n/a | this is how pico is used |

Tests: ten 10-token requests equal one 100-token request (2× under micro
rounding, exactly 1× under pico); 200 seeded random splits are all
pico-neutral; every v1/v2 price is representable; results agree with the
micro path whenever no rounding occurred. **Settled v1 history is not
re-priced**: events keep `protocol_compute_micros` and their pricing version.

**Migration needed (DESIGN ONLY; not written into `supabase/migrations`, not applied):**

```sql
-- 0019 (proposal): exact protocol compute
alter table usage_events add column protocol_compute_pico bigint;   -- null for pre-v3 rows
alter table score_records add column weighted_compute_pico numeric(38,0);
-- the settled-row immutability triggers from 0018 already cover both tables
```

`bigint` holds 9.2 × 10^18 pico = $9.2M per event, which is enough; the daily
aggregate is `numeric` because a network day can exceed that. Activation
would pair this with pricing v3 and scoring v2; none of the three moves alone.

## Cache pricing: unknown is not input

Audit of both frozen snapshots (`auditUnknownCachePrices`):

| snapshot | models with an absent cache-read price | of which positive-priced (live exposure) |
| --- | --- | --- |
| usage-pricing-v1 | several | none live (v1 is frozen and superseded) |
| usage-pricing-v2 | `nvidia/nemotron-3-nano-30b-a3b`, `inclusionai/ling-3.0-flash-fin`, `inclusionai/ling-3.0-flash-sante` (cache read); `openai/gpt-5-nano`, `openai/gpt-5.4` (cache write only) | **nemotron** (cache reads valued at 50,000 micro/M, the full input rate) |

Old fallback: `cacheReadRate = price.cacheReadMicrosPerMillion ?? price.inputMicrosPerMillion`.
Recommended behaviour, implemented as `UnknownCachePolicy = "pending"` in
`exact.ts`: the unknown component contributes 0 and is listed in
`pendingComponents`, so the event's pricing status is `pending` for that
component rather than silently priced. Requests without cache traffic are
unaffected.

`usage-pricing-v3` exists as a **draft file** (`usage-pricing-v3-draft.ts`):
same prices as v2, `unknownCachePolicy: "pending"`, `valuation:
"pico_exact"`, `status: "draft"`, and deliberately **absent from the pricing
registry** (`getPricingSnapshot("usage-pricing-v3")` is null, tested). v1 and
v2 are unchanged. gpt-5-nano's missing cache-write price is harmless today
(OpenAI does not bill cache writes) but v3 should state it as 0 explicitly
rather than fall back.

## Bootstrap emission: the scheduled pool is a CAP

Today (`mining-dev-v1`): 100,000 points per daily epoch, distributed in
full to whoever is present. With one miner and 1 micro-USD (the real M14C
day) that is **10^11 points per protocol dollar**, and the sole miner takes
the whole epoch.

Candidate A, fixed pool, one miner (from `npm run usage:m15b:emission`):

| network compute | points per protocol $ | sole miner gets | break-even value per point |
| --- | --- | --- | --- |
| $0.000001 | 1.00e+11 | 100,000 | 1e-11 |
| $0.001 | 1.00e+8 | 100,000 | 1e-8 |
| $1 | 1.00e+5 | 100,000 | 1e-5 |
| $100 | 1.00e+3 | 100,000 | 1e-3 |
| $10,000 | 1.00e+1 | 100,000 | 1e-1 |
| $100,000 | 1.00e+0 | 100,000 | 1 |

### Candidates (exact forms; N = network eligible compute in micro-USD)

| id | formula | points-per-dollar bound | sole 1-micro miner gets |
| --- | --- | --- | --- |
| A fixed | `effective = scheduled` | none (unbounded as N approaches 0) | 100,000 (100%) |
| B baseline | `effective = scheduled × min(1, N/B)` | at most scheduled/B, always | 0 |
| C difficulty | `effective = scheduled × N/(N+T)` | at most scheduled/T, always; never 100% | 0 |
| D hybrid | `effective = F + (scheduled − F) × min(1, N/B)` | at most F/N + scheduled/B | F (1,000 = 1%) |
| E minimum | `0 if N < M, else B(N)` | as B, with a step at M | 0 |

Effective pool at B = T = $100/epoch, F = 1,000, M = $1:

| network compute | A | B | C | D | E |
| --- | --- | --- | --- | --- | --- |
| $0.000001 | 100,000 | 0 | 0 | 1,000 | 0 |
| $0.01 | 100,000 | 10 | 9 | 1,009 | 0 |
| $1 | 100,000 | 1,000 | 990 | 1,990 | 1,000 |
| $10 | 100,000 | 10,000 | 9,090 | 10,900 | 10,000 |
| $100 | 100,000 | 100,000 | 50,000 | 100,000 | 100,000 |
| $1,000 | 100,000 | 100,000 | 90,909 | 100,000 | 100,000 |
| $100,000 | 100,000 | 100,000 | 99,900 | 100,000 | 100,000 |

The baseline B = $100/epoch is a **placeholder for the tables**, not a
recommendation; the parameter is the owner decision below.

### The §9 invariant, formalised

For every network state, an actor contributing `c` micro-USD of eligible
compute to an epoch receives at most `scheduled × c / B` points. Equivalently,
points per protocol dollar never exceed `scheduled / B`, however empty the
network.

Under linear scoring the actor gets `effective × c / N`, so the invariant is
`effective(N) / N <= scheduled / B` for all `N > 0`. B and C satisfy it for
all N (tested from N = 1 micro to $100); D satisfies it up to the explicit
floor F; A violates it without bound. A 1-micro attacker on an empty network
captures **0** under B and C, **1%** under D (the floor, by design), **100%**
under A.

### Farming equilibrium (§10)

Entrants add wash compute while `P × points_per_dollar > 1`. Equilibria:

| candidate | entry condition | equilibrium N* | points per $ at N* |
| --- | --- | --- | --- |
| A fixed | any P > N/scheduled; at tiny N, any P at all | `P × scheduled` | 1/P |
| B baseline | `P × scheduled / B > 1` | `P × scheduled` (at least B) | 1/P |
| C difficulty | `P × scheduled > T` | `P × scheduled − T` | 1/P |
| D hybrid | slightly below B's threshold (the floor) | about `P × scheduled` | 1/P |

Every candidate self-dilutes (points per dollar fall monotonically in N,
tested) and none allows runaway farming. The difference is **where entry
starts**: under A a farm is rational at any point value while the network is
small; under B and C no farm is rational until a point is worth more than
`B / scheduled` dollars. At P = 1e-3 with a $10 honest network, A attracts $90
of wash compute; B and C attract none (table in the results script).

### Undistributed emission (§8)

| option | launch incentive | supply predictability | attack incentive | future dilution | whale incentive | threshold gaming |
| --- | --- | --- | --- | --- | --- | --- |
| A never minted | weakest | best (supply at most the schedule, known) | none | none | none | none |
| B deferred to later epochs | strong later | worse (a growing overhang) | delay compute to the catch-up epoch | high | whales time the overhang | yes |
| C treasury / reserve | governance-dependent | good if the reserve is capped | capture the governance | depends | depends | none |
| D partially deferred, capped | moderate | acceptable | bounded by the cap | bounded | bounded | mild |

For off-chain beta points the honest answer is **A: never minted**. Points
that were not earned because the network was idle do not exist; nothing is
owed to a future. If a token ever exists, its supply schedule is a separate
decision and must not inherit an overhang from the beta.

### Recommended emission model

**D hybrid with a small floor, or B if the owner prefers zero floor:**

```
effective(N) = F + (scheduled − F) × min(1, N / B)
```

with `F` a few percent of `scheduled` at most, and `B` set from the
observed honest network rather than guessed. Undistributed points are never
minted. The floor exists only so the first honest miners on an empty network
earn something visible; it is also the exact, bounded bootstrap
over-emission (a sole tiny miner gets `F`, never more). C is the cleaner
curve mathematically (no threshold, never 100%) but "never 100%" is hard to
explain and B's `min(1, ·)` is the same bound with a corner.

Precedent: Filecoin's baseline minting ties part of emission to network
capacity crossing a growing baseline rather than to time alone. The lesson
transfers; the parameters do not.

### Provider principals and proof of personhood

Unchanged from M15: keep `creator_user_id` (OpenRouter) and xAI
`team_id` / `user_id` as **future** fraud and linking signals only. No provider
gets different economics for exposing a principal; provider choice must not
become reward arbitrage. No PoP integration.

### M14C calibration (read-only)

| | value |
| --- | --- |
| production v1 score | 1.0000 |
| v2 (micro, as stored) | 1 |
| exact pico value | 500,000 (the $0.0000005 the provider charged) |
| v2 under B or C emission that day | 0 points; under D: 1,000; under A (today): 100,000 |
| production modified | NO |

### Open decision

One parameter decides whether v2 can go live: **the baseline B (and floor
F, possibly 0)**, that is, what network eligible compute per epoch unlocks the
full 100,000-point schedule.
