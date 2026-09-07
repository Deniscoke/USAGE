import { describe, expect, it } from "vitest";
import {
  CURRENT_PRICING_VERSION,
  findModelPrice,
  getPricingSnapshot,
  priceTokens,
  protocolComputeValue,
} from "./compute";
import { USAGE_PRICING_V1 } from "./usage-pricing-v1";

/**
 * Protocol pricing is the economic basis of mining, so it has to be exact,
 * frozen, and honest about what it does not know.
 */

describe("integer pricing arithmetic", () => {
  it("prices whole millions exactly", () => {
    expect(priceTokens(1_000_000, 1_000_000)).toBe(1_000_000);
    expect(priceTokens(5_000_000, 200)).toBe(1_000);
  });

  it("rounds half-up at the micro boundary, deterministically", () => {
    // 1 micro-USD per million: 499_999 tokens -> 0.499999, 500_000 -> 0.5
    expect(priceTokens(1, 499_999)).toBe(0);
    expect(priceTokens(1, 500_000)).toBe(1);
    expect(priceTokens(1, 1_500_000)).toBe(2);
  });

  it("is exact past the float range", () => {
    // $30/M over 10^9 tokens is 3e16, beyond 2^53: a float would drift here.
    expect(priceTokens(30_000_000, 1_000_000_000)).toBe(30_000_000_000);
  });

  it("treats zero as zero rather than a rounding artefact", () => {
    expect(priceTokens(0, 5_000_000)).toBe(0);
    expect(priceTokens(1_000_000, 0)).toBe(0);
  });

  it("rejects nonsense instead of coercing it", () => {
    expect(() => priceTokens(-1, 10)).toThrow();
    expect(() => priceTokens(1, -10)).toThrow();
    expect(() => priceTokens(1.5, 10)).toThrow();
  });
});

describe("protocol compute value", () => {
  const model = "anthropic/claude-haiku-4.5";

  it("prices each token class from the snapshot", () => {
    const value = protocolComputeValue(CURRENT_PRICING_VERSION, model, {
      inputTokens: 1_000_000,
      cachedReadTokens: 1_000_000,
      cachedWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    })!;

    // input $1.00, cache read $0.10, cache write $1.25, output $5.00 per 1M
    expect(value.components).toEqual({
      input: 1_000_000,
      cacheRead: 100_000,
      cacheWrite: 1_250_000,
      output: 5_000_000,
      reasoning: 0,
    });
    expect(value.micros).toBe(7_350_000);
    expect(value.pricingVersion).toBe(CURRENT_PRICING_VERSION);
  });

  it("charges cache reads far less than fresh input", () => {
    const cached = protocolComputeValue(CURRENT_PRICING_VERSION, model, {
      inputTokens: 0,
      cachedReadTokens: 1_000_000,
      cachedWriteTokens: 0,
      outputTokens: 0,
    })!;
    const fresh = protocolComputeValue(CURRENT_PRICING_VERSION, model, {
      inputTokens: 1_000_000,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      outputTokens: 0,
    })!;
    expect(cached.micros * 10).toBe(fresh.micros);
  });

  it("does not double count reasoning tokens", () => {
    // Reasoning is a breakdown of output, already priced there.
    const withReasoning = protocolComputeValue(CURRENT_PRICING_VERSION, model, {
      inputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      outputTokens: 1_000,
      reasoningTokens: 600,
    })!;
    const without = protocolComputeValue(CURRENT_PRICING_VERSION, model, {
      inputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      outputTokens: 1_000,
    })!;
    expect(withReasoning.micros).toBe(without.micros);
  });

  it("returns null for a model the snapshot does not price", () => {
    expect(
      protocolComputeValue(CURRENT_PRICING_VERSION, "acme/never-priced-9", {
        inputTokens: 1_000,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 1_000,
      }),
    ).toBeNull();
  });

  it("returns null for an unknown pricing version", () => {
    expect(
      protocolComputeValue("usage-pricing-v99", model, {
        inputTokens: 1,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 1,
      }),
    ).toBeNull();
  });

  it("is reproducible from its own breakdown", () => {
    const value = protocolComputeValue(CURRENT_PRICING_VERSION, model, {
      inputTokens: 4_821,
      cachedReadTokens: 12_004,
      cachedWriteTokens: 301,
      outputTokens: 217,
    })!;
    const sum =
      value.components.input +
      value.components.cacheRead +
      value.components.cacheWrite +
      value.components.output +
      value.components.reasoning;
    expect(value.micros).toBe(sum);
  });
});

describe("snapshot integrity", () => {
  it("carries its provenance", () => {
    expect(USAGE_PRICING_V1.version).toBe("usage-pricing-v1");
    expect(USAGE_PRICING_V1.source).toBe("vercel-ai-gateway-catalog");
    expect(USAGE_PRICING_V1.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(USAGE_PRICING_V1.prices.length).toBeGreaterThan(0);
  });

  it("holds only integer prices", () => {
    for (const price of USAGE_PRICING_V1.prices) {
      for (const value of [
        price.inputMicrosPerMillion,
        price.outputMicrosPerMillion,
        price.cacheReadMicrosPerMillion,
        price.cacheWriteMicrosPerMillion,
      ]) {
        if (value === null || value === undefined) continue;
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("prices no model twice", () => {
    const models = USAGE_PRICING_V1.prices.map((price) => price.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it("pins the values mining depends on", () => {
    // A guard against an accidental edit to a frozen snapshot: changing these
    // would silently re-price history.
    const haiku = findModelPrice("usage-pricing-v1", "anthropic/claude-haiku-4.5")!;
    expect(haiku.inputMicrosPerMillion).toBe(1_000_000);
    expect(haiku.outputMicrosPerMillion).toBe(5_000_000);
    expect(haiku.cacheReadMicrosPerMillion).toBe(100_000);
    expect(haiku.cacheWriteMicrosPerMillion).toBe(1_250_000);
  });

  it("does not resolve a version that was never published", () => {
    expect(getPricingSnapshot("usage-pricing-v2")).toBeNull();
  });
});
