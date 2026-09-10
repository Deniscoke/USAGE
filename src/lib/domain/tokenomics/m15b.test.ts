import { describe, expect, it } from "vitest";
import { CURRENT_SCORING_VERSION, SCORING_VERSION_V2_DRAFT, getScoringAlgorithm, isActiveScoringVersion, scoreRecords } from "@/lib/domain/scoring";
import { CURRENT_PRICING_VERSION, getPricingSnapshot, listPricingVersions, priceTokens, protocolComputeValue } from "@/lib/pricing/compute";
import { auditUnknownCachePrices, exactProtocolComputeValueFor, picoToMicrosRounded, priceTokensPico } from "@/lib/pricing/exact";
import { USAGE_PRICING_V1 } from "@/lib/pricing/usage-pricing-v1";
import { USAGE_PRICING_V2 } from "@/lib/pricing/usage-pricing-v2";
import { USAGE_PRICING_V3, USAGE_PRICING_V3_EXCLUDED } from "@/lib/pricing/usage-pricing-v3";
import { CURRENT_MINING_PROTOCOL } from "@/lib/protocol/emission";
import { LINEAR_RULE, actorUnits, honestPopulation, scoreEpoch, splitExperiment } from "./simulator";
import { FIXED_FULL_POOL, baselineUtilisation, difficultyTarget, epochEconomics, farmingEquilibrium, hybrid, maxPointsForContribution, minimumActivity } from "./emission";
import type { NormalizedUsageRecord } from "@/lib/domain/types";

const USD = 1_000_000;
const POOL = 100_000;
const BG = honestPopulation(99, 1 * USD, 42);

// ---------------------------------------------------------------------------
// A. usage_score_v2 — linear, draft, inactive
// ---------------------------------------------------------------------------

describe("usage_score_v2 (draft) is linear in integer micro-USD", () => {
  const v2 = getScoringAlgorithm(SCORING_VERSION_V2_DRAFT);

  it("is registered as DRAFT and production still scores with v1", () => {
    expect(v2.status).toBe("draft");
    expect(isActiveScoringVersion(SCORING_VERSION_V2_DRAFT)).toBe(false);
    expect(CURRENT_SCORING_VERSION).toBe("usage_score_v1");
    expect(isActiveScoringVersion(CURRENT_SCORING_VERSION)).toBe(true);
    expect(CURRENT_MINING_PROTOCOL.scoringVersion).toBe("usage_score_v1");
  });

  it("linear exactness: score equals the micro-USD sum, identity on integers", () => {
    for (const micros of [1, 2, 999, 1_000_000, 123_456_789]) expect(v2.pointsForWeightedMicros(micros)).toBe(micros);
  });

  it("zero compute scores zero; negative is clamped to zero", () => {
    expect(v2.pointsForWeightedMicros(0)).toBe(0);
    expect(v2.pointsForWeightedMicros(-5)).toBe(0);
  });

  it("huge integer compute stays exact up to the safe-integer bound and refuses beyond", () => {
    expect(v2.pointsForWeightedMicros(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => v2.pointsForWeightedMicros(Number.MAX_SAFE_INTEGER + 2)).toThrow(/integer/);
    expect(() => v2.pointsForWeightedMicros(1.5)).toThrow(/integer/);
  });

  it("deterministic integer arithmetic through scoreRecords: 10,000 records sum without drift", () => {
    const base = {
      id: "x", userId: "u", provider: "openrouter", source: "gateway", externalReference: "e", model: "m",
      occurredAt: "2026-09-10T10:00:00Z", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 1,
      actualCostMicros: null, normalizedCostMicros: 0, verificationType: "routed", verificationStatus: "confirmed",
      economicStatus: "eligible", rewardStatus: "eligible", rewardHold: false, eligibleComputeMicros: 7, protocolComputeMicros: 7,
    } as unknown as NormalizedUsageRecord;
    const many = scoreRecords(Array.from({ length: 10_000 }, (_, i) => ({ ...base, id: `x${i}` })), SCORING_VERSION_V2_DRAFT);
    expect(many.points).toBe(70_000);
    expect(many.algorithmVersion).toBe("usage_score_v2");
  });

  it("the real M14C unit: v1 scores 1.0000, v2 scores 1 (micro-USD), exact pico value 500,000 (the $0.0000005 the provider charged)", () => {
    expect(getScoringAlgorithm("usage_score_v1").pointsForWeightedMicros(1)).toBe(1);
    expect(v2.pointsForWeightedMicros(1)).toBe(1);
    const exact = exactProtocolComputeValueFor("usage-pricing-v2", "openai/gpt-5-nano", { inputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0 })!;
    expect(exact.pico).toBe(500_000n);
    expect(exact.microsRoundedOnce).toBe(1);
  });
});

describe("splitting invariants under linear (simulator, 99 honest, attacker $10)", () => {
  for (const [dimension, n] of [["accounts", 1000], ["devices", 100], ["connections", 100], ["requests", 10_000]] as const) {
    it(`${dimension} 1 vs ${n}: attacker score identical to within 0.01%`, () => {
      const [r] = splitExperiment(BG, 10 * USD, [n], LINEAR_RULE, POOL, dimension);
      const one = scoreEpoch([...BG, ...actorUnits({ principalId: "attacker", computeMicros: 10 * USD })], LINEAR_RULE, POOL).principals.find((p) => p.principalId === "attacker")!;
      expect(Math.abs(r.attackerScore / one.score - 1)).toBeLessThanOrEqual(0.0001);
      expect(Math.abs(r.multiplier - 1)).toBeLessThanOrEqual(0.002); // integer point rounding across n accounts
    });
  }

  it("models: 50 models vs 1, identical score", () => {
    const one = scoreEpoch([...BG, ...actorUnits({ principalId: "a", computeMicros: 5 * USD })], LINEAR_RULE, POOL);
    const many = scoreEpoch([...BG, ...actorUnits({ principalId: "a", computeMicros: 5 * USD, models: Array.from({ length: 50 }, (_, i) => `m${i}`), requests: 50 })], LINEAR_RULE, POOL);
    expect(many.principals.find((p) => p.principalId === "a")!.score).toBe(one.principals.find((p) => p.principalId === "a")!.score);
  });

  it("whale behaviour: compute share becomes reward share", () => {
    for (const share of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      const honestTotal = 100 * USD;
      const whale = Math.round((share / (1 - share)) * honestTotal);
      const out = scoreEpoch([...honestPopulation(100, 1 * USD, 7, 0), ...actorUnits({ principalId: "whale", computeMicros: whale })], LINEAR_RULE, POOL);
      expect(out.principals.find((p) => p.principalId === "whale")!.share).toBeCloseTo(share, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// B. precision — pico-USD exact valuation
// ---------------------------------------------------------------------------

describe("pico-USD exact valuation removes the rounding exploit", () => {
  it("one token at 50,000 micro/M is exactly 50,000 pico; ten 10-token requests equal one 100-token request", () => {
    expect(priceTokensPico(50_000, 1)).toBe(50_000n);
    const split = Array.from({ length: 10 }, () => priceTokensPico(50_000, 10)).reduce((a, b) => a + b, 0n);
    expect(split).toBe(priceTokensPico(50_000, 100));
    expect(split).toBe(5_000_000n);
  });

  it("rounding exploit regression: per-request micro rounding gains 2× on tiny requests; pico gains exactly 0", () => {
    const microSplit = Array.from({ length: 10 }, () => priceTokens(50_000, 10)).reduce((a, b) => a + b, 0);
    expect(microSplit / priceTokens(50_000, 100)).toBe(2);
    const picoSplit = Array.from({ length: 10 }, () => priceTokensPico(50_000, 10)).reduce((a, b) => a + b, 0n);
    expect(picoSplit).toBe(priceTokensPico(50_000, 100));
  });

  it("any split of any request is pico-neutral (property over seeded splits)", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 200; trial += 1) {
      const price = Math.floor(rnd() * 30_000_000);
      const tokens = Math.floor(rnd() * 1_000_000);
      const pieces = 1 + Math.floor(rnd() * 50);
      let left = tokens;
      let sum = 0n;
      for (let i = 0; i < pieces; i += 1) {
        const take = i === pieces - 1 ? left : Math.floor(rnd() * (left + 1));
        left -= take;
        sum += priceTokensPico(price, take);
      }
      expect(sum).toBe(priceTokensPico(price, tokens));
    }
  });

  it("rounds to micro once, half-up, and refuses unsafe magnitudes", () => {
    expect(picoToMicrosRounded(499_999n)).toBe(0);
    expect(picoToMicrosRounded(500_000n)).toBe(1);
    expect(picoToMicrosRounded(1_500_000n)).toBe(2);
    expect(() => picoToMicrosRounded(10n ** 40n)).toThrow(/exact integer range/);
  });

  it("supports every current price exactly: pico per token equals the micro-per-million integer", () => {
    for (const p of [...USAGE_PRICING_V1.prices, ...USAGE_PRICING_V2.prices]) {
      expect(priceTokensPico(p.inputMicrosPerMillion, 1)).toBe(BigInt(p.inputMicrosPerMillion));
      expect(priceTokensPico(p.outputMicrosPerMillion, 1_000_000)).toBe(BigInt(p.outputMicrosPerMillion) * 1_000_000n);
    }
  });

  it("agrees with the legacy micro path whenever no rounding occurred", () => {
    const legacy = protocolComputeValue("usage-pricing-v2", "openai/gpt-5.4", { inputTokens: 1_000_000, cachedReadTokens: 400_000, cachedWriteTokens: 0, outputTokens: 20_000 })!;
    const exact = exactProtocolComputeValueFor("usage-pricing-v2", "openai/gpt-5.4", { inputTokens: 1_000_000, cachedReadTokens: 400_000, cachedWriteTokens: 0, outputTokens: 20_000 })!;
    expect(exact.microsRoundedOnce).toBe(legacy.micros);
  });
});

// ---------------------------------------------------------------------------
// C. unknown cache price ≠ input price
// ---------------------------------------------------------------------------

describe("unknown cache price policy", () => {
  it("audit: v1 and v2 both carry models whose cache reads fall back to the input rate", () => {
    const v2 = auditUnknownCachePrices(USAGE_PRICING_V2.prices);
    expect(v2.map((r) => r.model)).toEqual(expect.arrayContaining(["nvidia/nemotron-3-nano-30b-a3b", "openai/gpt-5-nano", "openai/gpt-5.4"]));
    // Only nemotron is both positive-priced AND missing cacheRead: the live exposure.
    const exposed = v2.filter((r) => !r.zeroPriced && r.missing.includes("cacheRead"));
    expect(exposed.map((r) => r.model)).toEqual(["nvidia/nemotron-3-nano-30b-a3b"]);
    expect(auditUnknownCachePrices(USAGE_PRICING_V1.prices).length).toBeGreaterThan(0);
  });

  it("cache-price unknown regression: legacy values nemotron cache reads at the input rate; the pending policy values them at 0 and flags the component", () => {
    const tokens = { inputTokens: 0, cachedReadTokens: 1_000_000, cachedWriteTokens: 0, outputTokens: 0 };
    const legacy = protocolComputeValue("usage-pricing-v2", "nvidia/nemotron-3-nano-30b-a3b", tokens)!;
    expect(legacy.micros).toBe(50_000);
    const held = exactProtocolComputeValueFor("usage-pricing-v2", "nvidia/nemotron-3-nano-30b-a3b", tokens, "pending")!;
    expect(held.pico).toBe(0n);
    expect(held.pendingComponents).toEqual(["cacheRead"]);
    // With no cache traffic nothing is pending, so priced requests are unaffected.
    const fresh = exactProtocolComputeValueFor("usage-pricing-v2", "nvidia/nemotron-3-nano-30b-a3b", { ...tokens, cachedReadTokens: 0, inputTokens: 1000 }, "pending")!;
    expect(fresh.pendingComponents).toEqual([]);
  });

  it("v3 is registered with the pending policy and pico valuation; the default version for epoch-less callers stays v2", () => {
    expect(USAGE_PRICING_V3.unknownCachePolicy).toBe("pending");
    expect(USAGE_PRICING_V3.valuation).toBe("pico_exact");
    expect(getPricingSnapshot("usage-pricing-v3")).toBe(USAGE_PRICING_V3);
    expect(listPricingVersions()).toEqual(["usage-pricing-v1", "usage-pricing-v2", "usage-pricing-v3"]);
    expect(CURRENT_PRICING_VERSION).toBe("usage-pricing-v2");
    // Fresh audit (M16A): only first-party-priced models; everything else is excluded by name.
    expect(USAGE_PRICING_V3.prices.map((p) => p.model).sort()).toEqual(["anthropic/claude-haiku-4.5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-4.6", "openai/gpt-5-nano", "openai/gpt-5.4"]);
    expect(USAGE_PRICING_V3_EXCLUDED.map((e) => e.model)).toContain("nvidia/nemotron-3-nano-30b-a3b");
    expect(USAGE_PRICING_V2.prices.map((p) => p.model).length).toBe(9);
  });

  it("v3 never falls back to the input rate: a unit that used an unpriced cache class is pending as a whole", () => {
    expect(protocolComputeValue("usage-pricing-v3", "openai/gpt-5.4", { inputTokens: 1000, cachedReadTokens: 0, cachedWriteTokens: 10, outputTokens: 0 })).toBeNull();
    expect(protocolComputeValue("usage-pricing-v3", "openai/gpt-5.4", { inputTokens: 1000, cachedReadTokens: 100, cachedWriteTokens: 0, outputTokens: 0 })!.micros).toBe(2500 + 25);
    expect(protocolComputeValue("usage-pricing-v3", "nvidia/nemotron-3-nano-30b-a3b", { inputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D. bootstrap emission
// ---------------------------------------------------------------------------

describe("bootstrap emission: the fixed pool over-rewards tiny networks", () => {
  it("tiny network / single miner: 1 micro-USD takes the whole 100,000 pool under A (10^11 points per dollar)", () => {
    const e = epochEconomics(FIXED_FULL_POOL, POOL, 1);
    expect(e.effectivePool).toBe(POOL);
    expect(e.pointsPerUsd).toBe(1e11);
  });

  it("zero participants: every candidate emits nothing", () => {
    for (const c of [FIXED_FULL_POOL, baselineUtilisation(100 * USD), difficultyTarget(100 * USD), hybrid(1000, 100 * USD), minimumActivity(1 * USD, 100 * USD)]) {
      expect(c.effectivePool({ scheduledPool: POOL, networkComputeMicros: 0 })).toBe(0);
    }
  });

  it("B baseline: points per dollar are capped at scheduled/B below the baseline and equal the fixed pool above it", () => {
    const B = baselineUtilisation(100 * USD);
    // Integer floor: below one point's worth of compute (B / pool = 1,000 micro) nothing is emitted at all.
    expect(epochEconomics(B, POOL, 1).effectivePool).toBe(0);
    for (const n of [1000, 1 * USD, 10 * USD, 50 * USD]) expect(epochEconomics(B, POOL, n).pointsPerUsd).toBeCloseTo(POOL / 100, 3);
    for (const n of [100 * USD, 1000 * USD, 100_000 * USD]) expect(epochEconomics(B, POOL, n).effectivePool).toBe(POOL);
  });

  it("baseline crossing is continuous: N = B−1 and N = B differ by at most one point", () => {
    const B = baselineUtilisation(100 * USD);
    expect(Math.abs(B.effectivePool({ scheduledPool: POOL, networkComputeMicros: 100 * USD }) - B.effectivePool({ scheduledPool: POOL, networkComputeMicros: 100 * USD - 1 }))).toBeLessThanOrEqual(1);
  });

  it("C difficulty: never reaches the full pool, half at target, points per dollar ≤ scheduled/T", () => {
    const C = difficultyTarget(100 * USD);
    expect(C.effectivePool({ scheduledPool: POOL, networkComputeMicros: 100 * USD })).toBe(POOL / 2);
    expect(C.effectivePool({ scheduledPool: POOL, networkComputeMicros: 100_000 * USD })).toBeLessThan(POOL);
    for (const n of [1, 1 * USD, 100 * USD, 10_000 * USD]) expect(epochEconomics(C, POOL, n).pointsPerUsd).toBeLessThanOrEqual(POOL / 100 + 1e-9);
  });

  it("D hybrid: a sole tiny miner gets exactly the floor, never more", () => {
    const D = hybrid(1000, 100 * USD);
    expect(D.effectivePool({ scheduledPool: POOL, networkComputeMicros: 1 })).toBe(1000);
    expect(D.effectivePool({ scheduledPool: POOL, networkComputeMicros: 100 * USD })).toBe(POOL);
  });

  it("E minimum: below M nothing is emitted; the step is the threshold an attacker aims for", () => {
    const E = minimumActivity(1 * USD, 100 * USD);
    expect(E.effectivePool({ scheduledPool: POOL, networkComputeMicros: 1 * USD - 1 })).toBe(0);
    expect(E.effectivePool({ scheduledPool: POOL, networkComputeMicros: 1 * USD })).toBe(1000);
  });

  it("§9 invariant: under B and C an actor's points never exceed scheduled × c / B, however empty the network; under A they do", () => {
    const c = 1; // one micro-USD, the M14C-sized contribution
    for (const n of [1, 1000, 1 * USD, 100 * USD]) {
      expect(maxPointsForContribution(baselineUtilisation(100 * USD), POOL, c, n)).toBeLessThanOrEqual((POOL * c) / (100 * USD) + 1e-9);
      expect(maxPointsForContribution(difficultyTarget(100 * USD), POOL, c, n)).toBeLessThanOrEqual((POOL * c) / (100 * USD) + 1e-9);
    }
    expect(maxPointsForContribution(FIXED_FULL_POOL, POOL, c, 1)).toBe(POOL);
  });

  it("attacker enters near threshold: under B, adding $1 to a $99 network unlocks 1,000 more points but the attacker's own share of them is 1%", () => {
    const B = baselineUtilisation(100 * USD);
    const before = B.effectivePool({ scheduledPool: POOL, networkComputeMicros: 99 * USD });
    const after = B.effectivePool({ scheduledPool: POOL, networkComputeMicros: 100 * USD });
    expect(after - before).toBe(1000);
    expect(maxPointsForContribution(B, POOL, 1 * USD, 100 * USD)).toBeCloseTo(1000, 6);
  });
});

describe("farming equilibrium under linear scoring", () => {
  const honest = 10 * USD;

  it("A fixed: entry is rational at ANY positive point value while N < P×pool; farming self-dilutes to N* = P×pool", () => {
    const P = 1e-3; // hypothetical value per point, normalised
    const r = farmingEquilibrium(FIXED_FULL_POOL, POOL, P, honest);
    expect(r.entry).toBe(true);
    expect(r.equilibriumMicros).toBeCloseTo(P * POOL * USD, -3);
    expect(r.pointsPerUsdAtEquilibrium).toBeCloseTo(1 / P, 0);
  });

  it("B baseline: no entry at all while P × scheduled/B ≤ 1; above that the same N* = P×pool equilibrium", () => {
    const B = baselineUtilisation(100 * USD);
    expect(farmingEquilibrium(B, POOL, 1e-3, honest).entry).toBe(false); // 1e-3 × 1000 = 1, not > 1
    expect(farmingEquilibrium(B, POOL, 2e-3, honest).entry).toBe(true);
    expect(farmingEquilibrium(B, POOL, 2e-3, honest).equilibriumMicros).toBeCloseTo(2e-3 * POOL * USD, -3);
  });

  it("C difficulty: entry needs P × scheduled > T; equilibrium N* = P×pool − T", () => {
    const C = difficultyTarget(100 * USD);
    expect(farmingEquilibrium(C, POOL, 5e-4, honest).entry).toBe(false);
    const r = farmingEquilibrium(C, POOL, 2e-3, honest);
    expect(r.entry).toBe(true);
    expect(r.equilibriumMicros).toBeCloseTo(2e-3 * POOL * USD - 100 * USD, -4);
  });

  it("more farming always lowers points per dollar: no runaway under any candidate", () => {
    for (const c of [FIXED_FULL_POOL, baselineUtilisation(100 * USD), difficultyTarget(100 * USD), hybrid(1000, 100 * USD)]) {
      let last = Number.POSITIVE_INFINITY;
      for (const n of [1 * USD, 10 * USD, 100 * USD, 1000 * USD, 10_000 * USD]) {
        const rate = epochEconomics(c, POOL, n).pointsPerUsd;
        expect(rate).toBeLessThanOrEqual(last + 1e-9);
        last = rate;
      }
    }
  });
});
