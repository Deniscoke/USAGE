import { describe, expect, it } from "vitest";
import {
  CONCAVE,
  LINEAR_RULE,
  V1_RULE,
  actorUnits,
  analyticSplitMultiplier,
  cappedLinear,
  gini,
  honestPopulation,
  kneeSqrt,
  paidFarm,
  principalRule,
  scoreEpoch,
  splitExperiment,
} from "./simulator";
import { getScoringAlgorithm, scoreRecords } from "@/lib/domain/scoring";
import { priceTokens, protocolComputeValue } from "@/lib/pricing/compute";
import type { NormalizedUsageRecord } from "@/lib/domain/types";

/**
 * M15 red team. These tests are written to FAIL v1 where the mathematics
 * says it should. A green suite means the simulator agrees with the
 * closed-form analysis and the candidate rules behave as documented, not
 * that production is safe.
 */

const POOL = 100_000;
const USD = 1_000_000;
const BACKGROUND = honestPopulation(99, 1 * USD, 42);

// ---------------------------------------------------------------------------
// §1 the simulator reproduces production v1 exactly
// ---------------------------------------------------------------------------

describe("the simulator matches production usage_score_v1", () => {
  it("scores one account-day with sqrt(USD) × 1000 to 4 decimals, like scoring.ts", () => {
    const v1 = getScoringAlgorithm("usage_score_v1");
    for (const micros of [1, 500_000, 1 * USD, 2_500_000, 100 * USD]) {
      const out = scoreEpoch(actorUnits({ principalId: "a", computeMicros: micros }), V1_RULE, POOL);
      expect(out.accounts[0].score).toBeCloseTo(v1.pointsForWeightedMicros(micros), 4);
    }
  });

  it("the real M14C unit (1 micro-USD) scores exactly as production recorded: 1.0", () => {
    const out = scoreEpoch(actorUnits({ principalId: "m14c", computeMicros: 1 }), V1_RULE, POOL);
    expect(out.accounts[0].score).toBe(1);
    expect(out.accounts[0].points).toBe(POOL);
  });
});

// ---------------------------------------------------------------------------
// §2 account splitting, closed form and simulated
// ---------------------------------------------------------------------------

describe("§2 account-splitting property of a per-account concave score", () => {
  it("sqrt: n identities holding C/n each score √n times one identity holding C", () => {
    for (const n of [2, 5, 10, 100, 1000]) {
      expect(analyticSplitMultiplier(CONCAVE.sqrt, 100, n)).toBeCloseTo(Math.sqrt(n), 9);
    }
  });

  it("x^α: the multiplier is n^(1-α); linear is 1", () => {
    for (const [name, alpha] of [["pow0.6", 0.6], ["pow0.8", 0.8], ["pow0.9", 0.9]] as const) {
      expect(analyticSplitMultiplier(CONCAVE[name], 50, 100)).toBeCloseTo(Math.pow(100, 1 - alpha), 9);
    }
    expect(analyticSplitMultiplier(CONCAVE.linear, 50, 1000)).toBe(1);
  });

  it("simulated v1 against 99 honest users: splitting $100 into 100 accounts multiplies the attacker's SCORE by ~10", () => {
    const rows = splitExperiment(BACKGROUND, 100 * USD, [2, 5, 10, 100, 1000], V1_RULE, POOL);
    const scoreMultiplier = (n: number) => rows.find((r) => r.n === n)!.attackerScore / 10_000; // sqrt(100)*1000
    expect(scoreMultiplier(2)).toBeCloseTo(Math.sqrt(2), 3);
    expect(scoreMultiplier(10)).toBeCloseTo(Math.sqrt(10), 3);
    expect(scoreMultiplier(100)).toBeCloseTo(10, 3);
    expect(scoreMultiplier(1000)).toBeCloseTo(Math.sqrt(1000), 2);
  });
});

// ---------------------------------------------------------------------------
// §5 request splitting
// ---------------------------------------------------------------------------

describe("§5 request splitting under daily aggregation", () => {
  it("in the simulator: 1 / 10 / 100 / 10,000 requests of the same daily compute score identically", () => {
    const rows = splitExperiment(BACKGROUND, 1 * USD, [10, 100, 10_000], V1_RULE, POOL, "requests");
    for (const r of rows) expect(r.multiplier).toBeCloseTo(1, 6);
  });

  it("in production pricing: per-request half-up rounding to whole micro-USD is the only leak, bounded by 0.5 micro per component per request", () => {
    // gpt-5-nano input is 50,000 micro/M => 0.05 micro per token. 10 tokens
    // are worth 0.5 micro and round UP to 1; 9 tokens round DOWN to 0.
    expect(priceTokens(50_000, 10)).toBe(1);
    expect(priceTokens(50_000, 9)).toBe(0);
    expect(priceTokens(50_000, 100)).toBe(5);
    // 10 requests of 10 tokens => 10 micro; 1 request of 100 tokens => 5 micro.
    const split = Array.from({ length: 10 }, () => priceTokens(50_000, 10)).reduce((a, b) => a + b, 0);
    expect(split).toBe(10);
    expect(split / priceTokens(50_000, 100)).toBe(2);
    // The gain is absolute, not relative: at most 0.5 micro per component per
    // request. Doubling $1 of protocol value this way needs 2,000,000 requests.
    const requestsToGainOneUsd = USD / 0.5;
    expect(requestsToGainOneUsd).toBe(2_000_000);
  });

  it("through the real scoreRecords: eligible records in one day are summed before sqrt, so 100 records = 1 record of the same total", () => {
    const base: NormalizedUsageRecord = {
      id: "x", userId: "u", provider: "openrouter", source: "gateway", externalReference: "e", model: "openai/gpt-5-nano",
      occurredAt: "2026-09-10T10:00:00Z", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 1,
      actualCostMicros: null, normalizedCostMicros: 0, verificationType: "routed", verificationStatus: "confirmed",
      economicStatus: "eligible", rewardStatus: "eligible", rewardHold: false, eligibleComputeMicros: 100, protocolComputeMicros: 100,
    } as unknown as NormalizedUsageRecord;
    const one = scoreRecords([{ ...base, eligibleComputeMicros: 10_000, protocolComputeMicros: 10_000 }]);
    const hundred = scoreRecords(Array.from({ length: 100 }, (_, i) => ({ ...base, id: `x${i}` })));
    expect(hundred.points).toBe(one.points);
  });
});

// ---------------------------------------------------------------------------
// §6 account splitting is the primary attack and v1 fails it
// ---------------------------------------------------------------------------

describe("§6 account splitting under v1 (this MUST fail v1)", () => {
  const rows = splitExperiment(BACKGROUND, 10 * USD, [2, 10, 100, 1000], V1_RULE, POOL);

  it("the attacker's reward rises monotonically with identity count", () => {
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].attackerPoints).toBeGreaterThan(rows[i - 1].attackerPoints);
  });

  it("1000 accounts turn a ~3% share into roughly half the pool ($10 against 99 users spending ~$1 each)", () => {
    const one = scoreEpoch([...BACKGROUND, ...actorUnits({ principalId: "attacker", computeMicros: 10 * USD })], V1_RULE, POOL);
    expect(one.principals.find((p) => p.principalId === "attacker")!.share).toBeLessThan(0.05);
    expect(rows.find((r) => r.n === 1000)!.attackerShare).toBeGreaterThan(0.45);
  });

  it("honest users lose roughly half their reward to it", () => {
    expect(rows.find((r) => r.n === 1000)!.honestDilution).toBeLessThan(0.55);
  });

  it("the invariant (≤ 1% benefit from representation) is VIOLATED by v1", () => {
    expect(rows.find((r) => r.n === 2)!.multiplier).toBeGreaterThan(1.01);
  });
});

// ---------------------------------------------------------------------------
// §7 §8 devices, connections, models: representation only
// ---------------------------------------------------------------------------

describe("§7 §8 device, connection and model splitting", () => {
  for (const dimension of ["devices", "connections"] as const) {
    it(`${dimension}: 1 vs 100 changes nothing under v1 (score keyed by account, not ${dimension})`, () => {
      const rows = splitExperiment(BACKGROUND, 5 * USD, [100], V1_RULE, POOL, dimension);
      expect(rows[0].multiplier).toBe(1);
      expect(rows[0].honestDilution).toBe(1);
    });
  }

  it("models: the same compute across 50 models scores as across 1", () => {
    const one = scoreEpoch([...BACKGROUND, ...actorUnits({ principalId: "a", computeMicros: 5 * USD })], V1_RULE, POOL);
    const many = scoreEpoch([...BACKGROUND, ...actorUnits({ principalId: "a", computeMicros: 5 * USD, models: Array.from({ length: 50 }, (_, i) => `m${i}`), requests: 50 })], V1_RULE, POOL);
    expect(many.principals.find((p) => p.principalId === "a")!.points).toBe(one.principals.find((p) => p.principalId === "a")!.points);
  });

  it("many provider ACCOUNTS owned by one actor but under ONE USAGE account are still one scoring key", () => {
    // Provider account count is not a dimension v1 sees at all: the only way
    // it matters is if it lets the actor open more USAGE accounts (see §6).
    const rows = splitExperiment(BACKGROUND, 5 * USD, [10], V1_RULE, POOL, "connections");
    expect(rows[0].multiplier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §12 day splitting
// ---------------------------------------------------------------------------

describe("§12 day / epoch boundaries", () => {
  it("v1 keys by (account, day): C spread over d days scores √d × C in one day", () => {
    const rows = splitExperiment([], 4 * USD, [2, 4, 16], V1_RULE, POOL, "days");
    // No background, so points are always the whole pool; compare SCORE.
    for (const r of rows) expect(r.attackerScore / 2000).toBeCloseTo(Math.sqrt(r.n), 3);
  });

  it("but each day is its own epoch with its own pool, so the reward effect depends on who else is there", () => {
    // Attacker $4 vs one honest $4/day, either all on day 0 or spread over 4 days.
    const honest = actorUnits({ principalId: "h", computeMicros: 16 * USD, days: 4 });
    const burst = scoreEpoch([...honest, ...actorUnits({ principalId: "a", computeMicros: 4 * USD, days: 1 })], V1_RULE, POOL);
    const spread = scoreEpoch([...honest, ...actorUnits({ principalId: "a", computeMicros: 4 * USD, days: 4 })], V1_RULE, POOL);
    const a = (o: typeof burst) => o.principals.find((p) => p.principalId === "a")!;
    // Spreading wins here: the simulator scores all 4 days into one pool, which
    // is the same as 4 daily pools summed. Ratio bounded by √d = 2.
    expect(a(spread).score / a(burst).score).toBeCloseTo(2, 3);
    expect(a(spread).points).toBeGreaterThan(a(burst).points);
  });
});

// ---------------------------------------------------------------------------
// §18 §19 §20 score families and the invariant
// ---------------------------------------------------------------------------

describe("§18 three families under the account-splitting attack (100 accounts, $10, 99 honest)", () => {
  const cases: [string, ReturnType<typeof principalRule>][] = [
    ["linear", LINEAR_RULE],
    ["account-concave (v1)", V1_RULE],
    ["principal-concave sqrt", principalRule(CONCAVE.sqrt)],
  ];
  for (const [name, rule] of cases) {
    const rows = splitExperiment(BACKGROUND, 10 * USD, [2, 10, 100, 1000], rule, POOL);
    const worst = Math.max(...rows.map((r) => r.multiplier));
    if (name === "account-concave (v1)") {
      it(`${name}: splitting multiplies reward (worst ${worst.toFixed(2)}×)`, () => expect(worst).toBeGreaterThan(5));
    } else {
      it(`${name}: splitting is neutral within rounding (worst ${worst.toFixed(4)}×)`, () => expect(worst).toBeLessThanOrEqual(1.01));
    }
  }
});

describe("§19 concave functions: whale dampening vs splitting multiplier", () => {
  const fns: Record<string, (x: number) => number> = { ...CONCAVE, capped10: cappedLinear(10), knee1: kneeSqrt(1) };
  for (const [name, fn] of Object.entries(fns)) {
    it(`${name}: a 100× whale scores ${fn(100) / fn(1) > 0 ? (fn(100) / fn(1)).toFixed(2) : "0"}× a $1 user; 100-way split ×${analyticSplitMultiplier(fn, 100, 100).toFixed(2)}`, () => {
      const dampening = fn(100) / fn(1);
      const split = analyticSplitMultiplier(fn, 100, 100);
      // The trade-off is exact for power laws: dampening × split == 100.
      if (name.startsWith("pow") || name === "sqrt") expect(dampening * split).toBeCloseTo(100, 6);
      if (name === "linear") expect(split).toBe(1);
      // Every strictly concave function rewards splitting.
      if (name !== "linear") expect(split).toBeGreaterThan(1);
    });
  }
});

describe("§20 the hard invariant, where the principal is identifiable", () => {
  const rule = principalRule(CONCAVE.sqrt);
  for (const dimension of ["accounts", "devices", "connections", "requests"] as const) {
    it(`principal-concave: rearranging across ${dimension} changes reward by ≤ 1%`, () => {
      const rows = splitExperiment(BACKGROUND, 10 * USD, [100], rule, POOL, dimension);
      expect(Math.abs(rows[0].multiplier - 1)).toBeLessThanOrEqual(0.01);
    });
  }

  it("principal-concave still dampens a whale exactly like v1 does for one honest account", () => {
    const whale = scoreEpoch([...BACKGROUND, ...actorUnits({ principalId: "w", computeMicros: 100 * USD })], rule, POOL);
    const v1 = scoreEpoch([...BACKGROUND, ...actorUnits({ principalId: "w", computeMicros: 100 * USD })], V1_RULE, POOL);
    expect(whale.principals.find((p) => p.principalId === "w")!.points).toBe(v1.principals.find((p) => p.principalId === "w")!.points);
  });

  it("where the principal is NOT identifiable, principal-concave degrades to account-concave (an attacker with 100 unlinked accounts = 100 principals)", () => {
    const unlinked = Array.from({ length: 100 }, (_, i) => actorUnits({ principalId: `att${i}`, computeMicros: (10 * USD) / 100 })).flat();
    const linked = actorUnits({ principalId: "att", computeMicros: 10 * USD, accounts: 100 });
    const u = scoreEpoch([...BACKGROUND, ...unlinked], rule, POOL);
    const l = scoreEpoch([...BACKGROUND, ...linked], rule, POOL);
    const unlinkedPoints = u.principals.filter((p) => p.principalId.startsWith("att")).reduce((s, p) => s + p.points, 0);
    expect(unlinkedPoints).toBeGreaterThan(l.principals.find((p) => p.principalId === "att")!.points * 5);
  });
});

// ---------------------------------------------------------------------------
// §9 paid Sybil farm
// ---------------------------------------------------------------------------

describe("§9 paid Sybil farm under v1", () => {
  it("more paid identities lower the break-even value per point: the farm gets cheaper the more it splits", () => {
    const one = paidFarm(BACKGROUND, 1, 10, V1_RULE, POOL);
    const hundred = paidFarm(BACKGROUND, 100, 0.1, V1_RULE, POOL);
    expect(hundred.spendUsd * hundred.identities).toBe(one.spendUsd * one.identities);
    expect(hundred.points).toBeGreaterThan(one.points);
    expect(hundred.breakEvenValuePerPoint).toBeLessThan(one.breakEvenValuePerPoint);
  });

  it("under linear scoring the break-even is independent of identity count", () => {
    const one = paidFarm(BACKGROUND, 1, 10, LINEAR_RULE, POOL);
    const hundred = paidFarm(BACKGROUND, 100, 0.1, LINEAR_RULE, POOL);
    // Largest-remainder rounding over 100 extra accounts moves at most ~0.1% of the pool.
    expect(Math.abs(hundred.points - one.points)).toBeLessThanOrEqual(POOL / 1000);
  });
});

// ---------------------------------------------------------------------------
// §10 §11 pricing arbitrage and cache farming, with the real v2 snapshot
// ---------------------------------------------------------------------------

describe("§10 §11 protocol compute value per token class (usage-pricing-v2)", () => {
  it("cache reads are valued at the cache-read rate, never at fresh input", () => {
    const fresh = protocolComputeValue("usage-pricing-v2", "anthropic/claude-3-haiku", { inputTokens: 1_000_000, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0 })!;
    const cached = protocolComputeValue("usage-pricing-v2", "anthropic/claude-3-haiku", { inputTokens: 0, cachedReadTokens: 1_000_000, cachedWriteTokens: 0, outputTokens: 0 })!;
    expect(cached.micros / fresh.micros).toBeCloseTo(30_000 / 250_000, 6);
  });

  it("a model with no separate cache-read price values cache reads AT the input rate: an overvaluation if the provider bills them cheaper", () => {
    const fresh = protocolComputeValue("usage-pricing-v2", "nvidia/nemotron-3-nano-30b-a3b", { inputTokens: 1_000_000, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0 })!;
    const cached = protocolComputeValue("usage-pricing-v2", "nvidia/nemotron-3-nano-30b-a3b", { inputTokens: 0, cachedReadTokens: 1_000_000, cachedWriteTokens: 0, outputTokens: 0 })!;
    expect(cached.micros).toBe(fresh.micros);
  });

  it("a zero-priced model (ling-3.0-flash) yields zero protocol value however many tokens", () => {
    const v = protocolComputeValue("usage-pricing-v2", "inclusionai/ling-3.0-flash-fin", { inputTokens: 10_000_000, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 10_000_000 })!;
    expect(v.micros).toBe(0);
  });

  it("reasoning tokens add nothing on top of output (rate null → 0)", () => {
    const v = protocolComputeValue("usage-pricing-v2", "openai/gpt-5.4", { inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1000, reasoningTokens: 1000 })!;
    expect(v.components.reasoning).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

describe("gini", () => {
  it("is 0 for equal shares and approaches 1 for one holder", () => {
    expect(gini([1, 1, 1, 1])).toBe(0);
    expect(gini([0, 0, 0, 100])).toBeGreaterThan(0.7);
  });
});
