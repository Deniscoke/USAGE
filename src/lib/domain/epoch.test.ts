import { describe, expect, it } from "vitest";
import {
  allocateEpochRewards,
  assertSettleable,
  assignEpoch,
  dailyEpochFor,
  epochDay,
  epochIdForDate,
  EpochLifecycleError,
  estimateReward,
  networkShare,
  type EpochState,
} from "./epoch";

describe("allocateEpochRewards", () => {
  it("splits the pool by share of network score", () => {
    const allocations = allocateEpochRewards(
      [
        { userId: "a", score: 500 },
        { userId: "b", score: 1_500 },
      ],
      100_000,
    );
    expect(allocations.map((a) => a.points)).toEqual([25_000, 75_000]);
  });

  it("never mints or loses points to rounding", () => {
    const participants = Array.from({ length: 7 }, (_, i) => ({ userId: `u${i}`, score: 1 }));
    const allocations = allocateEpochRewards(participants, 100_000);
    expect(allocations.reduce((acc, a) => acc + a.points, 0)).toBe(100_000);
  });

  it("gives nothing to zero-score participants", () => {
    const allocations = allocateEpochRewards(
      [
        { userId: "a", score: 0 },
        { userId: "b", score: 10 },
      ],
      1_000,
    );
    expect(allocations.find((a) => a.userId === "a")?.points).toBe(0);
    expect(allocations.find((a) => a.userId === "b")?.points).toBe(1_000);
  });

  it("distributes nothing when no one scored", () => {
    const allocations = allocateEpochRewards([{ userId: "a", score: 0 }], 1_000);
    expect(allocations[0].points).toBe(0);
  });

  it("is deterministic regardless of participant order", () => {
    const a = allocateEpochRewards(
      [
        { userId: "a", score: 3 },
        { userId: "b", score: 3 },
        { userId: "c", score: 3 },
      ],
      10,
    );
    const b = allocateEpochRewards(
      [
        { userId: "c", score: 3 },
        { userId: "b", score: 3 },
        { userId: "a", score: 3 },
      ],
      10,
    );
    const points = (list: typeof a) =>
      Object.fromEntries(list.map((x) => [x.userId, x.points]));
    expect(points(a)).toEqual(points(b));
  });
});

describe("anti-farm economics", () => {
  it("caps total issuance at the pool no matter how much anyone spends", () => {
    const whale = allocateEpochRewards(
      [
        { userId: "whale", score: 10_000_000 },
        { userId: "normal", score: 100 },
      ],
      100_000,
    );
    expect(whale.reduce((acc, a) => acc + a.points, 0)).toBe(100_000);
  });
});

describe("estimateReward", () => {
  it("previews the epoch payout from a network share", () => {
    const result = estimateReward({ userScore: 500, networkScore: 500_000, rewardPoolPoints: 100_000 });
    expect(result.networkShare).toBeCloseTo(0.001, 9);
    expect(result.points).toBe(100);
  });

  it("returns zero when the network has no scored usage", () => {
    expect(estimateReward({ userScore: 0, networkScore: 0, rewardPoolPoints: 100_000 }).points).toBe(0);
    expect(networkShare(10, 0)).toBe(0);
  });
});

describe("dailyEpochFor", () => {
  it("bounds a UTC day and records the scoring version", () => {
    const epoch = dailyEpochFor(new Date("2026-03-01T13:45:00.000Z"), 100_000);
    expect(epoch.id).toBe("epoch-2026-03-01");
    expect(epoch.startsAt).toBe("2026-03-01T00:00:00.000Z");
    expect(epoch.endsAt).toBe("2026-03-02T00:00:00.000Z");
    expect(epoch.scoringVersion).toBe("usage_score_v1");
  });
});

describe("epoch lifecycle", () => {
  it("starts open, because an epoch only closes by an explicit act", () => {
    expect(dailyEpochFor(new Date("2026-07-01T10:00:00.000Z"), 100).state).toBe("open");
  });

  it("settles only from finalizing", () => {
    expect(() => assertSettleable("epoch-2026-07-01", "finalizing")).not.toThrow();
    // An open epoch is still collecting, so its allocation would be provisional.
    expect(() => assertSettleable("epoch-2026-07-01", "open")).toThrow(EpochLifecycleError);
    // A settled allocation is immutable.
    expect(() => assertSettleable("epoch-2026-07-01", "settled")).toThrow(/already settled/);
  });

  it("names an epoch deterministically from a UTC instant", () => {
    expect(epochIdForDate(new Date("2026-07-01T23:59:59.999Z"))).toBe("epoch-2026-07-01");
    expect(epochIdForDate(new Date("2026-07-02T00:00:00.000Z"))).toBe("epoch-2026-07-02");
    expect(epochDay("epoch-2026-07-02")).toBe("2026-07-02");
  });
});

describe("epoch assignment", () => {
  const openEverywhere = () => "open" as EpochState;

  it("assigns an event to the epoch containing occurred_at", () => {
    const assignment = assignEpoch({
      occurredAt: "2026-07-01T09:00:00.000Z",
      ingestedAt: "2026-07-01T09:00:01.000Z",
      stateOf: openEverywhere,
    });
    expect(assignment).toEqual({
      epochId: "epoch-2026-07-01",
      occurredEpochId: "epoch-2026-07-01",
      carriedForward: false,
    });
  });

  it("still uses occurred_at when the proof arrives on a later day", () => {
    // Late is not the same as too late: the epoch is open, so it takes the work.
    const assignment = assignEpoch({
      occurredAt: "2026-07-01T09:00:00.000Z",
      ingestedAt: "2026-07-03T09:00:00.000Z",
      stateOf: openEverywhere,
    });
    expect(assignment.epochId).toBe("epoch-2026-07-01");
    expect(assignment.carriedForward).toBe(false);
  });

  it("carries forward when the occurrence epoch has stopped accepting usage", () => {
    const closed = new Set(["epoch-2026-07-01"]);
    const assignment = assignEpoch({
      occurredAt: "2026-07-01T23:00:00.000Z",
      ingestedAt: "2026-07-02T00:30:00.000Z",
      stateOf: (id) => (closed.has(id) ? "finalizing" : "open"),
    });
    expect(assignment.epochId).toBe("epoch-2026-07-02");
    expect(assignment.occurredEpochId).toBe("epoch-2026-07-01");
    expect(assignment.carriedForward).toBe(true);
  });

  it("skips past every closed epoch rather than discarding the compute", () => {
    const closed = new Set(["epoch-2026-07-01", "epoch-2026-07-02", "epoch-2026-07-03"]);
    const assignment = assignEpoch({
      occurredAt: "2026-07-01T12:00:00.000Z",
      ingestedAt: "2026-07-02T12:00:00.000Z",
      stateOf: (id) => (closed.has(id) ? "settled" : "open"),
    });
    expect(assignment.epochId).toBe("epoch-2026-07-04");
    expect(assignment.carriedForward).toBe(true);
  });

  it("is deterministic: the same inputs always name the same epoch", () => {
    const input = {
      occurredAt: "2026-07-01T23:00:00.000Z",
      ingestedAt: "2026-07-02T00:30:00.000Z",
      stateOf: (id: string) => (id === "epoch-2026-07-01" ? "settled" : "open") as EpochState,
    };
    expect(assignEpoch(input)).toEqual(assignEpoch(input));
  });
});
