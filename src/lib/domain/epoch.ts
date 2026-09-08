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

/**
 * Epoch lifecycle.
 *
 *   OPEN        accepts economic usage; a live score and an ESTIMATE exist,
 *               and nothing may be written to the permanent point ledger.
 *   FINALIZING  no new usage is assigned here; allocations are computed.
 *   SETTLED     allocations are immutable and the ledger has been credited
 *               exactly once.
 *
 * The states exist because an allocation id is `<epoch>:<user>` and the ledger
 * has a unique index on it: crediting is therefore permanent and unrepeatable.
 * Settling an epoch that is still collecting usage would silently strand every
 * proof that arrived afterwards, so settlement is only legal once collection
 * has explicitly stopped.
 */
export type EpochState = "open" | "finalizing" | "settled";

export interface RewardEpoch {
  id: string;
  startsAt: string; // ISO, inclusive
  endsAt: string; // ISO, exclusive
  rewardPoolPoints: number;
  scoringVersion: string;
  state: EpochState;
}

export class EpochLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: "not_open" | "not_finalizing" | "already_settled",
  ) {
    super(message);
    this.name = "EpochLifecycleError";
  }
}

/** Deterministic id of the daily epoch containing `at`, in UTC. */
export function epochIdForDate(at: Date): string {
  return `epoch-${at.toISOString().slice(0, 10)}`;
}

/** The UTC day an epoch id refers to. Inverse of `epochIdForDate`. */
export function epochDay(epochId: string): string {
  return epochId.slice("epoch-".length);
}

/** Only an OPEN epoch may be assigned new economic usage. */
export function acceptsUsage(state: EpochState): boolean {
  return state === "open";
}

/** Only a FINALIZING epoch may be settled. */
export function assertSettleable(epochId: string, state: EpochState): void {
  if (state === "settled") {
    throw new EpochLifecycleError(`${epochId} is already settled.`, "already_settled");
  }
  if (state !== "finalizing") {
    throw new EpochLifecycleError(
      `${epochId} is ${state}; finalize it before settling.`,
      "not_finalizing",
    );
  }
}

export interface EpochAssignment {
  epochId: string;
  /** The epoch the event would have belonged to from its timestamp alone. */
  occurredEpochId: string;
  carriedForward: boolean;
}

/**
 * Assign an event to exactly one epoch.
 *
 * THE RULE (v1), stated once so every implementation agrees:
 *
 *   1. An event belongs to the epoch containing its `occurred_at`.
 *   2. If that epoch is no longer OPEN when the proof is ingested, the event
 *      carries forward to the first OPEN epoch at or after the ingestion
 *      instant, and is marked `carriedForward`.
 *
 * Late compute is therefore never discarded and never retroactively changes a
 * settled allocation. Both are deliberate: silently dropping a valid proof
 * would steal work, and rewriting a settled epoch would break the one guarantee
 * the ledger makes.
 *
 * `stateOf` answers for a given epoch id; an epoch nobody has recorded yet is
 * OPEN, because an epoch only leaves OPEN by an explicit act.
 */
export function assignEpoch(input: {
  occurredAt: string | Date;
  ingestedAt: string | Date;
  stateOf: (epochId: string) => EpochState;
}): EpochAssignment {
  const occurred = new Date(input.occurredAt);
  const ingested = new Date(input.ingestedAt);
  const occurredEpochId = epochIdForDate(occurred);

  if (acceptsUsage(input.stateOf(occurredEpochId))) {
    return { epochId: occurredEpochId, occurredEpochId, carriedForward: false };
  }

  // Walk forward from the ingestion day to the first epoch still accepting
  // usage. Bounded: an unbroken run of closed future epochs is not a state the
  // protocol can produce, and looping forever would be worse than failing.
  const MAX_LOOKAHEAD_DAYS = 400;
  let cursor = new Date(`${ingested.toISOString().slice(0, 10)}T00:00:00.000Z`);
  for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i += 1) {
    const candidate = epochIdForDate(cursor);
    if (acceptsUsage(input.stateOf(candidate))) {
      return { epochId: candidate, occurredEpochId, carriedForward: candidate !== occurredEpochId };
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  throw new EpochLifecycleError(
    `No open epoch found within ${MAX_LOOKAHEAD_DAYS} days of ${ingested.toISOString()}.`,
    "not_open",
  );
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
export function dailyEpochFor(
  at: Date,
  rewardPoolPoints: number,
  state: EpochState = "open",
): RewardEpoch {
  const day = at.toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    id: `epoch-${day}`,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    rewardPoolPoints,
    scoringVersion: CURRENT_SCORING_VERSION,
    state,
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
