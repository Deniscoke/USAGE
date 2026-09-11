import { describe, expect, it } from "vitest";
import { MINING_BETA_V2_PARAMETERS, assertV2Invariants, effectivePoolBaselineLinear, planV2Settlement, previewEffectivePoolFractional, type V2SettlementContext } from "./settlement-v2";
import { CURRENT_MINING_PROTOCOL, MINING_BETA_V2_DRAFT, MINING_DEV_V1, getMiningProtocol, listMiningProtocols } from "@/lib/protocol/emission";
import { SCORING_VERSION_V2_DRAFT, scoreRecords } from "@/lib/domain/scoring";
import { priceTokensPico } from "@/lib/pricing/exact";
import type { NormalizedUsageRecord } from "@/lib/domain/types";

const POOL = 100_000n;
const B = MINING_BETA_V2_PARAMETERS.baselineComputePico;
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) * 1_000_000n; // exact for the values used here

function healthyContext(plan: ReturnType<typeof planV2Settlement>): V2SettlementContext {
  return {
    duplicateEconomicKeys: 0,
    pricingVersionStatus: "frozen",
    scoringVersionActive: true,
    emissionVersionActive: true,
    epochScoringVersion: "usage_score_v2",
    epochPricingVersion: "usage-pricing-v3",
    epochEmissionVersion: "mining-beta-v2",
    recomputedNetworkPico: plan.networkPico,
    existingLedgerRowsForEpoch: 0,
    ineligibleParticipants: 0,
  };
}

// ---------------------------------------------------------------------------
// §1 §2 the owner's parameter table, from the actual code
// ---------------------------------------------------------------------------

describe("mining-beta-v2 parameters (draft)", () => {
  it("is locked exactly as decided: linear, cap 100,000, B = $1,000 = 10^15 pico, F = 0, never minted", () => {
    expect(MINING_BETA_V2_PARAMETERS.scheduledPoolPoints).toBe(100_000n);
    expect(MINING_BETA_V2_PARAMETERS.baselineComputePico).toBe(1_000_000_000_000_000n);
    expect(MINING_BETA_V2_PARAMETERS.baselineComputePico).toBe(1_000_000_000n * 1_000_000n); // $1000 in micro × pico/micro
    expect(MINING_BETA_V2_PARAMETERS.floorPoints).toBe(0n);
    expect(MINING_BETA_V2_PARAMETERS.undistributedPolicy).toBe("never_minted");
    // Scheduled, not draft: approved and bound to epoch-2026-09-14. The
    // PARAMETERS above are what must stay locked; the status is allowed to
    // advance, and only through a named epoch.
    expect(MINING_BETA_V2_DRAFT.status).toBe("scheduled");
    expect(MINING_BETA_V2_DRAFT.baselineComputePico).toBe(B);
  });

  it("mining-dev-v1 is untouched and still governs every epoch before the cutover", () => {
    expect(CURRENT_MINING_PROTOCOL).toBe(MINING_DEV_V1);
    expect(MINING_DEV_V1.scoringVersion).toBe("usage_score_v1");
    expect(MINING_DEV_V1.status).toBe("active");
    expect(listMiningProtocols().map((v) => v.version)).toEqual(["mining-dev-v1"]);
    expect(getMiningProtocol("mining-beta-v2")?.status).toBe("scheduled");
  });

  it("§2 parameter table", () => {
    const rows: [number, bigint][] = [[0, 0n], [0.001, 0n], [0.01, 1n], [0.1, 10n], [1, 100n], [10, 1_000n], [100, 10_000n], [1_000, 100_000n], [10_000, 100_000n]];
    for (const [n, expected] of rows) expect(effectivePoolBaselineLinear(POOL, usd(n), B)).toBe(expected);
  });

  it("maximum pre-baseline emission density is exactly 100 points per protocol dollar, and falls above the baseline", () => {
    for (const n of [0.01, 1, 10, 100, 999.99, 1000]) {
      const points = Number(effectivePoolBaselineLinear(POOL, usd(n), B));
      expect(points / n).toBeLessThanOrEqual(100 + 1e-9);
    }
    expect(Number(effectivePoolBaselineLinear(POOL, usd(1000), B)) / 1000).toBe(100);
    expect(Number(effectivePoolBaselineLinear(POOL, usd(10_000), B)) / 10_000).toBe(10);
    expect(Number(effectivePoolBaselineLinear(POOL, usd(100_000), B)) / 100_000).toBe(1);
  });

  it("with F = 0, points per dollar are bounded as N → 0; any positive floor would make them unbounded", () => {
    expect(effectivePoolBaselineLinear(POOL, 1n, B)).toBe(0n);
    const withFloor = { ...MINING_BETA_V2_PARAMETERS, floorPoints: 1n as unknown as 0n };
    const tiny = planV2Settlement([{ userId: "u", eligiblePico: 1n }], withFloor);
    expect(tiny.effectivePoints).toBe(1n); // 1 point for 10^-12 USD: 10^12 points per dollar
  });

  it("§12 below $0.01 the pool floors to zero; the non-binding preview still moves", () => {
    expect(effectivePoolBaselineLinear(POOL, usd(0.009), B)).toBe(0n);
    expect(previewEffectivePoolFractional(usd(0.009))).toBe("0.9000");
    expect(previewEffectivePoolFractional(usd(0.001))).toBe("0.1000");
    expect(previewEffectivePoolFractional(1n)).toBe("0.0000");
  });
});

// ---------------------------------------------------------------------------
// §13 §14 farming and whales at the chosen B
// ---------------------------------------------------------------------------

describe("linear + baseline at B = $1,000 (miners × network compute)", () => {
  it("one miner, 10, 100, 1000 miners: points per dollar depend only on N, never on the miner count", () => {
    for (const n of [0.01, 0.1, 1, 10, 100, 1000, 10_000]) {
      const expected = effectivePoolBaselineLinear(POOL, usd(n), B);
      for (const miners of [1, 10, 100, 1000]) {
        const each = usd(n) / BigInt(miners);
        const plan = planV2Settlement(Array.from({ length: miners }, (_, i) => ({ userId: `m${i}`, eligiblePico: each })));
        // Equal split may lose up to (miners − 1) pico to integer division, never a point.
        expect(plan.effectivePoints === expected || plan.effectivePoints === expected - 1n).toBe(true);
        expect(plan.ledgerDelta).toBe(plan.effectivePoints);
      }
    }
  });

  it("hypothetical point value P: wash entry is irrational below baseline unless P > B/scheduled = 0.01 per point; above baseline it self-dilutes", () => {
    const rate = (n: number) => Number(effectivePoolBaselineLinear(POOL, usd(n), B)) / n;
    for (const P of [1e-4, 1e-3, 9e-3]) for (const n of [0.01, 1, 100, 1000]) expect(P * rate(n)).toBeLessThanOrEqual(1);
    expect(0.02 * rate(1000)).toBeGreaterThan(1);
    expect(0.02 * rate(2000)).toBeCloseTo(1, 9); // equilibrium N* = P × scheduled = $2,000
    expect(0.02 * rate(4000)).toBeLessThan(1);
  });

  it("account splitting: the same pico compute in 1 vs 1000 accounts changes neither the effective pool nor the actor's total points", () => {
    const honest = Array.from({ length: 99 }, (_, i) => ({ userId: `h${i}`, eligiblePico: usd(1) }));
    const one = planV2Settlement([...honest, { userId: "a", eligiblePico: usd(10) }]);
    const split = planV2Settlement([...honest, ...Array.from({ length: 1000 }, (_, i) => ({ userId: `a${i}`, eligiblePico: usd(10) / 1000n }))]);
    expect(split.effectivePoints).toBe(one.effectivePoints);
    const onePts = one.allocations.find((x) => x.userId === "a")!.points;
    const splitPts = split.allocations.filter((x) => x.userId.startsWith("a")).reduce((s, x) => s + x.points, 0n);
    // Largest remainder over 1000 rows can move at most one point per row boundary; the score is identical.
    expect(split.allocations.filter((x) => x.userId.startsWith("a")).reduce((s, x) => s + x.score, 0n)).toBe(one.allocations.find((x) => x.userId === "a")!.score);
    expect(Number(splitPts - onePts) / Number(onePts)).toBeLessThanOrEqual(0.002);
  });

  it("request splitting: pico pricing makes 1 request and 10,000 requests identical to the last pico", () => {
    const one = priceTokensPico(400_000, 10_000_000);
    let many = 0n;
    for (let i = 0; i < 10_000; i += 1) many += priceTokensPico(400_000, 1_000);
    expect(many).toBe(one);
  });

  it("device / connection splitting: v2 has no such key at all (score is a per-user sum)", () => {
    const base = { id: "x", userId: "u", provider: "openrouter", source: "gateway", externalReference: "e", model: "m", occurredAt: "2026-09-12T10:00:00Z", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 1, actualCostMicros: null, normalizedCostMicros: 0, verificationType: "routed", verificationStatus: "confirmed", economicStatus: "eligible", rewardStatus: "eligible", rewardHold: false, eligibleComputeMicros: 5, protocolComputeMicros: 5 } as unknown as NormalizedUsageRecord;
    const oneDevice = scoreRecords(Array.from({ length: 100 }, (_, i) => ({ ...base, id: `x${i}`, gatewayId: "connection:one", deviceId: "d1" })), SCORING_VERSION_V2_DRAFT);
    const manyDevices = scoreRecords(Array.from({ length: 100 }, (_, i) => ({ ...base, id: `y${i}`, gatewayId: `connection:${i}`, deviceId: `d${i}` })), SCORING_VERSION_V2_DRAFT);
    expect(manyDevices.points).toBe(oneDevice.points);
    expect(oneDevice.points).toBe(500);
  });

  it("§14 whales: X% of eligible compute receives X% of the effective pool", () => {
    for (const share of [0.01, 0.1, 0.25, 0.5, 0.9]) {
      const honestTotal = usd(2000); // above baseline, so the full pool is in play
      const whale = BigInt(Math.round((share / (1 - share)) * 2000 * 1e6)) * 1_000_000n;
      const honest = Array.from({ length: 100 }, (_, i) => ({ userId: `h${i}`, eligiblePico: honestTotal / 100n }));
      const plan = planV2Settlement([...honest, { userId: "whale", eligiblePico: whale }]);
      const pts = plan.allocations.find((a) => a.userId === "whale")!.points;
      expect(Number(pts) / Number(plan.effectivePoints)).toBeCloseTo(share, 3);
    }
  });

  it("§15 provider neutrality: equal eligible compute from any provider scores identically under v2", () => {
    const base = { id: "x", userId: "u", source: "gateway", externalReference: "e", model: "m", occurredAt: "2026-09-12T10:00:00Z", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 1, actualCostMicros: null, normalizedCostMicros: 0, verificationType: "routed", verificationStatus: "confirmed", economicStatus: "eligible", rewardStatus: "eligible", rewardHold: false, eligibleComputeMicros: 1234, protocolComputeMicros: 1234 } as unknown as NormalizedUsageRecord;
    const scores = ["openrouter", "openai", "anthropic", "google", "mistral", "xai", "vercel-ai-gateway"].map((provider) => scoreRecords([{ ...base, provider }], SCORING_VERSION_V2_DRAFT).points);
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// §18 pre-settlement invariants
// ---------------------------------------------------------------------------

describe("v2 pre-settlement invariants", () => {
  const participants = [{ userId: "a", eligiblePico: usd(300) }, { userId: "b", eligiblePico: usd(200) }, { userId: "c", eligiblePico: usd(1) / 3n }, { userId: "zero", eligiblePico: 0n }];
  const plan = planV2Settlement(participants);

  it("a healthy context passes every invariant", () => {
    expect(() => assertV2Invariants(plan, healthyContext(plan))).not.toThrow();
  });

  it("allocation sums exactly to the effective pool, effective ≤ cap, undistributed is the remainder and is never allocated", () => {
    expect(plan.ledgerDelta).toBe(plan.effectivePoints);
    expect(plan.effectivePoints).toBeLessThanOrEqual(100_000n);
    expect(plan.effectivePoints + plan.undistributedPoints).toBe(100_000n);
    expect(plan.effectivePoints).toBe(effectivePoolBaselineLinear(POOL, plan.networkPico, B));
  });

  it("no allocation to a participant with zero eligible compute", () => {
    expect(plan.allocations.find((a) => a.userId === "zero")).toBeUndefined();
    expect(planV2Settlement([{ userId: "x", eligiblePico: 0n }]).allocations).toEqual([]);
  });

  it("zero participants: nothing is emitted, nothing is undistributed-but-minted", () => {
    const empty = planV2Settlement([]);
    expect(empty.effectivePoints).toBe(0n);
    expect(empty.undistributedPoints).toBe(100_000n);
    expect(empty.ledgerDelta).toBe(0n);
  });

  const failing: [string, Partial<V2SettlementContext>, RegExp][] = [
    ["duplicate economic keys", { duplicateEconomicKeys: 1 }, /uniqueness/],
    ["pricing version not frozen", { pricingVersionStatus: "draft" }, /pricing version/],
    ["scoring version not active", { scoringVersionActive: false }, /scoring version/],
    ["emission version not active", { emissionVersionActive: false }, /emission version/],
    ["epoch bound to other versions", { epochScoringVersion: "usage_score_v1" }, /epoch is bound/],
    ["network pico not deterministic", { recomputedNetworkPico: 1n }, /not deterministic/],
    ["ineligible units present", { ineligibleParticipants: 2 }, /non-eligible/],
    ["ledger already credited", { existingLedgerRowsForEpoch: 1 }, /double credit/],
  ];
  for (const [name, override, pattern] of failing) {
    it(`refuses: ${name}`, () => {
      expect(() => assertV2Invariants(plan, { ...healthyContext(plan), ...override })).toThrow(pattern);
    });
  }

  it("refuses a tampered plan whose allocations do not sum to the effective pool", () => {
    const tampered = { ...plan, allocations: plan.allocations.map((a, i) => (i === 0 ? { ...a, points: a.points + 1n } : a)) };
    tampered.ledgerDelta = tampered.allocations.reduce((s, a) => s + a.points, 0n);
    expect(() => assertV2Invariants(tampered, healthyContext(tampered))).toThrow(/allocations sum/);
  });

  it("is deterministic: the same participants in any order give the same plan", () => {
    const shuffled = planV2Settlement([...participants].reverse());
    expect(shuffled.allocations).toEqual(plan.allocations);
    expect(shuffled.effectivePoints).toBe(plan.effectivePoints);
  });

  it("M14C calibration under v2 (read-only): 500,000 pico alone in an epoch earns 0 points, undistributed 100,000", () => {
    const p = planV2Settlement([{ userId: "da93cec8", eligiblePico: 500_000n }]);
    expect(p.effectivePoints).toBe(0n);
    expect(p.undistributedPoints).toBe(100_000n);
    expect(p.allocations[0].score).toBe(500_000n);
    expect(p.allocations[0].points).toBe(0n);
  });
});
