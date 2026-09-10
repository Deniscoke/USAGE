import {
  allocateEpochRewards,
  assertSettleable,
  EpochLifecycleError,
  type EpochParticipant,
  type EpochState,
  type RewardEpoch,
} from "@/lib/domain/epoch";
import { isActiveScoringVersion } from "@/lib/domain/scoring";

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
  /** Null when the epoch has never been recorded, which means it is still open. */
  loadEpochState(epochId: string): Promise<EpochState | null>;
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
  /** Marks the epoch's events as counted, so they cannot be settled into another epoch. */
  markSettled(epochId: string, userIds: readonly string[]): Promise<void>;
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

/**
 * A DRAFT scoring version (usage_score_v2 until an owner activates it) can be
 * simulated and previewed, never settled. This is the guard that makes the
 * registry's `status` mean something at the one place points become permanent.
 */
function assertActiveScoring(version: string): void {
  if (!isActiveScoringVersion(version)) {
    throw new EpochLifecycleError(`${version} is not an active scoring version; it cannot settle an epoch.`, "not_finalizing");
  }
}

export function allocationId(epochId: string, userId: string): string {
  return `${epochId}:${userId}`;
}

/**
 * Stop an epoch collecting usage.
 *
 * The separate phase is the whole point: while an epoch is OPEN a proof can
 * still be assigned to it, so any allocation computed then would be provisional
 * -- but a credited allocation is permanent. Finalizing draws the line, after
 * which late proofs carry forward to the next open epoch instead of silently
 * disappearing into a settled one.
 */
export async function finalizeEpoch(
  store: SettlementStore,
  epoch: RewardEpoch,
  options: { algorithmVersion: string; epochKind?: string } = { algorithmVersion: "usage_score_v1" },
): Promise<{ epochId: string; state: EpochState; networkScore: number }> {
  assertActiveScoring(options.algorithmVersion);
  const state = (await store.loadEpochState(epoch.id)) ?? "open";
  if (state === "settled") {
    throw new EpochLifecycleError(`${epoch.id} is already settled.`, "already_settled");
  }

  const day = epoch.startsAt.slice(0, 10);
  const participants = await store.loadEpochScores(day, options.algorithmVersion);
  const networkScore = participants.reduce((acc, p) => acc + p.score, 0);

  await store.upsertEpoch(
    { ...epoch, state: "finalizing" },
    networkScore,
    options.epochKind ?? "development",
  );
  return { epochId: epoch.id, state: "finalizing", networkScore };
}

/**
 * Settle a FINALIZING epoch into permanent Usage Points.
 *
 * Refuses an OPEN epoch (its usage is still changing) and an already SETTLED
 * one (its allocations are immutable). The ledger's unique allocation id is the
 * second line of defence behind that rule, not a substitute for it.
 */
export async function settleEpoch(
  store: SettlementStore,
  epoch: RewardEpoch,
  options: { algorithmVersion: string; epochKind?: string } = { algorithmVersion: "usage_score_v1" },
): Promise<SettlementResult> {
  assertActiveScoring(options.algorithmVersion);
  assertSettleable(epoch.id, (await store.loadEpochState(epoch.id)) ?? "open");

  const day = epoch.startsAt.slice(0, 10);
  const participants = await store.loadEpochScores(day, options.algorithmVersion);
  const networkScore = participants.reduce((acc, p) => acc + p.score, 0);

  await store.upsertEpoch(
    { ...epoch, state: "settled" },
    networkScore,
    options.epochKind ?? "development",
  );

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
    epoch.id,
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
