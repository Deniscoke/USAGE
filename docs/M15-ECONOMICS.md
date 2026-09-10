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


---

# M15C — v2 activation plan (prepared, not executed)

## Owner decision (locked, 2026-09-10)

| parameter | value |
| --- | --- |
| scoring | `usage_score_v2` = linear eligible protocol compute |
| scheduled cap | 100,000 Usage Points per UTC epoch |
| emission | `baseline-linear-v1`: `effective = scheduled × min(1, N / B)`, exact integer, floor of the quotient |
| baseline B | $1,000.00 eligible protocol compute per UTC day = 1,000,000,000 micro-USD = 10^15 pico-USD |
| floor F | 0 |
| undistributed emission | never minted |
| versioned as | `mining-beta-v2` (DRAFT in code; DRAFT row in the pending 0019) |

Why F = 0: any positive floor emits a non-zero amount for arbitrarily tiny
network compute, so points per protocol dollar are unbounded as N approaches
0 (tested: a 1-point floor pays 10^12 points per dollar to a 1-pico miner).
Early-user incentives, if ever wanted, are a separate, explicitly labelled
beta incentive ledger and policy. They must not pretend to be compute-mined
rewards. None is implemented.

**This is a beta economic parameter. It is not a token price. It is not a
1:1 future token conversion promise. It controls beta emission density
only.** Future token claim or conversion economics are a separate owner
decision.

## Parameter table (from `effectivePoolBaselineLinear`, tested)

| N | effective pool (whole points) | points per protocol $ |
| --- | --- | --- |
| $0 | 0 | n/a |
| $0.001 | 0 | 0 (floors) |
| $0.01 | 1 | 100 |
| $0.10 | 10 | 100 |
| $1 | 100 | 100 |
| $10 | 1,000 | 100 |
| $100 | 10,000 | 100 |
| $1,000 | 100,000 | 100 |
| $10,000 | 100,000 | 10 |
| $100,000 | 100,000 | 1 |

Maximum pre-baseline emission density is exactly `scheduled / B_usd =
100,000 / 1,000 = 100` points per protocol dollar: for N ≤ B,
`effective / N = scheduled × (N/B) / N = scheduled / B`. Above B it is
`scheduled / N < scheduled / B`. Confirmed in `m15c.test.ts`.

## Precision (pico-USD, authoritative for v2)

- Authoritative v2 unit: `usage_events.eligible_compute_pico`, exact
  integer pico-USD after the reward policy. `protocol_compute_pico` is the
  pre-policy value. Both are new, nullable, and NULL on every v1/v2-priced
  row; `protocol_compute_micros` and `eligible_compute_micros` stay
  authoritative for v1 forever.
- SQL type: `numeric(38,0)` with integral and non-negative checks. Audit:
  `bigint` holds 9.22 × 10^18 pico = $9.2M, enough for any single event, but
  not for a whale's day, a network day or an epoch total, and a later type
  change on a settled table would fight the immutability triggers. `numeric`
  is exact, unbounded in practice (10^26 USD), and is what `network_score`
  already uses. No float anywhere.
- Rounding exploit: eliminated. `value_pico = price × tokens`, no rounding;
  10,000 requests equal 1 request to the last pico (tested).
- Migration required: yes, `supabase/pending/0019_v2_economics.sql`
  (prepared, not applied).

## Pricing v3 (draft, unregistered)

- Known price → exact pico valuation.
- Unknown cache-read price → the cache-read component is pending.
- Unknown cache-write price → the cache-write component is pending when the
  request has cache-write tokens.
- No fallback to the input rate, ever, unless a future snapshot states the
  rate explicitly with the provider's authoritative pricing as source.
- v1 and v2 snapshots are immutable and untouched.

### Partial pricing decision: A, the whole event is pending

An event with known input and output prices, an unknown cache price and
cache tokens > 0 is **pending as a whole**, with
`pricing_components_pending = {cacheRead}` recorded so the reason is explicit.

Red team of B (known components eligible, unknown held): an economic unit
is rewarded at most once (0018). Under B the same unit would have a rewarded
part now and an unrewarded remainder that either is lost forever (settled
rows are immutable) or must become a second rewardable object later, which
is a second economic fate for one unit and a dedupe hazard by construction.
B also invites "make the unknown part large" games only in the direction of
under-valuing the attacker's own compute, which is harmless but pointless,
and it needs a new partial status that every UI and report must learn.

Red team of A: an attacker gains nothing by routing to a model with an
unknown cache price (the whole event waits). An attacker cannot make anyone
else's event pending. Honest users of that model wait until a pricing
version states the rate, exactly as `pending_pricing` already works for
unpriced models. The result is deterministic and explainable from one
column. **Recommended: A.**

Fact found on the way: no repricing path exists in the codebase today.
`pending_pricing` events (two of them in production, both `:free`) stay
pending until one is written. That is a v3 activation prerequisite, not an
M15C change.

## The open v1 epoch: epoch-2026-09-10

Contains exactly one eligible unit, the M14C calibration event `c75acc2e`
(1 micro-USD, score 1.0000 under v1). Epoch row not yet materialised; it
opens on the first settlement pass. Under v1's fixed pool, settling it would
credit **100,000 points to one user for $0.0000005 of compute**, the same
size as the whole beta emission of a $1,000 day under v2.

Options, all within the states the protocol supports (`open` → `finalizing`
→ `settled`, `epoch_kind ∈ {development, production}`, `reward_pool_points ≥ 0`):

| option | mechanism | supply created | history |
| --- | --- | --- | --- |
| A settle under v1, full pool | `settle-epoch` as-is | 100,000 dev points | honest but distorting: a $0.0000005 test equals a $1,000 v2 day |
| B close without rewards | `finalizeEpoch` + `settleEpoch` with `rewardPoolPoints: 0`, `epoch_kind: development` | 0 (allocation row with 0 points; ledger untouched because credits with 0 points are skipped) | epoch settled, score record and M14C event preserved and frozen |
| C preserve as calibration epoch excluded from claimable history | same as B, plus a documented rule that `epoch_kind = development` is never claimable | 0 | cleanest, and already true of epoch-2026-09-07 by kind |
| D leave open | nothing | 0 | blocks the cutover: an open v1 epoch would keep accepting carried-forward units forever |

**Recommended: C**, executed as B (pool 0, development kind). It uses only
existing code paths and states, mints nothing, freezes the M14C event as a
settled development unit, and leaves epoch-2026-09-07 (already settled with
100,000 development points to the other user) as the one historical
development distribution, which the owner may separately decide to exclude
from any future claim. **Not performed. Separate owner approval required.**

## Cutover

Epochs are UTC days and every unit is assigned to exactly one epoch at
ingestion (`assignEpoch`). The rule for v2:

- `mining-beta-v2.effective_from_epoch = epoch-YYYY-MM-DD`, an explicit UTC
  epoch id, at least one full day after the code deploy and after the v1
  epoch is closed.
- An epoch row is bound to `(scoring_version, pricing_version,
  emission_version)` when it is first written and those columns become
  immutable at settlement (0019 trigger). A unit is scored under **its
  epoch's** versions, not under whatever is current at ingestion time.
- Carried-forward units (occurred in a closed epoch, ingested late) land in
  the first open epoch and are scored under that epoch's versions. This is
  the existing carry-forward rule; it means a late v1-era unit can be scored
  under v2, which is version-pure per epoch and never mixes versions inside
  one epoch.
- Ingestion must write `protocol_compute_pico` / `eligible_compute_pico` for
  every new event from the deploy onward, whatever epoch it lands in, so a
  v2 epoch never holds a unit without pico. The invariant check refuses to
  settle otherwise.

First eligible v2 epoch: **the epoch the owner names**, with the constraint
`effective_from_epoch > epoch-2026-09-10`, and in practice ≥ two UTC days
after the deploy. Mixed-version epochs: impossible by construction (one
version triple per epoch row, checked before settlement).

## 0019 (prepared only, `supabase/pending/0019_v2_economics.sql`)

| item | content |
| --- | --- |
| tables | `usage_events`, `score_records`, `reward_epochs`, `mining_protocol_versions` |
| columns | `usage_events.protocol_compute_pico`, `eligible_compute_pico` (numeric(38,0)), `pricing_components_pending text[]`; `score_records.weighted_compute_pico`; `reward_epochs.emission_version`, `network_compute_pico`, `effective_pool_points`, `undistributed_points`; `mining_protocol_versions.emission_algorithm`, `baseline_compute_pico`, `floor_points`, `undistributed_policy`, `effective_from_epoch` |
| constraints | integral and non-negative pico; eligible ≤ protocol; effective ≤ scheduled; undistributed = scheduled − effective; baseline required for baseline-linear-v1; one active protocol version |
| indexes | partial index on eligible pico units per epoch and user; unique partial index on the active protocol |
| triggers | the two 0018 immutability functions re-created with the new columns included |
| function | `check_v2_epoch_settleable(epoch_id)`: the database's own copy of the pre-settlement invariants; the settle script must call it |
| backfill | none of economic value. mining-beta-v2 inserted as DRAFT. An analytics-only pico backfill is present as a commented-out template and would exclude settled rows and v1 epochs |
| locking | ADD COLUMN and CHECK constraints only; brief ACCESS EXCLUSIVE on tables with 6 event rows |
| rollback | listed in the file; only valid before the first v2 settlement |
| economic impact | none at apply time |

## Activation plan (ordered)

| step | action | reversible? |
| --- | --- | --- |
| 1 | apply 0019 (owner approval, rule 13) | yes, by the listed rollback, until step 9 |
| 2 | register `usage-pricing-v3` (frozen prices = v2, pending policy, pico valuation) in code and in `protocol_pricing_versions`; write a repricing path for pending events | yes: status only, until an event is priced with it |
| 3 | flip `usage_score_v2` from `draft` to `active` in code; `CURRENT_SCORING_VERSION` stays v1 until step 4 binds epochs | yes |
| 4 | set `mining_protocol_versions`: `mining-dev-v1 → superseded`, `mining-beta-v2 → active` with `effective_from_epoch`; ingestion scores by the epoch's versions from then on | yes, before any v2 epoch is finalized |
| 5 | verification: `verify-0018`, a new `verify-0019`, hosted verify, `check_v2_epoch_settleable` on a dry epoch | n/a |
| 6 | close epoch-2026-09-10 per the owner's separate decision (recommended: pool 0, development) | no: settlement is permanent |
| 7 | production deploy of the code that writes pico and scores by epoch version | yes |
| 8 | first v2 epoch runs; read-only observation of scores, effective pool preview, invariants | n/a |
| 9 | owner-approved first v2 settlement | **no: from here the 0019 columns hold immutable history** |

## Pre-settlement invariants (tests in `m15c.test.ts`, SQL in 0019)

| invariant | status now |
| --- | --- |
| economic identity uniqueness healthy | pass (1 keyed unit, 1 distinct key in production) |
| pricing version frozen | fail by design: v3 is a draft, not registered |
| scoring version active | fail by design: v2 is a draft |
| emission version active | fail by design: mining-beta-v2 is a draft |
| epoch bound to exact versions | fail by design: columns do not exist until 0019 |
| network eligible pico deterministic | pass (pure recomputation, order-independent, tested) |
| effective pool deterministic | pass |
| allocation sums exactly to effective pool | pass |
| effective pool ≤ 100,000 | pass |
| undistributed never inserted into ledger | pass (plan carries it as a number only) |
| ledger delta = effective pool | pass |
| no allocation to ineligible units | pass |
| no double credit | pass (existing ledger rows refuse) |

The four "fail by design" rows are exactly what activation flips.

## M14C calibration under v2 (read-only)

| | value |
| --- | --- |
| v1 score (production) | 1.0000 |
| exact pico value | 500,000 (10 input tokens × 50,000 pico) |
| v2 score | 500,000 pico |
| effective pool for a 500,000-pico day | 0 of 100,000; 100,000 never minted |
| points | 0 |
| production modified | NO |


---

# M15D — Development calibration disposition for epoch-2026-09-10

## The conflict, proven from source

- `scripts/settle-epoch.ts` builds the epoch with `dailyEpochFor(day,
  epochEmissionPoints())`, and `epochEmissionPoints()` returns
  `CURRENT_MINING_PROTOCOL.epochEmissionPoints` = **100,000** under
  `mining-dev-v1` (`emissionAlgorithm: fixed-pool-v1`). Running it unchanged
  for 2026-09-10 would credit 100,000 points to one user for $0.0000005.
- `reward_epochs.reward_pool_points bigint check (>= 0)` accepts 0, and
  `creditAllocations` only writes `usage_point_ledger` rows where
  `points > 0`. A zero-reward close is therefore technically possible, but a
  settled epoch saying "mining-dev-v1, pool 0" would contradict what
  mining-dev-v1 means and be irreproducible from persisted data.

`settle-epoch.ts` now refuses any epoch listed in the owner-approved
calibration table and points at the guarded path instead.

## Persisted solution: an explicit calibration protocol version

Smallest additive representation, chosen over a free-text disposition
column because it reuses the version machinery that already binds scoring
and pricing:

| | |
| --- | --- |
| protocol version | `mining-dev-calibration-v1` (row in `mining_protocol_versions`, inserted by 0019, `status = active`, `role = calibration`) |
| emission algorithm | `zero-reward-calibration-v1`; constraint: `epoch_emission_points = 0`, `floor_points = 0`, `role = calibration` |
| scoring | `usage_score_v1` (the M14C score stays 1.0000) |
| pricing | `usage-pricing-v2` (what the M14C event was priced under; the close refuses any other) |
| reward | 0 by definition of the version; `effective_pool_points = 0`, `undistributed_points = 0` |
| claimable | `false`, persisted on both the version and the epoch; `check (epoch_kind <> 'development' or claimable = false)` |
| binding | `reward_epochs.protocol_version` (the FK from 0008, previously unused) becomes the epoch's emission binding; settled epochs must have one; the immutability trigger freezes it |

`role` separates "what the network mines under" (at most one active, enforced
by a partial unique index) from "a disposition applied to one approved
epoch". The calibration version is active so it can be applied, and is
never the current protocol.

Historical stamp, done once inside 0019 before the trigger learns the
columns: every already-settled epoch (today: epoch-2026-09-07) gets
`protocol_version = 'mining-dev-v1'`, `pricing_version = 'usage-pricing-v2'`,
`effective_pool_points = reward_pool_points`, `claimable = false`. That
records which rule emitted its points; it moves none.

## Historical audit without source code

`audit_epoch(epoch_id)` (0019) returns, from persisted rows only: scoring
version, pricing version, protocol version, emission algorithm, scheduled
and effective points, network score, distributed points (Σ allocations),
ledger points (Σ ledger), epoch claimable, protocol claimable, protocol role.
Tested on PGlite with 0019 applied:

| question | epoch-2026-09-10 (calibration, test twin) | a normal mining-dev-v1 epoch |
| --- | --- | --- |
| why was the score positive? | `usage_score_v1`, network score 1.0000 | `usage_score_v1` |
| why was the reward zero? | `zero-reward-calibration-v1`, scheduled 0 | n/a: `fixed-pool-v1`, scheduled 100,000, distributed 100,000 |
| which pricing rule? | `usage-pricing-v2` | `usage-pricing-v2` |
| which emission rule? | `mining-dev-calibration-v1` | `mining-dev-v1` |
| future-token claimable? | false (epoch and version) | false |

The two are told apart by `protocol_version` alone. No special case exists in
code: the close is the ordinary finalize-then-settle with the calibration
version's zero pool.

## Future claimability invariant

**DEVELOPMENT EPOCHS ARE NOT FUTURE TOKEN CLAIMS.** `isClaimableEpoch()` in
`src/lib/domain/epoch.ts` returns true only for a `production` epoch whose
persisted `claimable` flag is true; the database refuses `claimable = true`
on any development epoch or development protocol version. Any future wallet
snapshot, genesis allocation, airdrop, conversion or on-chain claim root must
go through that predicate. The 100,000 development points credited by
epoch-2026-09-07 stay in the off-chain ledger exactly as they are and are
excluded by this invariant; only an owner-approved migration flipping a
production epoch could ever change that. No blockchain or token code exists.

## The guarded close (`src/lib/db/calibration-close.ts`, `npm run usage:close-calibration`)

Not a generic pool override. It closes only an epoch present in
`APPROVED_CALIBRATION_CLOSES`, whose single entry is epoch-2026-09-10 with the
M14C facts (event id, economic key, owner, 1 micro-USD eligible, score
1.0000, proof id). It fails closed, listing every reason, unless:

- the epoch id is approved; the calibration protocol row exists, is active,
  role calibration, zero emission, not claimable (i.e. 0019 is applied);
- the event exists with exactly the approved owner, epoch, key, eligible
  micros, `economic_status = eligible`, `reward_status = eligible`, pricing
  version `usage-pricing-v2`;
- the approved proof exists, is attached to that event and is signed;
- the v1 score for the day equals the approved score;
- the epoch is unmaterialised, open or finalizing, of kind development, with
  no positive allocation.

Then: finalize, settle with `rewardPoolPoints: 0`, `protocolVersion:
mining-dev-calibration-v1`, `claimable: false`, `epochKind: development`;
refuse if settlement reports any distributed or credited amount; re-snapshot
and refuse unless the event keeps its identity, economics and pricing and is
now `settled`, the proof is unchanged, the score is unchanged, the epoch is
settled/development/calibration-bound/non-claimable, positive allocations =
0, ledger rows and total unchanged, settled balance unchanged. A second run
is refused by the epoch state. Without `--confirm` the script only prints the
snapshot and the checks.

PGlite tests (`calibration-close.test.ts`, 12): the fixture rebuilt through
real ingestion reproduces M14C (1 micro, score 1.0000, `ecu1:` key); refusal
of unapproved ids, of each mismatched fact, of a non-active calibration row;
the close changes nothing of value; the settled epoch and the calibration
version are immutable; the audit answers every question; a normal
mining-dev-v1 epoch still emits exactly 100,000.

## Order of operations

**0019 before the close: YES.** The disposition needs the `claimable`
column, the settled-epoch protocol binding and the calibration version row,
none of which exist before 0019. 0019 is additive, activates nothing (the
network protocol stays mining-dev-v1 active; mining-beta-v2 is inserted as
draft) and stamps history without moving points. So:

1. owner approves 0019 → apply while v1 remains active
2. verify production (0018 invariants, audit of epoch-2026-09-07 shows
   `mining-dev-v1` / `fixed-pool-v1` / 100,000, dry-run of the close)
3. owner approves the close → `usage:close-calibration --epoch epoch-2026-09-10 --confirm`
4. verify zero ledger delta, `audit_epoch('epoch-2026-09-10')`
5. only then, at a named UTC epoch, activate v2 (unchanged parameters:
   linear, cap 100,000, B = $1,000/day, F = 0, never minted)

The earlier assumption that the epoch had to be closed before any schema
change was wrong: it conflated schema migration with economic activation.

## Pre/post capture for the eventual close

Before: event id `c75acc2e…`, key `ecu1:cf605dfe…`, proof `b60f5602…`
signed, score 1.0000, epoch unmaterialised, ledger 1 row / 100,000, 1
allocation, settled balance 0. After, required: same event identity, proof
and economics with `economic_status = settled`; score 1.0000; epoch settled,
development, `mining-dev-calibration-v1`, claimable false; positive points 0;
ledger 1 row / 100,000; balance 0. The script prints both and refuses on any
deviation.


---

# M15E — Atomic calibration close

## The gap, from the code

`closeCalibrationEpoch` (calibration-close.ts) calls `finalizeEpoch` then
`settleEpoch` (settlement.ts), which call the Supabase settlement store.
That store issues, in order, each as its own supabase-js request and
therefore its own PostgREST autocommitted transaction:

| # | call | table | write |
| --- | --- | --- | --- |
| 1 | `upsertEpoch(finalizing)` | reward_epochs | insert/update, state finalizing |
| 2 | `upsertEpoch(settled)` | reward_epochs | update, state settled (now immutable) |
| 3 | `creditAllocations` | reward_allocations | upsert allocation rows |
| 4 | `creditAllocations` | usage_point_ledger | upsert credits, skipped when every allocation is 0 |
| 5 | `markSettled` | usage_events | economic_status eligible → settled |

Then the application re-reads and checks postconditions. Nothing joins
these requests: supabase-js has no client transaction, and PostgREST commits
each request independently. **Shared transaction: NO.** A failure after any
of 1, 2, 3 or 5 leaves a state no later step can undo; the postcondition
layer can only report it. Proven in `calibration-atomicity.test.ts` part 1:

| injected failure | committed partial state |
| --- | --- |
| A after finalizing write | epoch finalizing, event eligible |
| B after settled write | epoch settled and immutable, no allocation, event eligible |
| C/E after allocation, before event update | epoch settled, allocation present, event eligible |
| D ledger phase | never runs for 0 points; ledger untouched in every case |
| F after event update, before postconditions | everything committed while the application reports failure |

## The fix: one PostgreSQL transaction (`supabase/pending/0020_atomic_calibration_close.sql`)

`close_development_calibration_epoch(p_epoch_id text)`, plpgsql, SECURITY
INVOKER, `search_path = ''`. The service role already holds every privilege
the writes need, so no DEFINER escalation. EXECUTE revoked from PUBLIC, anon
and authenticated; granted to service_role only.

Inside one transaction, in order:

1. refuse unless `p_epoch_id = 'epoch-2026-09-10'`; take
   `pg_advisory_xact_lock(hashtext('usage:calibration-close'), hashtext(p_epoch_id))`
   before any read, held to commit or rollback;
2. preconditions under `FOR UPDATE` / `FOR SHARE`: the approved event (id,
   owner, epoch, economic key, unique, 1 micro eligible, statuses eligible,
   pricing v2), the approved proof attached and signed, the v1 score 1.0000,
   the calibration protocol row (active, calibration, emission 0, not
   claimable, scoring v1, pricing v2, zero-reward-calibration-v1,
   development), the epoch row absent or open/finalizing and development,
   no positive allocation, ledger and balance snapshots;
3. writes: epoch upserted finalizing then updated settled (pool 0, effective
   0, undistributed 0, claimable false, protocol bound, network score
   1.0000), one allocation with 0 points, the event's economic_status
   eligible → settled with an exact row-count check;
4. postconditions from fresh reads: event identity, key, eligible micros,
   pricing, owner, epoch unchanged and settled; proof present and signed;
   score 1.0000; epoch settled/development/calibration/non-claimable/zero;
   allocation sum and positive count 0; ledger rows and total unchanged;
   the owner's settled balance unchanged;
5. returns the persisted audit (`audit_epoch`) subset: epoch, state,
   protocol, scoring, pricing, network score, distributed, ledger points,
   claimable.

Any RAISE at any point rolls back everything. Every approved fact is a
constant in the function body; the caller supplies nothing but the epoch
id. Fault injection: `current_setting('usage.calibration_fail_after', true)`
names a stage after which the function raises, so atomicity is provable per
stage; only a session that can already execute the function can set it, and
it can only cause a refusal.

Concurrency: two simultaneous confirmations serialise on the advisory lock;
the second sees the committed settled epoch and raises "already settled".
The lock key is `(hashtext('usage:calibration-close'), hashtext(epoch id))`,
two int4 keys, transaction-scoped, released automatically. It does not
depend on the epoch row existing.

## Tests (`calibration-atomicity.test.ts`, PGlite, chain through 0019 plus pending 0020)

- current path: A, B, C/E, D, F above, each leaving the documented partial
  state;
- 0020: injected failure after epoch, finalizing, settled, allocation, event
  update and during the final postcondition each restore the initial state
  exactly (epoch absent, event eligible, no allocation, ledger and balance
  unchanged);
- refuses an unapproved epoch id and a drifted score, with rollback;
- anon and authenticated get "permission denied"; service_role succeeds;
- the successful close returns the audit row, settles the event, writes one
  zero-point allocation, no ledger row, balance unchanged;
- two concurrent first attempts on a fresh epoch: one success, one "already
  settled", no positive points, no ledger row. PGlite serialises on one
  connection; on a multi-connection server the advisory lock produces the
  same ordering.
- the settled calibration epoch and event are immutable afterwards.

## Wrapper

`npm run usage:close-calibration -- --epoch epoch-2026-09-10` stays the
read-only TypeScript preflight. With `--confirm` it makes exactly one RPC
call to the function; an error means the database rolled back and nothing
was written; success is followed by an independent read-only audit held to
the same postconditions, as a second verification layer, not as the
atomicity guarantee. The multi-request store path remains for dry runs,
tests and documentation and is no longer used for the confirmed operation.

Ordinary mining-dev-v1 settlement and the future mining-beta-v2 path are
unchanged by this milestone.

## Executed (2026-09-10 19:06:23 UTC)

`npm run usage:close-calibration -- --epoch epoch-2026-09-10 --confirm` made
exactly one RPC call. Result: epoch settled, development,
mining-dev-calibration-v1, scoring v1, pricing v2, boundaries
2026-09-10T00:00Z to 2026-09-11T00:00Z, network score 1.0000, scheduled 0,
effective 0, undistributed 0, claimable false. The M14C event moved
eligible → settled with every other column identical; its proof is
unchanged. One allocation row with 0 points; ledger 1 row / 100,000 before
and after; the owner's balance 0 before and after. `audit_epoch` reproduces
all of it from persisted rows. A repeat dry run is refused ("epoch is
settled"). v2 remains inactive.


---

# M16A — Scheduled beta-v2 cutover preparation

## Target

| | |
| --- | --- |
| first mining-beta-v2 epoch | epoch-2026-09-14 |
| UTC start | 2026-09-14T00:00:00.000Z (Prague: 2026-09-14 02:00 CEST) |
| UTC end | 2026-09-15T00:00:00.000Z |
| readiness deadline | activation-compatible code and schema deployed and verified by 2026-09-11T23:59:59Z |
| if missed | do not compress the two full UTC days of soak; move to the first later epoch that preserves them |

Nothing in this milestone activates v2. Production economics unchanged.

## Pre-cutover gap (Sep 11 to 13)

Read-only inspection on 2026-09-10: no usage_events assigned to
epoch-2026-09-11, -12 or -13. All six events sit in epoch-2026-09-07 (three,
two settled), epoch-2026-09-08 (two pending_pricing, held/ineligible) and
epoch-2026-09-10 (the settled calibration unit). No disposition needed. If a
reward-eligible unit appears in the gap before cutover it must not be settled
with the fixed 100,000 pool, not carried into v2, and not silently
reassigned; it needs an explicit owner disposition. The ordinary settle script
now refuses any epoch that is not fixed-pool-v1, and the atomic v2 function
refuses any epoch the schedule does not give to baseline-linear-v1.

## Version resolution (no more global "current" assumptions on the economic path)

Audit of production paths using `CURRENT_MINING_PROTOCOL`,
`CURRENT_SCORING_VERSION`, `CURRENT_PRICING_VERSION`, `epochEmissionPoints()`:

| path | before | now |
| --- | --- | --- |
| ingestion re-score (`ingest.ts`) | `CURRENT_SCORING_VERSION` for every epoch | `scoringForEpoch(epochId)`; a v2 epoch scores `scoreRecordsPico` (BigInt) into `weighted_compute_pico`, `points` is display |
| gateway adapter pricing | `CURRENT_PRICING_VERSION` | `pricingForEpoch(epoch of occurrence)`; pico_exact versions write `protocol_compute_pico` / `eligible_compute_pico` / `pricing_components_pending` |
| `dailyEpochFor` binding | `CURRENT_MINING_PROTOCOL.version`, `CURRENT_SCORING_VERSION` | `protocolForEpoch(epoch-of-date)` |
| settle script pool | `epochEmissionPoints()` | governing protocol's cap; refuses non-fixed-pool epochs |
| dashboard / session preview | `epochEmissionPoints()`, `CURRENT_*` | today's epoch through the schedule, from the persisted `mining_protocol_versions` rows when loaded |
| miner config/status routes, `connections.ts` model check, `verify-hosted` | `CURRENT_*` | unchanged: informational or capability checks, not economic writes |

Resolver (`src/lib/protocol/schedule.ts`, and `protocol_for_epoch()` in
pending 0021): a bound `reward_epochs.protocol_version` wins; otherwise the
latest scheduled/active/superseded NETWORK version whose
`effective_from_epoch <= epoch`; drafts never resolve; before the genesis
version's first epoch the genesis version governs. Deploying code that
changes a constant cannot flip an epoch: the code schedule keeps
mining-beta-v2 a draft until the activation package, and the database row is
what settlement checks.

Historical reproduction (tests): epoch-2026-09-07 → mining-dev-v1 /
usage_score_v1 / usage-pricing-v2 / fixed 100,000; epoch-2026-09-10 (bound) →
mining-dev-calibration-v1 / v1 / v2 / zero reward; epoch-2026-09-14 with the
beta scheduled → mining-beta-v2 / usage_score_v2 / usage-pricing-v3 /
baseline-linear-v1; 09-11 to 09-13 → v1. The second before the boundary is
v1; the first second after is v2. No epoch can mix versions: the v2 settlement
function refuses any eligible unit priced under a different version than the
epoch's.

## Pricing v3, fresh audit (2026-09-10)

| model | input | output | cache read | cache write | reasoning | source |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-opus-5 | 5,000,000 | 25,000,000 | 500,000 | 6,250,000 (5m) | billed as output | platform.claude.com/docs/en/about-claude/pricing |
| anthropic/claude-sonnet-4.6 | 3,000,000 | 15,000,000 | 300,000 | 3,750,000 (5m) | billed as output | same |
| anthropic/claude-haiku-4.5 | 1,000,000 | 5,000,000 | 100,000 | 1,250,000 (5m) | billed as output | same |
| openai/gpt-5.4 | 2,500,000 | 15,000,000 | 250,000 | none billed (absent → pending if ever used) | billed as output | developers.openai.com/api/docs/pricing |
| openai/gpt-5-nano | 50,000 | 400,000 | 5,000 | none billed (absent) | billed as output | same |

Units: micro-USD per million tokens; captured 2026-09-10T19:20Z. Excluded
from v3 (no current first-party authoritative price; gateway listings only,
and those changed since v2): anthropic/claude-3-haiku (absent from Anthropic's
table), nvidia/nemotron-3-nano-30b-a3b (OpenRouter route now $0.05/$0.20, v2
had $0.24 output, cache read now listed), inclusionai/ling-3.0-flash-fin and
-sante (now $0.06/$0.18, v2 had 0/0). Units on those models are
`pending_pricing` under v3 and earn nothing.

Rules kept: pico-USD exact valuation; unknown cache price → pending; no
fallback to the input rate; a unit that used an unpriced class is pending as
a whole; no request-level rounding; v1/v2 immutable. v3 is registered in code
(inert: no epoch resolves to it until the beta is scheduled) and inserted
frozen by pending 0021.

## Pico ingestion path

Trusted ingestion only (`normalizeGatewayObservation` → `usageRecordToInsert`).
For a pico_exact version the server derives `protocol_compute_pico`
(exact), `eligible_compute_pico` (= protocol pico when the reward policy made
it eligible, else 0) and `pricing_components_pending`. A pending unit has
null pico and `pricing_status = pending_pricing`. The 0019 check constraint
enforces eligible ≤ protocol. v1/v2 units keep null pico and are never
repriced. Clients have no write path to usage_events.

## Scoring v2

`weighted_compute_pico = Σ eligible_compute_pico` for the user and epoch,
computed with BigInt in `scoreRecordsPico`, stored as `numeric(38,0)`. No
Number in the authoritative path; `points` is a once-rounded micro display.
The v2 settlement function recomputes the sum from the events and refuses if
any stored score row differs.

## Emission v2

`effective = floor(100000 × min(N, B) / B) + 0`, B = 10^15 pico, exact
integer arithmetic in both `settlement-v2.ts` and the SQL function; 0 ≤
effective ≤ 100,000; undistributed = cap − effective is recorded on the
epoch and never enters an allocation, the ledger or a balance.

## Settlement atomicity for beta-v2

The ordinary settlement path (`settleEpoch` over the Supabase store) has the
same multi-request gap M15E proved for the calibration close. **It is not
used for beta-v2.** Pending 0021 adds `settle_beta_v2_epoch(p_epoch_id)`: one
transaction with advisory lock, "epoch has ended" (UTC, from the id),
protocol resolved and checked (live baseline-linear-v1, scoring v2), pricing
version frozen/active, every eligible unit exact-pico under the epoch's
pricing version with no pending component and unique dedupe, no duplicate
economic keys, no prior ledger rows, stored v2 scores equal to the
recomputed sums, effective pool exact, largest-remainder allocation summing
exactly to it, ledger rows for positive points only, events settled,
postconditions (ledger delta = effective, allocation and ledger sums, every
positive allocation backed by a settled eligible unit, epoch row exact),
audit returned. SECURITY INVOKER, pinned search_path, EXECUTE for
service_role only, caller supplies the epoch id and nothing else.

Tests (`beta-v2-settlement.test.ts`, PGlite, chain through 0020 plus
pending 0021 applied): schedule and resolver in SQL; refusals (not ended, v1
epoch, bad id, missing pico, foreign pricing version, pending component,
missing or wrong score rows, anon/authenticated); injected failure after
finalizing, settled, allocation, ledger, events and postcondition each rolls
back completely; the successful settlement of $500.33 of eligible compute
distributes exactly 50,033 points (30,000 / 20,000 / 33) with a ledger delta
of 50,033 and 49,967 never minted; above the baseline the whole cap; an empty
epoch nothing; a second attempt refused; settled rows immutable; two
concurrent attempts give one success and one refusal.

## Shadow mode

`npm run usage:m16a:shadow [-- --epoch epoch-2026-09-14]` reads eligible
units for the epoch from production (read-only), adds the documented fixture
set, and prints network pico, baseline progress, effective pool (whole and
non-binding fractional preview), per-user score, share and estimated
allocation, every line labelled SHADOW / NON-BINDING. It also prints which
protocol the code schedule and the database schedule each resolve for the
epoch, so a mismatch between deployed code and applied schema is visible
before any activation.

## Active version semantics

`mining_protocol_versions.status`: `draft` (registered, never governs),
`scheduled` (approved, governs from `effective_from_epoch`, not yet
reached), `active` (governs now), `superseded` (governed earlier epochs; still
resolves for them). Historical epochs are reproduced through their bound
`protocol_version`, so superseding a version never makes its epochs
unscorable. At most one active network version; one network version per
boundary epoch.

## Dashboard copy

Before scheduling: "Mining protocol: DEVELOPMENT V1 / PREPARING BETA V2".
Once scheduled: "DEVELOPMENT V1 / BETA V2 SCHEDULED 2026-09-14 00:00 UTC".
From the cutover epoch: "BETA V2", scoring "LINEAR VERIFIED COMPUTE", emission
"UP TO 100,000 USAGE POINTS PER UTC EPOCH". Settled balance is never implied
before settlement; no token-claim language; development epochs stay
non-claimable.

## Pending 0021 (`supabase/pending/0022_beta_v2_cutover.sql`, not applied)

`scheduled` status; mining-dev-v1 stamped `effective_from_epoch =
epoch-2026-09-01`; network versions must name a first epoch unless draft;
one network version per boundary; `protocol_for_epoch()`; usage-pricing-v3
inserted frozen with the five audited models; mining-beta-v2 → scheduled for
epoch-2026-09-14 (the single UPDATE to edit if the target moves);
`settle_beta_v2_epoch()` with grants. Rollback listed in the file, valid
until the first v2 settlement.


---

# M16B — Live mining proof and real-time dashboard

## Audit of the dashboard before M16B

The dashboard page is `force-dynamic` server-rendered: every number came
from one `loadDashboardSnapshot` at page load. No polling, no Realtime, no
client refetch. A completed request therefore appeared only after a manual
refresh, and the "Mining active" label meant "a credential exists and some
activity contributes", which is not "a request is flowing now". After the
calibration close the balance card also showed "+100,000 estimated ·
SETTLED" because the estimate was computed from today's protocol pool
regardless of the epoch's state.

## Architecture

- **State model** (`src/lib/live/events.ts`): DISCONNECTED, READY,
  MINING_LIVE, VERIFYING, VERIFIED, HELD, INELIGIBLE, ERROR, derived from an
  idempotent reducer over server events keyed by (requestId, seq). CONNECTED
  never implies MINING_LIVE; READY never shows compute being earned.
- **Events** (server → browser, ephemeral, safe fields only): started,
  progress (at most one per second while bytes flow), verifying (the
  provider's terminal usage, before persistence), verified / held /
  ineligible (read back from the persisted row, never from memory), failed.
  `requestId` is minted by the server and is not an economic unit.
- **Transport**: Supabase Realtime Broadcast on a PRIVATE per-user channel
  `mining:<auth.uid()>`. Migration 0021 adds the one RLS policy on
  `realtime.messages` (select, authenticated, own topic, broadcast only);
  nothing economic is touched. The server publishes with the service role
  over the REST broadcast endpoint (`httpSend`), so serverless invocations
  need no socket; the key never reaches a browser. Database writes per
  second: zero.
- **UI** (`src/components/live-mining.tsx`, MINING PATH card): 1 s repaint is
  a local timer that runs only while a request is live and the tab is
  visible; a verified/held/ineligible/failed event triggers exactly one
  refetch of `GET /api/mining/summary` (cookie-authenticated, RLS); when
  Realtime drops the card shows LIVE UPDATES RECONNECTING and polls that
  endpoint every 5 s while visible, stopping when Realtime is back; a hidden
  tab neither ticks nor polls, and one refetch runs on return.
- **Estimates**: OpenRouter delivers complete usage only in the terminal
  response, so before it the server truthfully knows elapsed time and
  streamed characters. The card shows activity and time; a "~ estimated"
  token/compute figure appears only when an output price is supplied and is
  never persisted or called verified. The dashboard passes no price today, so
  the live line shows activity, not fabricated precision.
- **Settled epochs**: the balance card now shows `Reward: <persisted
  allocation>` and `SETTLED · DEVELOPMENT CALIBRATION` (or `· DEVELOPMENT`)
  from the epoch's bound protocol; an estimate exists only for an OPEN epoch.

## Live test (2026-09-10 20:18 UTC, one request, "Reply only: LIVE", openai/gpt-5-nano)

Observed by a server-side subscriber on the owner's private channel
(service role; the browser could not be driven without the owner's session):

| mark | instant | note |
| --- | --- | --- |
| T0 route received | 20:18:34.687Z | server |
| T1 observer MINING_LIVE | 20:18:37.850Z | activation 3,163 ms (243 ms of it transit) |
| T2 first stream chunk | n/a | the request was non-streaming |
| T3 terminal usage | 20:18:43.414Z | 10 input tokens, 0 output, $0.0000005 |
| T4 unit persisted | 20:18:46.656Z | ingestion, signing, aggregates, scores |
| T5 observer VERIFIED | 20:18:46.818Z | 162 ms after commit |
| T6 aggregate readable | 20:18:47.151Z | 495 ms after commit |

Transitions observed without any refresh: started → verifying → verified.
Verification propagation after the economic commit (T5−T4) is 162 ms, within
target; the 3.4 s from terminal usage to VERIFIED (T5−T3) is ingestion time.
Activation latency (T1−T0) missed the 2 s target: the started event was
emitted after miner authentication, gateway resolution and body parsing. It
is now emitted the moment the miner is authenticated, before resolution;
this is deployed but, per the one-request rule, not re-measured.

Economics: one new unit `66346da1` (eligible, unique key, 1 micro-USD,
usage-pricing-v2, no pico since v3 is not scheduled), 7 events, keyed units
2 distinct, ledger unchanged (1 row / 100,000), no settlement, v2 inactive,
epoch-2026-09-10 audit unchanged.

**Consequence for the cutover:** the unit occurred at 20:18 UTC on
2026-09-10, whose epoch is settled, so ingestion carried it forward to
`epoch-2026-09-11`. That is exactly the pre-cutover gap M16A said must not
be settled with the 100,000 pool, carried into v2, or silently reassigned.
It needs an explicit owner disposition before mining-beta-v2 is scheduled.

## Security

Private channel proven in production: anon and a throwaway authenticated
user are refused on the owner's topic ("Unauthorized: You do not have
permissions to read from this Channel topic"), a user joins only their own
topic, the service role publishes. PGlite test of the policy: own topic
receives broadcasts, other topic receives nothing, direct table reads return
nothing, no insert path for browsers. Events carry no prompt, completion,
credential or header.

## M16B.1 — production dashboard crash fix (2026-09-10)

Not an economic change. After M16B shipped, `/dashboard` intermittently
rendered Next's generic "This page couldn't load" screen.

**Root cause (reproduced in Chromium against production):** the browser
Supabase client read `NEXT_PUBLIC_SUPABASE_ANON_KEY`, but the Vercel
project defines only `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; `@supabase/ssr`
threw "Your project's URL and API key are required" inside the LiveMining
subscription effect, which unmounted the route. The `_rsc` ERR_ABORTED seen
alongside was a side effect, not the cause; React #412 was considered and
ruled out.

**Fix (commit 2fbef95):** `createBrowserSupabase()` reads both public key
names and returns `null` instead of throwing; LiveMining treats a null
client, socket errors, join refusals and malformed events as component
state (DISCONNECTED with the 5 s fallback), never as a thrown React error;
`LiveMiningBoundary` isolates the card; `app/dashboard/error.tsx` replaces
the generic screen with Retry / reload; `now` is null on first render
(hydration-safe); `src/lib/live/diagnostics.ts` records scrubbed error
metadata in memory only; `instrumentation-client.ts` reloads exactly once
per 5-minute window on stale-build failures (#412 / ChunkLoadError);
`?live=0` is a test-only switch that leaves the widget unmounted.

**Stability gate on the deployed build (throwaway test user, deleted
afterwards):** direct loads 50/50, soft navigations 50/50, hard reloads
20/20, back/forward 10/10, stale-build recovery: notice shown, one reload,
a second synthetic failure inside the window did not reload; Realtime
websocket blocked: "RECONNECTING · 5 s FALLBACK", 2 summary polls per
12 s, dashboard usable, 5/5 soft navigations; unblocked fresh page:
REALTIME again; slow network (400 ms, 500 kbit/s) 5/5; `?live=0` 10/10;
`/api/mining/summary` 200. 0 unhandled pageerrors, 0 generic error screens.

**Economic regression check (read-only, after testing):** 7 usage events,
ledger 1 row / 100,000, epoch-2026-09-07 settled mining-dev-v1,
epoch-2026-09-10 settled calibration, mining-beta-v2 still draft, test user
had 0 usage events. Realtime RLS policy untouched. No migration.

## Not done

The Windows Miner window does not yet mirror the live states (the web
dashboard was the priority; no Miner rebuild). The browser paint of the
transition was not observed by the harness because driving the owner's
session was out of scope; the same events the card consumes were observed
end to end on the same private channel.
