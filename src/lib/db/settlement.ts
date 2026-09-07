import { allocateEpochRewards, type EpochParticipant, type RewardEpoch } from "@/lib/domain/epoch";

/**
 * Epoch settlement.
 *
 * A fixed pool of Usage Points is divided by share of network score. Extra
 * compute cannot mint extra points; it only dilutes everyone, which is what
 * makes burning tokens to farm rewards structurally pointless rather than
 * merely discouraged.
 *
 * Settlement is idempotent by construction: an allocation id is
 * `<epoch>:<user>`, and the ledger has a unique index on it. Running settlement
 * twice credits nothing the second time, however many times it is retried.
 *
 * Usage Points are an off-chain protocol accounting unit. Not money, not a
 * security, not a claim on any future token.
 */

export interface SettlementStore {
  /** Daily scores for the epoch, by user. */
  loadEpochScores(day: string, algorithmVersion: string): Promise<EpochParticipant[]>;
  upsertEpoch(epoch: RewardEpoch, networkScore: number, epochKind: string): Promise<void>;
  /** Writes allocations and ledger entries. Must ignore an allocation id it already has. */
  creditAllocations(
    epochId: string,
    entries: readonly {
      allocationId: string;
      userId: string;
      score: number;
      networkShare: number;
      points: number;
    }[],
  ): Promise<number>;
  /** Marks the scored events as counted, so they cannot be settled into another epoch. */
  markSettled(day: string, userIds: readonly string[]): Promise<void>;
}

export interface SettlementResult {
  epochId: string;
  participants: number;
  networkScore: number;
  pool: number;
  distributed: number;
  credited: number;
  allocations: { userId: string; points: number; networkShare: number }[];
}

export function allocationId(epochId: string, userId: string): string {
  return `${epochId}:${userId}`;
}

export async function settleEpoch(
  store: SettlementStore,
  epoch: RewardEpoch,
  options: { algorithmVersion: string; epochKind?: string } = { algorithmVersion: "usage_score_v1" },
): Promise<SettlementResult> {
  const day = epoch.startsAt.slice(0, 10);
  const participants = await store.loadEpochScores(day, options.algorithmVersion);
  const networkScore = participants.reduce((acc, p) => acc + p.score, 0);

  await store.upsertEpoch(epoch, networkScore, options.epochKind ?? "development");

  const allocations = allocateEpochRewards(participants, epoch.rewardPoolPoints);
  const distributed = allocations.reduce((acc, a) => acc + a.points, 0);

  const credited = await store.creditAllocations(
    epoch.id,
    allocations.map((allocation) => ({
      allocationId: allocationId(epoch.id, allocation.userId),
      userId: allocation.userId,
      score: allocation.score,
      networkShare: allocation.networkShare,
      points: allocation.points,
    })),
  );

  await store.markSettled(
    day,
    participants.map((participant) => participant.userId),
  );

  return {
    epochId: epoch.id,
    participants: participants.length,
    networkScore,
    pool: epoch.rewardPoolPoints,
    distributed,
    credited,
    allocations: allocations.map((a) => ({
      userId: a.userId,
      points: a.points,
      networkShare: a.networkShare,
    })),
  };
}
