import { CURRENT_SCORING_VERSION } from "./scoring";

/**
 * Reward epochs.
 *
 * A fixed pool of USAGE Points is distributed each epoch in proportion to each
 * participant's share of the network's *scored* usage. Because the pool is
 * fixed, extra spend can never mint extra points -- it only dilutes everyone
 * else. This is what makes "burn tokens to farm rewards" structurally
 * unprofitable rather than merely discouraged.
 *
 * USAGE Points are off-chain, non-transferable and carry no monetary value.
 */

export interface RewardEpoch {
  id: string;
  startsAt: string; // ISO, inclusive
  endsAt: string; // ISO, exclusive
  rewardPoolPoints: number;
  scoringVersion: string;
}

export interface EpochParticipant {
  userId: string;
  score: number;
}

export interface EpochAllocation {
  userId: string;
  score: number;
  /** Fraction of network score, 0..1. */
  networkShare: number;
  /** Whole USAGE Points. Allocations always sum to exactly the pool. */
  points: number;
}

/** Daily epoch containing `at`, in UTC. */
export function dailyEpochFor(at: Date, rewardPoolPoints: number): RewardEpoch {
  const day = at.toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    id: `epoch-${day}`,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    rewardPoolPoints,
    scoringVersion: CURRENT_SCORING_VERSION,
  };
}

export function networkShare(userScore: number, networkScore: number): number {
  if (networkScore <= 0 || userScore <= 0) return 0;
  return userScore / networkScore;
}

/** Non-binding preview of what a score would earn, before the epoch closes. */
export function estimateReward(input: {
  userScore: number;
  networkScore: number;
  rewardPoolPoints: number;
}): { networkShare: number; points: number } {
  const share = networkShare(input.userScore, input.networkScore);
  return { networkShare: share, points: Math.floor(share * input.rewardPoolPoints) };
}

/**
 * Settle an epoch. Uses largest-remainder so the integer allocations sum to the
 * pool exactly -- no points are minted or lost to rounding.
 */
export function allocateEpochRewards(
  participants: readonly EpochParticipant[],
  rewardPoolPoints: number,
): EpochAllocation[] {
  const eligible = participants.filter((p) => p.score > 0);
  const networkScore = eligible.reduce((acc, p) => acc + p.score, 0);

  const base = participants.map((p) => {
    const share = networkShare(p.score, networkScore);
    const exact = share * rewardPoolPoints;
    return { participant: p, share, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });

  let remaining = rewardPoolPoints - base.reduce((acc, b) => acc + b.floor, 0);
  if (networkScore <= 0) remaining = 0;

  const order = [...base]
    .filter((b) => b.participant.score > 0)
    .sort(
      (a, b) =>
        b.remainder - a.remainder ||
        b.participant.score - a.participant.score ||
        (a.participant.userId < b.participant.userId ? -1 : 1),
    );

  const bonus = new Set<string>();
  for (const entry of order) {
    if (remaining <= 0) break;
    bonus.add(entry.participant.userId);
    remaining -= 1;
  }

  return base.map((b) => ({
    userId: b.participant.userId,
    score: b.participant.score,
    networkShare: b.share,
    points: b.floor + (bonus.has(b.participant.userId) ? 1 : 0),
  }));
}
