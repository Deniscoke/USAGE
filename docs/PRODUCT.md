# PRODUCT

## Thesis

Proof of Work → Proof of Stake → **Proof of Usage**.

USAGE answers one question first:

> How much verified AI compute have I actually used?

and eventually:

> What percentage of the network's verified AI usage belongs to me?

It is a provider-neutral usage layer, not an app tied to one AI company.

## Terminology

| Term | Meaning |
| --- | --- |
| **Usage event** | One normalized record of AI consumption (tokens, requests, cost) from any source. |
| **Verified** | Usage from an authoritative provider usage/cost/billing API. Trust weight 1.0. |
| **Routed** | Usage observed directly by USAGE-operated infrastructure (a future gateway). Trust weight 1.0. |
| **Reported** | Usage claimed by a local client, import or dev tool. Displayed; trust weight 0.0 for rewards. |
| **Proof of Usage score** | Versioned score derived from trust-weighted spend. Currently `usage_score_v1`. |
| **Epoch** | Fixed reward window (daily in V0) with a fixed pool of USAGE Points. |
| **USAGE Points** | Off-chain, non-transferable internal points. No monetary value, not an investment. |
| **Network share** | A user's score ÷ total network score for the epoch. |

## Scoring V1 (replaceable)

```
weightedSpend(day) = Σ cost(verification) × weight(verification)
points(day)        = sqrt(weightedSpendUSD) × 1000
```

Two properties matter more than the formula:

- **Concave.** 10× the spend yields ~3.16× the score. Splitting a day into many
  small events changes nothing, because the sqrt is applied to the daily total.
- **Pool-capped.** Each epoch distributes a fixed pool split by network share, so
  extra spend cannot mint extra points — it only dilutes everyone, including the
  spender. Farming is structurally unprofitable, not merely discouraged.

Every emitted score records `algorithm_version`, so `usage_score_v2` can ship
alongside without rewriting history.

## Privacy stance

USAGE measures consumption, it does not read work. Prompts, completions,
conversations and source code are never persisted. Stored fields are limited to
provider, model, timestamps, token counts, request counts, cost, source,
verification type and small non-sensitive proof metadata.

## MVP scope (V0)

In scope:

- Landing page explaining Proof of Usage.
- Demo account with deterministic synthetic usage across three adapters
  (verified / routed / reported), clearly labelled as demo data.
- Normalization pipeline with idempotent ingestion.
- Proof of Usage score V1 and epoch reward estimate.
- Dashboard: spend, tokens, score, network share, epoch estimate, provider and
  model distribution, verified-vs-reported split, recent activity, connections.
- Supabase schema with RLS (written, not yet provisioned).

Explicitly out of scope for V0: real provider integrations, auth-gated
multi-user data, gateway, CLI, leaderboards, organizations, fraud detection,
attestations, wallets, tokens, staking, governance.
