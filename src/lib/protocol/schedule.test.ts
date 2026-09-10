import { describe, expect, it } from "vitest";
import { CODE_SCHEDULE, pricingForEpoch, protocolForEpoch, protocolStatusView, scheduleFromRows, scoringForEpoch, type ProtocolScheduleEntry } from "./schedule";
import { dailyEpochFor } from "@/lib/domain/epoch";

/**
 * M16A — historical reproduction. Three epochs under three protocols must
 * coexist and resolve identically whenever the code runs.
 */

const BETA_SCHEDULED: ProtocolScheduleEntry = {
  ...CODE_SCHEDULE.find((s) => s.version === "mining-beta-v2")!,
  status: "scheduled",
  effectiveFromEpoch: "epoch-2026-09-14",
};
const SCHEDULE_WITH_CUTOVER = [...CODE_SCHEDULE.filter((s) => s.version !== "mining-beta-v2"), BETA_SCHEDULED];

describe("epoch-aware protocol resolution", () => {
  it("epoch-2026-09-07 → mining-dev-v1 / usage_score_v1 / usage-pricing-v2 / fixed 100,000", () => {
    const p = protocolForEpoch("epoch-2026-09-07");
    expect(p.version).toBe("mining-dev-v1");
    expect(p.scoringVersion).toBe("usage_score_v1");
    expect(p.pricingVersion).toBe("usage-pricing-v2");
    expect(p.emissionAlgorithm).toBe("fixed-pool-v1");
    expect(p.epochEmissionPoints).toBe(100_000);
  });

  it("epoch-2026-09-10 bound to the calibration version → zero reward, v1, v2 pricing", () => {
    const p = protocolForEpoch("epoch-2026-09-10", CODE_SCHEDULE, "mining-dev-calibration-v1");
    expect(p.version).toBe("mining-dev-calibration-v1");
    expect(p.emissionAlgorithm).toBe("zero-reward-calibration-v1");
    expect(p.epochEmissionPoints).toBe(0);
    expect(p.scoringVersion).toBe("usage_score_v1");
    expect(p.pricingVersion).toBe("usage-pricing-v2");
    // Unbound, the same epoch would resolve to the network protocol: binding is what makes history exact.
    expect(protocolForEpoch("epoch-2026-09-10").version).toBe("mining-dev-v1");
  });

  it("a DRAFT never resolves: today's code schedule gives mining-dev-v1 for 2026-09-14 and beyond", () => {
    expect(protocolForEpoch("epoch-2026-09-14").version).toBe("mining-dev-v1");
    expect(protocolForEpoch("epoch-2030-01-01").version).toBe("mining-dev-v1");
  });

  it("with mining-beta-v2 SCHEDULED for epoch-2026-09-14: 09-13 is still v1, 09-14 onward is beta-v2 / v2 / v3 / baseline-linear-v1", () => {
    for (const day of ["2026-09-11", "2026-09-12", "2026-09-13"]) {
      expect(protocolForEpoch(`epoch-${day}`, SCHEDULE_WITH_CUTOVER).version).toBe("mining-dev-v1");
      expect(pricingForEpoch(`epoch-${day}`, SCHEDULE_WITH_CUTOVER)).toBe("usage-pricing-v2");
    }
    const beta = protocolForEpoch("epoch-2026-09-14", SCHEDULE_WITH_CUTOVER);
    expect(beta.version).toBe("mining-beta-v2");
    expect(scoringForEpoch("epoch-2026-09-14", SCHEDULE_WITH_CUTOVER)).toBe("usage_score_v2");
    expect(pricingForEpoch("epoch-2026-09-14", SCHEDULE_WITH_CUTOVER)).toBe("usage-pricing-v3");
    expect(beta.emissionAlgorithm).toBe("baseline-linear-v1");
    expect(beta.baselineComputePico).toBe(1_000_000_000_000_000n);
    expect(protocolForEpoch("epoch-2026-09-15", SCHEDULE_WITH_CUTOVER).version).toBe("mining-beta-v2");
    // History is untouched by the cutover.
    expect(protocolForEpoch("epoch-2026-09-07", SCHEDULE_WITH_CUTOVER).version).toBe("mining-dev-v1");
    expect(protocolForEpoch("epoch-2026-09-10", SCHEDULE_WITH_CUTOVER, "mining-dev-calibration-v1").epochEmissionPoints).toBe(0);
  });

  it("a scheduled cutover is a hard UTC boundary: the second before it belongs to v1", () => {
    const before = dailyEpochFor(new Date("2026-09-13T23:59:59.999Z"), 100_000);
    const after = dailyEpochFor(new Date("2026-09-14T00:00:00.000Z"), 100_000);
    expect(before.id).toBe("epoch-2026-09-13");
    expect(after.id).toBe("epoch-2026-09-14");
    expect(protocolForEpoch(before.id, SCHEDULE_WITH_CUTOVER).version).toBe("mining-dev-v1");
    expect(protocolForEpoch(after.id, SCHEDULE_WITH_CUTOVER).version).toBe("mining-beta-v2");
  });

  it("dailyEpochFor binds today's epoch from the schedule, not from a deploy-time constant", () => {
    const e = dailyEpochFor(new Date("2026-09-12T12:00:00Z"), 100_000);
    expect(e.protocolVersion).toBe("mining-dev-v1");
    expect(e.scoringVersion).toBe("usage_score_v1");
  });

  it("refuses an unknown bound version and a non-epoch id", () => {
    expect(() => protocolForEpoch("epoch-2026-09-10", CODE_SCHEDULE, "mining-nope")).toThrow(/unknown protocol/);
    expect(() => protocolForEpoch("2026-09-10")).toThrow(/not an epoch id/);
  });

  it("builds the same schedule from database rows", () => {
    const rows = scheduleFromRows([
      { version: "mining-dev-v1", status: "active", role: "network", effective_from_epoch: "epoch-2026-09-01", scoring_version: "usage_score_v1", pricing_version: "usage-pricing-v2", epoch_emission_points: "100000", emission_algorithm: "fixed-pool-v1", baseline_compute_pico: null, floor_points: 0, undistributed_policy: "distributed", claimable: false, network: "development" },
      { version: "mining-beta-v2", status: "scheduled", role: "network", effective_from_epoch: "epoch-2026-09-14", scoring_version: "usage_score_v2", pricing_version: "usage-pricing-v3", epoch_emission_points: 100000, emission_algorithm: "baseline-linear-v1", baseline_compute_pico: "1000000000000000", floor_points: "0", undistributed_policy: "never_minted", claimable: false, network: "development" },
    ]);
    expect(protocolForEpoch("epoch-2026-09-13", rows).version).toBe("mining-dev-v1");
    expect(protocolForEpoch("epoch-2026-09-14", rows).baselineComputePico).toBe(1_000_000_000_000_000n);
  });
});

describe("dashboard protocol status copy", () => {
  it("before scheduling: DEVELOPMENT V1 / PREPARING BETA V2", () => {
    const v = protocolStatusView("epoch-2026-09-11");
    expect(v.headline).toBe("DEVELOPMENT V1 / PREPARING BETA V2");
    expect(v.emissionLabel).toMatch(/^100,000 DEVELOPMENT POINTS/);
  });
  it("scheduled: names the UTC target; after cutover: BETA V2, linear, UP TO the cap", () => {
    expect(protocolStatusView("epoch-2026-09-11", SCHEDULE_WITH_CUTOVER).headline).toBe("DEVELOPMENT V1 / BETA V2 SCHEDULED 2026-09-14 00:00 UTC");
    const after = protocolStatusView("epoch-2026-09-14", SCHEDULE_WITH_CUTOVER);
    expect(after.headline).toBe("BETA V2");
    expect(after.scoringLabel).toBe("LINEAR VERIFIED COMPUTE");
    expect(after.emissionLabel).toBe("UP TO 100,000 USAGE POINTS PER UTC EPOCH");
  });
});
