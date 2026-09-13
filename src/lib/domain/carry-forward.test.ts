import { describe, expect, it } from "vitest";
import { CARRIED_ACROSS_PRICING_REASON, holdIfCarriedAcrossPricing } from "./carry-forward";
import { isEconomicallyEligible } from "./scoring";
import type { NormalizedUsageRecord } from "./types";

/**
 * The cutover case, concretely: a request made on 2026-09-13 (priced
 * usage-pricing-v2) arrives after that epoch settled, is carried into
 * epoch-2026-09-14 (usage-pricing-v3), and must not stop 09-14 settling.
 */

function unit(overrides: Partial<NormalizedUsageRecord> = {}) {
  return {
    provider: "openrouter",
    source: "gateway",
    externalReference: "gen-late",
    model: "anthropic/claude-sonnet-4.6",
    occurredAt: "2026-09-13T23:58:00.000Z",
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 50,
    requests: 1,
    actualCostMicros: 1200,
    normalizedCostMicros: 1200,
    verificationType: "routed",
    verificationStatus: "confirmed",
    protocolPricingVersion: "usage-pricing-v2",
    eligibleComputeMicros: 1200,
    rewardStatus: "eligible",
    rawMetadata: {},
    ...overrides,
    epochId: "epoch-2026-09-14",
    carriedForward: true,
  } as NormalizedUsageRecord & { epochId: string; carriedForward: boolean };
}

describe("holdIfCarriedAcrossPricing", () => {
  it("holds a late unit carried into an epoch with a different pricing version", () => {
    const held = holdIfCarriedAcrossPricing(unit(), "usage-pricing-v3");
    expect(held.rewardStatus).toBe("held");
    expect(held.rewardHold).toBe(true);
    expect(held.eligibleComputeMicros).toBe(0);
    expect(held.rewardReason).toBe(CARRIED_ACROSS_PRICING_REASON);
    // And therefore counts for nothing in any score, v1 or v2.
    expect(isEconomicallyEligible(held)).toBe(false);
  });

  it("records where it came from and where it landed, so the hold can be audited", () => {
    const held = holdIfCarriedAcrossPricing(unit(), "usage-pricing-v3");
    expect(held.rawMetadata.carried_from_pricing_version).toBe("usage-pricing-v2");
    expect(held.rawMetadata.carried_into_pricing_version).toBe("usage-pricing-v3");
  });

  it("leaves a carried unit alone when both epochs price the same way", () => {
    const same = unit();
    expect(holdIfCarriedAcrossPricing(same, "usage-pricing-v2")).toBe(same);
  });

  it("leaves a unit that was never carried forward alone", () => {
    const onTime = { ...unit(), carriedForward: false };
    expect(holdIfCarriedAcrossPricing(onTime, "usage-pricing-v3")).toBe(onTime);
  });

  it("does not rewrite a unit that already earns nothing", () => {
    const duplicate = unit({ rewardStatus: "held", rewardReason: "duplicate_evidence", rewardHold: true });
    const result = holdIfCarriedAcrossPricing(duplicate, "usage-pricing-v3");
    expect(result.rewardReason).toBe("duplicate_evidence");
  });

  it("does not invent a mismatch for a unit that carries no pricing version", () => {
    const unpriced = unit({ protocolPricingVersion: null });
    expect(holdIfCarriedAcrossPricing(unpriced, "usage-pricing-v3")).toBe(unpriced);
  });
});
