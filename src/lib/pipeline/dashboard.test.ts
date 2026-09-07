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

  it("uses today's stored score for the epoch estimate and marks the network simulated", () => {
    const view = buildDashboardView({
      ...EMPTY,
      aggregates: [aggregate({})],
      scores: [score({ points: 2_000, excludedCostMicros: 9 * MICROS_PER_USD })],
    });

    expect(view.epoch.userScore).toBe(2_000);
    expect(view.epoch.networkIsSimulated).toBe(true);
    expect(view.epoch.networkScore).toBeGreaterThan(2_000);
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
          lastSyncedAt: "2026-03-15T11:00:00.000Z",
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
