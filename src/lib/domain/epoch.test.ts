import { describe, expect, it } from "vitest";
import { allocateEpochRewards, dailyEpochFor, estimateReward, networkShare } from "./epoch";

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
