# PRODUCT

## USE AI → EARN USAGE

USAGE is an **AI compute network**. A person uses AI the way they already do;
USAGE measures the compute, proves it happened, and turns it into a share of a
fixed reward pool.

> I use AI normally. USAGE measures my verified AI consumption. The more
> legitimate AI compute I use, the more USAGE I can earn.

Nothing above requires the user to understand epochs, protocol compute value or
receipt signatures. Those exist, they are real, and they are one click away.

## Three things, three names

| Name | What it is | Status |
| --- | --- | --- |
| **USAGE App** | The product: connect AI tools, watch verified compute, earn. | Beta |
| **USAGE Protocol** | Proof of Usage, protocol compute value, scoring, epochs, emission. | Development network |
| **$USAGE** | A possible future token. | **Does not exist** |

**USAGE Points** are the beta unit shown as "USAGE" in the app. They are
off-chain, non-transferable, carry no monetary value and are not an investment.
The accounting is built so a future token could reference historical epoch
allocations without rewriting them — that is readiness, not a promise, and the
conversion (if any) is a future governance decision. Nothing anywhere maps one
point to one token.

## The user journey

```
sign up → choose AI → enable mining → use AI → confirmed compute
        → mining score → estimated USAGE → epoch settles → USAGE balance
```

The last two steps are the ones people confuse, so the product never does:

- **Estimated USAGE** is a projection of the current OPEN epoch. It moves as
  usage arrives, and it is never written to the ledger.
- **USAGE Balance** is what settled epochs actually credited. It is permanent,
  and a settled allocation never changes.

## Terminology

| Term | Meaning |
| --- | --- |
| **Usage event** | One normalized record of AI consumption from any source. |
| **Verified** | Usage from an authoritative provider usage/cost API. Weight 1.0. |
| **Routed** | Usage observed first-hand by USAGE infrastructure. Weight 1.0. |
| **Reported** | Usage claimed by a client or import. Shown; weight 0.0. Earns nothing. |
| **Proof status** | Does USAGE attest this happened? `observed` / `confirmed` / `rejected`. |
| **Economic status** | May it earn now? `eligible` / `pending_pricing` / `pending_cost` / `settled` / `ineligible`. |
| **Protocol compute value** | What the protocol values a unit of verified compute at, from a frozen pricing snapshot. **Not a bill.** |
| **Mining score** | Versioned daily score from protocol compute value. `usage_score_v1`. |
| **Epoch** | A reward window with a fixed emission. `open` → `finalizing` → `settled`. |
| **USAGE Points** | Off-chain, non-transferable beta rewards. |
| **Compute Credits** | A *future*, unrelated unit: pre-funded money for buying compute. Not points. |

Only `routed + confirmed` or `verified + confirmed` usage can become
economically eligible. That rule is the product, not an implementation detail.

## Why it cannot be farmed

There is deliberately **no rate** converting tokens or dollars into USAGE. A
fixed pool is emitted per epoch and split by share of score:

```
protocol compute value → daily mining score (√ of the daily total)
                       → share of a FIXED epoch emission
                       → USAGE Points
```

Two consequences, both intended:

- **Concave.** 10× the compute yields ~3.16× the score, and the square root is
  applied to the daily total, so splitting requests changes nothing.
- **Zero-sum against yourself.** Burning tokens cannot mint points. It dilutes
  every participant, including the one burning them.

The UI may say "use AI, earn USAGE". The protocol still refuses to pay a rate.

## Providers

USAGE is not built around any one AI company. A provider registry declares, per
provider, what actually exists:

| Method | Meaning |
| --- | --- |
| **Routed mining** | USAGE routes the request and observes it first-hand. |
| **Verified import** | Historical usage pulled from a provider's admin API. |
| **BYOK** | The user's own provider key. |
| **Subscription** | The user's existing consumer subscription, forwarded. |

A capability is shown as available only when an implementation exists and a
gateway backs it; everything else says COMING SOON with a reason. `/providers`
renders straight from the registry, so the page cannot overstate the product.

## Privacy

> USAGE tracks your AI compute, not your conversations.

Stored: model, token counts, timestamps, provider, proof metadata.
Never stored: prompts, responses, tool arguments, source code, conversations.
Never logged: credentials of any kind.

## What USAGE is not

- Not a blockchain, token, wallet, exchange or staking product.
- Not a payment processor. Compute Credits are designed for, not implemented.
- Not an investment, and not a claim on any future token.
