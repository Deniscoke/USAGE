import { describe, expect, it } from "vitest";
import { CURRENT_SCORING_VERSION, getScoringAlgorithm, scoreDaily, scoreRecords, totalPoints } from "./scoring";
import { MICROS_PER_USD } from "./money";
import type { NormalizedUsageRecord, VerificationType } from "./types";

function usage(
  verificationType: VerificationType,
  usd: number,
  occurredAt = "2026-03-01T10:00:00.000Z",
  ref = `${verificationType}-${usd}-${occurredAt}`,
): NormalizedUsageRecord {
  return {
    provider: "demo-provider",
    source: "provider_usage_api",
    externalReference: ref,
    model: "demo-large",
    occurredAt,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    requests: 1,
    reportedCostMicros: usd * MICROS_PER_USD,
    normalizedCostMicros: usd * MICROS_PER_USD,
    verificationType,
    verificationStatus: "confirmed",
    rawMetadata: {},
  };
}

describe("verification weighting", () => {
  it("gives verified and routed usage full economic weight", () => {
    expect(scoreRecords([usage("verified", 100)]).points).toBe(10_000);
    expect(scoreRecords([usage("routed", 100)]).points).toBe(10_000);
  });

  it("gives reported usage zero economic weight but keeps it visible", () => {
    const result = scoreRecords([usage("reported", 100)]);
    expect(result.points).toBe(0);
    expect(result.weightedCostMicros).toBe(0);
    expect(result.excludedCostMicros).toBe(100 * MICROS_PER_USD);
  });

  it("does not let reported usage inflate a verified score", () => {
    const verifiedOnly = scoreRecords([usage("verified", 25)]);
    const mixed = scoreRecords([usage("verified", 25), usage("reported", 900)]);
    expect(mixed.points).toBe(verifiedOnly.points);
  });
});

describe("anti-farm shape", () => {
  it("is concave: 10x the spend is far less than 10x the score", () => {
    const small = scoreRecords([usage("verified", 10)]).points;
    const large = scoreRecords([usage("verified", 100)]).points;
    expect(large / small).toBeCloseTo(Math.sqrt(10), 6);
    expect(large).toBeLessThan(small * 10);
  });

  it("cannot be gamed by splitting one day into many small events", () => {
    const oneEvent = scoreRecords([usage("verified", 64)]).points;
    const split = scoreRecords(
      Array.from({ length: 64 }, (_, i) => usage("verified", 1, "2026-03-01T10:00:00.000Z", `r${i}`)),
    ).points;
    expect(split).toBe(oneEvent);
  });
});

describe("versioning", () => {
  it("stamps every score with the algorithm that produced it", () => {
    expect(scoreRecords([usage("verified", 4)]).algorithmVersion).toBe(CURRENT_SCORING_VERSION);
  });

  it("rejects unknown algorithm versions instead of guessing", () => {
    expect(() => getScoringAlgorithm("usage_score_v99")).toThrow();
  });
});

describe("scoreDaily", () => {
  it("scores each UTC day independently and sums to a lifetime total", () => {
    const scores = scoreDaily([
      usage("verified", 4, "2026-03-01T10:00:00.000Z"),
      usage("verified", 5, "2026-03-01T23:30:00.000Z"),
      usage("verified", 9, "2026-03-02T00:30:00.000Z"),
    ]);

    expect(scores.map((s) => s.day)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(scores[0].points).toBe(3_000); // sqrt(9) * 1000
    expect(scores[1].points).toBe(3_000);
    expect(totalPoints(scores)).toBe(6_000);
  });

  it("returns zero points for a day with no economically weighted usage", () => {
    const scores = scoreDaily([usage("reported", 50)]);
    expect(scores[0].points).toBe(0);
  });
});
