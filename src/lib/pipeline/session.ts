import { dailyEpochFor, estimateReward, type RewardEpoch } from "@/lib/domain/epoch";
import { EMPTY_TOTALS, addToTotals, utcDay } from "@/lib/domain/normalize";
import { scoreRecords, type DailyScore } from "@/lib/domain/scoring";
import type { NormalizedUsageRecord, UsageTotals } from "@/lib/domain/types";
import { epochEmissionPoints } from "@/lib/protocol/emission";

/**
 * Mining session summary.
 *
 * A read-only view over usage that has already been observed and persisted. It
 * calls the existing scorer and epoch logic -- there is exactly one scoring
 * engine in this system, and a second one calculating "mining" separately would
 * be a bug waiting to happen.
 */

export interface MiningSessionSummary {
  requests: number;
  totals: UsageTotals;
  /**
   * Protocol compute value that actually scores, in micro-USD. This is what the
   * protocol says the verified compute is worth -- NOT what anyone was billed.
   */
  routedCostMicros: number;
  /** Eligible-looking compute whose economic weight is not yet established. */
  pendingCostMicros: number;
  /** Compute with no economic weight at all (reported evidence). */
  excludedCostMicros: number;
  /** Authoritative gateway cost, where the gateway reported one. Analytics only. */
  actualGatewayCostMicros: number;

  miningScore: number;
  scoresByDay: DailyScore[];

  epoch: RewardEpoch;
  /** Total scored points across the network for the epoch. */
  networkScore: number;
  networkShare: number;
  estimatedPoints: number;
}

export function buildMiningSession(
  records: readonly NormalizedUsageRecord[],
  now: Date = new Date(),
  /**
   * Scored points contributed by everyone else in the epoch. Zero is the honest
   * default for a single-participant development network -- inventing a
   * denominator would invent a share.
   */
  otherParticipantsScore = 0,
): MiningSessionSummary {
  const totals = records.reduce<UsageTotals>((acc, record) => addToTotals(acc, record), EMPTY_TOTALS);

  const days = [...new Set(records.map((record) => utcDay(record.occurredAt)))].sort();
  const scoresByDay: DailyScore[] = days.map((day) => ({
    day,
    ...scoreRecords(records.filter((record) => utcDay(record.occurredAt) === day)),
  }));

  const miningScore =
    Math.round(scoresByDay.reduce((acc, score) => acc + score.points, 0) * 10_000) / 10_000;

  const today = utcDay(now.toISOString());
  const todayScore = scoresByDay.find((score) => score.day === today);
  const networkScore = otherParticipantsScore + (todayScore?.points ?? 0);
  const reward = estimateReward({
    userScore: todayScore?.points ?? 0,
    networkScore,
    rewardPoolPoints: epochEmissionPoints(),
  });

  return {
    requests: totals.requests,
    totals,
    actualGatewayCostMicros: records.reduce(
      (acc, record) => acc + (record.actualCostMicros ?? 0),
      0,
    ),
    routedCostMicros: scoresByDay.reduce((acc, score) => acc + score.weightedCostMicros, 0),
    pendingCostMicros: scoresByDay.reduce((acc, score) => acc + score.pendingCostMicros, 0),
    excludedCostMicros: scoresByDay.reduce((acc, score) => acc + score.excludedCostMicros, 0),
    miningScore,
    scoresByDay,
    epoch: dailyEpochFor(now, epochEmissionPoints()),
    networkScore,
    networkShare: reward.networkShare,
    estimatedPoints: reward.points,
  };
}
