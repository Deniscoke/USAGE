import type { ProtocolPricingSnapshot } from "./types";

/**
 * PROTOCOL PRICING SNAPSHOT — usage-pricing-v2
 *
 * GENERATED, THEN FROZEN. Regenerate into a NEW version; never edit this file
 * once economic records reference it, or historical mining would silently
 * change.
 *
 * Source   : Vercel AI Gateway model catalog (GET /v1/models)
 * Captured : 2026-09-07T20:32:27.982Z
 *
 * Values are integer micro-USD per million tokens. These are PROTOCOL prices,
 * used to compute a deterministic compute value for mining. They are not an
 * invoice and are not what anyone was billed — see docs/ARCHITECTURE.md.
 */
export const USAGE_PRICING_V2: ProtocolPricingSnapshot = {
  version: "usage-pricing-v2",
  source: "vercel-ai-gateway-catalog",
  effectiveFrom: "2026-09-07",
  capturedAt: "2026-09-07T20:32:27.983Z",
  prices: [
  {
    model: "anthropic/claude-3-haiku",
    providerFamily: "anthropic",
    inputMicrosPerMillion: 250000,
    outputMicrosPerMillion: 1250000,
    cacheReadMicrosPerMillion: 30000,
    cacheWriteMicrosPerMillion: 300000,
  },
  {
    model: "anthropic/claude-haiku-4.5",
    providerFamily: "anthropic",
    inputMicrosPerMillion: 1000000,
    outputMicrosPerMillion: 5000000,
    cacheReadMicrosPerMillion: 100000,
    cacheWriteMicrosPerMillion: 1250000,
  },
  {
    model: "anthropic/claude-sonnet-4.6",
    providerFamily: "anthropic",
    inputMicrosPerMillion: 3000000,
    outputMicrosPerMillion: 15000000,
    cacheReadMicrosPerMillion: 300000,
    cacheWriteMicrosPerMillion: 3750000,
  },
  {
    model: "anthropic/claude-opus-5",
    providerFamily: "anthropic",
    inputMicrosPerMillion: 5000000,
    outputMicrosPerMillion: 25000000,
    cacheReadMicrosPerMillion: 500000,
    cacheWriteMicrosPerMillion: 6250000,
  },
  {
    model: "openai/gpt-5.4",
    providerFamily: "openai",
    inputMicrosPerMillion: 2500000,
    outputMicrosPerMillion: 15000000,
    cacheReadMicrosPerMillion: 250000,
    cacheWriteMicrosPerMillion: null,
  },
  {
    model: "openai/gpt-5-nano",
    providerFamily: "openai",
    inputMicrosPerMillion: 50000,
    outputMicrosPerMillion: 400000,
    cacheReadMicrosPerMillion: 5000,
    cacheWriteMicrosPerMillion: null,
  },
  {
    model: "nvidia/nemotron-3-nano-30b-a3b",
    providerFamily: "nvidia",
    inputMicrosPerMillion: 50000,
    outputMicrosPerMillion: 240000,
    cacheReadMicrosPerMillion: null,
    cacheWriteMicrosPerMillion: null,
  },
  {
    model: "inclusionai/ling-3.0-flash-fin",
    providerFamily: "inclusionai",
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    cacheReadMicrosPerMillion: null,
    cacheWriteMicrosPerMillion: null,
  },
  {
    model: "inclusionai/ling-3.0-flash-sante",
    providerFamily: "inclusionai",
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    cacheReadMicrosPerMillion: null,
    cacheWriteMicrosPerMillion: null,
  },
  ],
};
