import { describe, expect, it } from "vitest";
import { buildDashboardView, dashboardSinceDay, HISTORY_DAYS } from "./dashboard";
import { MICROS_PER_USD } from "@/lib/domain/money";
import type { DailyAggregate } from "@/lib/domain/types";
import type { StoredDailyScore } from "@/lib/db/rows";

const NOW = new Date("2026-03-15T12:00:00.000Z");

function aggregate(overrides: Partial<DailyAggregate>): DailyAggregate {
  return {
    day: "2026-03-15",
    provider: "demo-provider",
    model: "demo-large",
    verificationType: "verified",
    requests: 10,
    inputTokens: 1_000,
    cachedInputTokens: 500,
    outputTokens: 200,
    costMicros: 4 * MICROS_PER_USD,
    ...overrides,
  };
}

function score(overrides: Partial<StoredDailyScore>): StoredDailyScore {
  return {
    day: "2026-03-15",
    algorithmVersion: "usage_score_v1",
    weightedCostMicros: 4 * MICROS_PER_USD,
    excludedCostMicros: 0,
    pendingCostMicros: 0,
    points: 2_000,
    ...overrides,
  };
}

const EMPTY = { aggregates: [], scores: [], recentEvents: [], connections: [], now: NOW };

describe("buildDashboardView", () => {
  it("reports an empty account without inventing usage", () => {
    const view = buildDashboardView(EMPTY);
    expect(view.isEmpty).toBe(true);
    expect(view.containsDemoData).toBe(false);
    expect(view.today.costMicros).toBe(0);
    expect(view.scoring.totalPoints).toBe(0);
    expect(view.epoch.estimatedPoints).toBe(0);
  });

  it("derives today, month and window totals from stored aggregates", () => {
    const view = buildDashboardView({
      ...EMPTY,
      aggregates: [
        aggregate({ day: "2026-03-15", costMicros: 4 * MICROS_PER_USD }),
        aggregate({ day: "2026-03-02", costMicros: 6 * MICROS_PER_USD }),
        aggregate({ day: "2026-02-20", costMicros: 5 * MICROS_PER_USD }),
      ],
    });

    expect(view.today.costMicros).toBe(4 * MICROS_PER_USD);
    expect(view.monthToDate.costMicros).toBe(10 * MICROS_PER_USD);
    expect(view.window.costMicros).toBe(15 * MICROS_PER_USD);
    expect(view.today.requests).toBe(10);
  });

  it("splits cost by verification level and keeps all three present", () => {
    const view = buildDashboardView({
      ...EMPTY,
      aggregates: [
        aggregate({ verificationType: "verified", costMicros: 3 * MICROS_PER_USD }),
        aggregate({ verificationType: "reported", provider: "demo-cli", costMicros: 7 * MICROS_PER_USD }),
      ],
    });

    expect(view.byVerification.verified.costMicros).toBe(3 * MICROS_PER_USD);
    expect(view.byVerification.reported.costMicros).toBe(7 * MICROS_PER_USD);
    expect(view.byVerification.routed.costMicros).toBe(0);
  });

  it("builds a per-day series joining aggregates to stored scores", () => {
    const view = buildDashboardView({
      ...EMPTY,
      aggregates: [
        aggregate({ day: "2026-03-14", verificationType: "routed", costMicros: 1 * MICROS_PER_USD }),
        aggregate({ day: "2026-03-15", costMicros: 4 * MICROS_PER_USD }),
      ],
      scores: [score({ day: "2026-03-14", points: 1_000 }), score({ day: "2026-03-15" })],
    });

    expect(view.series).toEqual([
      { day: "2026-03-14", verifiedMicros: 0, routedMicros: 1 * MICROS_PER_USD, reportedMicros: 0, points: 1_000 },
      { day: "2026-03-15", verifiedMicros: 4 * MICROS_PER_USD, routedMicros: 0, reportedMicros: 0, points: 2_000 },
    ]);
    expect(view.scoring.totalPoints).toBe(3_000);
    expect(view.scoring.scoredDays).toBe(2);
  });

  it("uses today's stored score and the real network denominator", () => {
    const view = buildDashboardView({
      ...EMPTY,
      aggregates: [aggregate({})],
      scores: [score({ points: 2_000, excludedCostMicros: 9 * MICROS_PER_USD })],
      // Other real participants. Never invented: with none, the share is 100%.
      otherParticipantsScore: 6_000,
    });

    expect(view.epoch.userScore).toBe(2_000);
    expect(view.epoch.networkScore).toBe(8_000);
    expect(view.epoch.networkShare).toBeCloseTo(2_000 / view.epoch.networkScore, 12);
    expect(view.epoch.estimatedPoints).toBe(
      Math.floor(view.epoch.networkShare * view.epoch.definition.rewardPoolPoints),
    );
    expect(view.epoch.excludedCostMicros).toBe(9 * MICROS_PER_USD);
  });

  it("ignores a stale score for a day the user has no usage on", () => {
    const view = buildDashboardView({ ...EMPTY, scores: [score({ day: "2026-03-01" })] });
    expect(view.epoch.userScore).toBe(0);
    expect(view.epoch.estimatedPoints).toBe(0);
  });

  it("flags stored demo usage so the UI can label it", () => {
    expect(buildDashboardView({ ...EMPTY, aggregates: [aggregate({})] }).containsDemoData).toBe(true);
    expect(
      buildDashboardView({ ...EMPTY, aggregates: [aggregate({ provider: "acme" })] }).containsDemoData,
    ).toBe(false);
  });

  it("distinguishes demo, fixture and live routed evidence", () => {
    const fixture = buildDashboardView({
      ...EMPTY,
      aggregates: [
        aggregate({ provider: "vercel-ai-gateway", verificationType: "reported", model: "openai/gpt-5.4" }),
      ],
    });
    expect(fixture.containsFixtureEvidence).toBe(true);
    expect(fixture.hasLiveRoutedEvidence).toBe(false);
    expect(fixture.containsDemoData).toBe(false);

    const live = buildDashboardView({
      ...EMPTY,
      aggregates: [
        aggregate({ provider: "vercel-ai-gateway", verificationType: "routed", model: "openai/gpt-5.4" }),
      ],
    });
    expect(live.hasLiveRoutedEvidence).toBe(true);
    expect(live.containsFixtureEvidence).toBe(false);
  });

  it("resolves connection capability from the adapter registry", () => {
    const view = buildDashboardView({
      ...EMPTY,
      connections: [
        {
          id: "c1",
          provider: "demo-cli",
          accountLabel: "demo",
          status: "active",
          method: "routed_mining",
          lastSyncedAt: "2026-03-15T11:00:00.000Z",
          eligibleRoute: false,
        },
      ],
    });

    expect(view.connections[0]).toMatchObject({
      provider: "demo-cli",
      verificationType: "reported",
      costDataAvailable: false,
      isDemo: true,
    });
  });
});

describe("dashboardSinceDay", () => {
  it("looks back exactly the history window", () => {
    expect(dashboardSinceDay(NOW)).toBe(
      new Date(Date.UTC(2026, 2, 15) - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10),
    );
  });
});

describe("estimated versus settled Usage Points", () => {
  it("gives a lone participant the whole emission rather than a fake share", () => {
    // A development network with one miner really is 100% of that network. The
    // honest number is the one that makes the epoch's smallness obvious.
    const alone = buildDashboardView({ ...EMPTY, scores: [score({ points: 5 })] });
    expect(alone.epoch.networkShare).toBe(1);
    expect(alone.epoch.estimatedPoints).toBe(alone.protocol.emissionPoints);
    expect(alone.protocol.network).toBe("development");
  });

  it("treats an unrecorded epoch as open and shows an estimate only", () => {
    const view = buildDashboardView({ ...EMPTY, scores: [score({})] });

    expect(view.epoch.state).toBe("open");
    expect(view.epoch.estimatedPoints).toBeGreaterThan(0);
    // Nothing has been credited: an estimate is a projection, not a balance.
    expect(view.settledPoints).toBe(0);
  });

  it("moves the estimate as usage arrives during an open epoch", () => {
    const network = { otherParticipantsScore: 50_000 };
    const small = buildDashboardView({ ...EMPTY, ...network, scores: [score({ points: 100 })] });
    const large = buildDashboardView({ ...EMPTY, ...network, scores: [score({ points: 10_000 })] });

    expect(large.epoch.estimatedPoints).toBeGreaterThan(small.epoch.estimatedPoints);
    // ...while the permanent balance stays exactly where it was.
    expect(large.settledPoints).toBe(small.settledPoints);
  });

  it("reports the credited balance separately from the estimate", () => {
    const view = buildDashboardView({
      ...EMPTY,
      scores: [score({ points: 2_000 })],
      otherParticipantsScore: 18_000,
      settledPoints: 100_000,
      epochStates: { "epoch-2026-03-15": "settled" },
    });

    expect(view.epoch.state).toBe("settled");
    expect(view.settledPoints).toBe(100_000);
    // The two numbers never merge: an estimate becomes a balance only by
    // settling the epoch that produced it -- and once settled, the epoch has
    // no estimate at all, only its persisted allocation (M16B).
    expect(view.epoch.estimatedPoints).toBe(0);
    expect(view.epoch.settledPoints).toBe(0);
    expect(view.settledPoints).not.toBe(view.epoch.estimatedPoints);
  });
});

describe("settled epochs never show an estimate (M16B)", () => {
  it("a settled zero-reward calibration epoch shows Reward 0 and its bound disposition, never +100,000 estimated", () => {
    const now = new Date("2026-09-10T20:00:00Z");
    const view = buildDashboardView({
      ...EMPTY,
      now,
      scores: [{ day: "2026-09-10", algorithmVersion: "usage_score_v1", weightedCostMicros: 1, excludedCostMicros: 0, pendingCostMicros: 0, points: 1 }],
      epochStates: { "epoch-2026-09-10": "settled" },
      epochRows: [{ id: "epoch-2026-09-10", state: "settled", protocolVersion: "mining-dev-calibration-v1", epochKind: "development" }],
      allocationRows: [{ epochId: "epoch-2026-09-10", points: 0 }],
    });
    expect(view.epoch.state).toBe("settled");
    expect(view.epoch.estimatedPoints).toBe(0);
    expect(view.epoch.settledPoints).toBe(0);
    expect(view.epoch.label).toBe("SETTLED · DEVELOPMENT CALIBRATION");
    expect(view.epoch.boundProtocolVersion).toBe("mining-dev-calibration-v1");
  });

  it("a settled mining-dev-v1 epoch shows its persisted 100,000 development points", () => {
    const now = new Date("2026-09-07T20:00:00Z");
    const view = buildDashboardView({
      ...EMPTY,
      now,
      scores: [{ day: "2026-09-07", algorithmVersion: "usage_score_v1", weightedCostMicros: 13, excludedCostMicros: 0, pendingCostMicros: 0, points: 3.6056 }],
      epochStates: { "epoch-2026-09-07": "settled" },
      epochRows: [{ id: "epoch-2026-09-07", state: "settled", protocolVersion: "mining-dev-v1", epochKind: "development" }],
      allocationRows: [{ epochId: "epoch-2026-09-07", points: 100_000 }],
    });
    expect(view.epoch.settledPoints).toBe(100_000);
    expect(view.epoch.label).toBe("SETTLED · DEVELOPMENT");
    expect(view.epoch.estimatedPoints).toBe(0);
  });

  it("an open epoch shows a moving estimate and no settled reward", () => {
    const now = new Date("2026-09-12T20:00:00Z");
    const view = buildDashboardView({ ...EMPTY, now, scores: [{ day: "2026-09-12", algorithmVersion: "usage_score_v1", weightedCostMicros: 1, excludedCostMicros: 0, pendingCostMicros: 0, points: 1 }] });
    expect(view.epoch.state).toBe("open");
    expect(view.epoch.settledPoints).toBeNull();
    expect(view.epoch.estimatedPoints).toBe(100_000);
    expect(view.epoch.label).toBe("OPEN");
  });
});
