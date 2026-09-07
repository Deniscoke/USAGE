import { USAGE_PRICING_V1 } from "./usage-pricing-v1";
import type { ProtocolModelPrice, ProtocolPricingSnapshot } from "./types";

/**
 * Protocol compute value.
 *
 * The deterministic economic basis for mining: what a unit of verified compute
 * is worth to the protocol, independent of what anyone was billed for it.
 *
 * This is NOT a cost. Two identical requests mine identically whether one was
 * paid at list price and the other covered by BYOK, promotional credits, an
 * enterprise discount or free-tier credit. Calling it a cost anywhere in the
 * codebase or the UI would be a lie about what it measures.
 */

export const CURRENT_PRICING_VERSION = USAGE_PRICING_V1.version;

const SNAPSHOTS: Readonly<Record<string, ProtocolPricingSnapshot>> = Object.freeze({
  [USAGE_PRICING_V1.version]: USAGE_PRICING_V1,
});

export function getPricingSnapshot(version: string): ProtocolPricingSnapshot | null {
  return SNAPSHOTS[version] ?? null;
}

export function listPricingVersions(): readonly string[] {
  return Object.keys(SNAPSHOTS);
}

export function findModelPrice(version: string, model: string): ProtocolModelPrice | null {
  return getPricingSnapshot(version)?.prices.find((price) => price.model === model) ?? null;
}

export interface ComputeTokens {
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
}

export interface ProtocolComputeValue {
  micros: number;
  pricingVersion: string;
  /** Per-component breakdown, so a value can be audited rather than trusted. */
  components: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
}

/**
 * micro-USD for `tokens` at `microsPerMillion`, rounded half-up.
 *
 * BigInt because the intermediate product overflows exact float range: a
 * $30/M model at 10^9 tokens is 3×10^16, past 2^53. Half-up is chosen simply
 * because it is deterministic and symmetric for the non-negative values that
 * occur here; the point is that every implementation must agree, forever.
 */
export function priceTokens(microsPerMillion: number, tokens: number): number {
  if (!Number.isInteger(microsPerMillion) || microsPerMillion < 0) {
    throw new Error(`Invalid price: ${microsPerMillion}`);
  }
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new Error(`Invalid token count: ${tokens}`);
  }
  if (tokens === 0 || microsPerMillion === 0) return 0;

  const product = BigInt(microsPerMillion) * BigInt(tokens);
  const rounded = (product + 500_000n) / 1_000_000n;

  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) {
    throw new Error("Protocol compute value exceeds exact integer range");
  }
  return value;
}

/**
 * Compute the protocol value of one confirmed proof.
 *
 * Returns null when the pricing version does not price this model. That is a
 * deliberate dead end: the proof stays confirmed and its economics wait for a
 * pricing version that covers it. Inventing a price would invent money.
 */
export function protocolComputeValue(
  version: string,
  model: string,
  tokens: ComputeTokens,
): ProtocolComputeValue | null {
  const price = findModelPrice(version, model);
  if (!price) return null;

  // Cache reads and writes fall back to the input rate only when the provider
  // does not price them separately, which is what "not priced separately" means.
  const cacheReadRate = price.cacheReadMicrosPerMillion ?? price.inputMicrosPerMillion;
  const cacheWriteRate = price.cacheWriteMicrosPerMillion ?? price.inputMicrosPerMillion;
  // Reasoning tokens are a breakdown of output tokens and are already counted
  // there; they are priced separately only if a provider ever charges for them
  // on top, which none currently does.
  const reasoningRate = price.reasoningMicrosPerMillion ?? 0;

  const components = {
    input: priceTokens(price.inputMicrosPerMillion, tokens.inputTokens),
    cacheRead: priceTokens(cacheReadRate, tokens.cachedReadTokens),
    cacheWrite: priceTokens(cacheWriteRate, tokens.cachedWriteTokens),
    output: priceTokens(price.outputMicrosPerMillion, tokens.outputTokens),
    reasoning: priceTokens(reasoningRate, tokens.reasoningTokens ?? 0),
  };

  return {
    // Rounded per component so the total is reproducible from the breakdown.
    micros:
      components.input +
      components.cacheRead +
      components.cacheWrite +
      components.output +
      components.reasoning,
    pricingVersion: version,
    components,
  };
}
