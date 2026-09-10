import type { ProtocolPricingSnapshot } from "./types";

/**
 * PROTOCOL PRICING SNAPSHOT — usage-pricing-v3
 *
 * FROZEN AT CAPTURE. Regenerate into a NEW version; never edit this file once
 * an economic record references it.
 *
 * Captured : 2026-09-10 (M16A fresh audit), every price read from the
 *            provider's own current pricing page on that date, not inherited
 *            from usage-pricing-v2.
 * Values   : integer micro-USD per million tokens (so one token is exactly
 *            that many pico-USD: valuation is `pico_exact`, see ./exact.ts).
 * Policy   : an absent cache price is PENDING, never the input rate
 *            (`unknownCachePolicy: "pending"`). A unit that actually used an
 *            unpriced component is pending as a whole (M15C decision A).
 *
 * Sources
 *   anthropic/*  https://platform.claude.com/docs/en/about-claude/pricing
 *                "Model pricing" table: base input, 5m cache writes, cache
 *                hits and refreshes, output. The 5-minute write rate is the
 *                one recorded; 1h writes are not distinguishable in usage
 *                reports and would be UNDER-valued at the 5m rate, never over.
 *   openai/*     https://developers.openai.com/api/docs/pricing
 *                "Standard" table: short-context input, cached input, output.
 *                OpenAI bills no separate cache write and no separate
 *                reasoning line (reasoning tokens are output tokens), so
 *                both are left absent: a cache-write token would make the
 *                unit pending, and OpenAI usage reports never carry one.
 *
 * Not in v3 (no CURRENT first-party authoritative price on 2026-09-10; the
 * only listings are gateway routes whose figures changed since v2):
 *   anthropic/claude-3-haiku        absent from Anthropic's model pricing table
 *   nvidia/nemotron-3-nano-30b-a3b  open weights; OpenRouter route now $0.05/$0.20 (v2 had $0.24 output)
 *   inclusionai/ling-3.0-flash-fin  open weights; OpenRouter route now $0.06/$0.18 (v2 had 0/0)
 *   inclusionai/ling-3.0-flash-sante same
 * Units on those models are `pending_pricing` under v3 and earn nothing
 * until a later version states an authoritative rate.
 */
export const USAGE_PRICING_V3: ProtocolPricingSnapshot = {
  version: "usage-pricing-v3",
  source: "provider first-party pricing pages (see file header)",
  effectiveFrom: "2026-09-14",
  capturedAt: "2026-09-10T19:20:00.000Z",
  unknownCachePolicy: "pending",
  valuation: "pico_exact",
  prices: [
    {
      model: "anthropic/claude-opus-5",
      providerFamily: "anthropic",
      inputMicrosPerMillion: 5_000_000,
      outputMicrosPerMillion: 25_000_000,
      cacheReadMicrosPerMillion: 500_000,
      cacheWriteMicrosPerMillion: 6_250_000,
      reasoningMicrosPerMillion: null,
    },
    {
      model: "anthropic/claude-sonnet-4.6",
      providerFamily: "anthropic",
      inputMicrosPerMillion: 3_000_000,
      outputMicrosPerMillion: 15_000_000,
      cacheReadMicrosPerMillion: 300_000,
      cacheWriteMicrosPerMillion: 3_750_000,
      reasoningMicrosPerMillion: null,
    },
    {
      model: "anthropic/claude-haiku-4.5",
      providerFamily: "anthropic",
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 5_000_000,
      cacheReadMicrosPerMillion: 100_000,
      cacheWriteMicrosPerMillion: 1_250_000,
      reasoningMicrosPerMillion: null,
    },
    {
      model: "openai/gpt-5.4",
      providerFamily: "openai",
      inputMicrosPerMillion: 2_500_000,
      outputMicrosPerMillion: 15_000_000,
      cacheReadMicrosPerMillion: 250_000,
      cacheWriteMicrosPerMillion: null,
      reasoningMicrosPerMillion: null,
    },
    {
      model: "openai/gpt-5-nano",
      providerFamily: "openai",
      inputMicrosPerMillion: 50_000,
      outputMicrosPerMillion: 400_000,
      cacheReadMicrosPerMillion: 5_000,
      cacheWriteMicrosPerMillion: null,
      reasoningMicrosPerMillion: null,
    },
  ],
};

/** Models priced under v2 that v3 deliberately does not price, with the reason. */
export const USAGE_PRICING_V3_EXCLUDED: readonly { model: string; reason: string }[] = Object.freeze([
  { model: "anthropic/claude-3-haiku", reason: "absent from Anthropic's current model pricing table (2026-09-10)" },
  { model: "nvidia/nemotron-3-nano-30b-a3b", reason: "open weights; no first-party price, gateway route rate changed since v2" },
  { model: "inclusionai/ling-3.0-flash-fin", reason: "open weights; no first-party price, gateway route rate changed since v2" },
  { model: "inclusionai/ling-3.0-flash-sante", reason: "open weights; no first-party price, gateway route rate changed since v2" },
]);
