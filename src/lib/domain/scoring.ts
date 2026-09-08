import { microsToUsd } from "./money";
import { utcDay } from "./normalize";
import type { NormalizedUsageRecord, VerificationType } from "./types";

/**
 * Proof of Usage scoring.
 *
 * Two properties matter more than the exact formula:
 *
 * 1. ANTI-FARM. Score is concave (sqrt) over the *daily* weighted spend, not
 *    linear per event. Burning 10x the tokens yields ~3.16x the score, so
 *    deliberately wasting compute is never a winning strategy. Rewards are
 *    additionally capped by a fixed epoch pool (see ./epoch).
 * 2. VERSIONED. Every emitted score carries the algorithm version that produced
 *    it, so v2/v3 can be introduced without rewriting historical rows.
 *
 * This is a replaceable V1, not tokenomics.
 */

export const CURRENT_SCORING_VERSION = "usage_score_v1";

/**
 * Trust weight applied to spend before scoring.
 * `reported` usage is displayed in analytics but carries no economic weight,
 * because USAGE cannot independently verify a local client's claims.
 */
export const VERIFICATION_WEIGHTS_V1: Readonly<Record<VerificationType, number>> = Object.freeze({
  verified: 1,
  routed: 1,
  reported: 0,
});

/** Points per sqrt(USD). Purely a display scale; it cancels out of network share. */
export const SCORE_SCALE_V1 = 1000;

export interface DailyScore {
  day: string;
  algorithmVersion: string;
  /** Trust-weighted spend that fed the score, in micro-USD. */
  weightedCostMicros: number;
  /** Spend excluded because its verification type has zero economic weight. */
  excludedCostMicros: number;
  /**
   * Spend that is otherwise eligible but whose economic weight is not yet
   * established -- unconfirmed evidence, or usage whose cost the provider never
   * reported. Held separately so unknown cost is never silently scored as $0.
   */
  pendingCostMicros: number;
  points: number;
}

export interface ScoringAlgorithm {
  version: string;
  weights: Readonly<Record<VerificationType, number>>;
  /** Score a single day's already trust-weighted spend. */
  pointsForWeightedMicros(weightedCostMicros: number): number;
}

const V1: ScoringAlgorithm = {
  version: CURRENT_SCORING_VERSION,
  weights: VERIFICATION_WEIGHTS_V1,
  pointsForWeightedMicros(weightedCostMicros) {
    if (weightedCostMicros <= 0) return 0;
    const points = Math.sqrt(microsToUsd(weightedCostMicros)) * SCORE_SCALE_V1;
    return roundPoints(points);
  },
};

const ALGORITHMS: Readonly<Record<string, ScoringAlgorithm>> = Object.freeze({
  [V1.version]: V1,
});

export function getScoringAlgorithm(version: string = CURRENT_SCORING_VERSION): ScoringAlgorithm {
  const algorithm = ALGORITHMS[version];
  if (!algorithm) throw new Error(`Unknown scoring algorithm: ${version}`);
  return algorithm;
}

/** Points are kept to 4 decimals so summing many days stays stable. */
function roundPoints(points: number): number {
  return Math.round(points * 10_000) / 10_000;
}

/**
 * Evidence is economically eligible only when it is BOTH of a verification type
 * that carries weight AND confirmed.
 *
 * The status check is what keeps development-only and cost-unknown observations
 * out of the reward pool: they are real usage and are displayed as such, but
 * "we watched this happen on a laptop" and "the provider never told us what it
 * cost" are not grounds for paying anyone.
 */
export function isEconomicallyEligible(record: NormalizedUsageRecord): boolean {
  // A reward hold outranks everything. It is set when this compute might
  // already have been counted from another source, and paying twice is worse
  // than paying late -- so the proof stays valid and the credit waits.
  if (record.rewardHold) return false;

  // Records written since signed issuance carry an explicit economic status.
  // Older ones fall back to the verification status they were stored with.
  if (record.economicStatus) return record.economicStatus === "eligible";
  return record.verificationStatus === "confirmed";
}

/** Score one bucket of records (typically a single UTC day). */
export function scoreRecords(
  records: readonly NormalizedUsageRecord[],
  version: string = CURRENT_SCORING_VERSION,
): Omit<DailyScore, "day"> {
  const algorithm = getScoringAlgorithm(version);

  let weighted = 0;
  let excluded = 0;
  let pending = 0;

  for (const record of records) {
    const weight = algorithm.weights[record.verificationType];
    // Mining values verified compute, so the economic quantity is the protocol
    // compute value. Records from before mining v1 fall back to their stored
    // cost, which is what they were scored on at the time.
    const cost = record.protocolComputeMicros ?? record.normalizedCostMicros;

    if (weight === 0) {
      excluded += cost;
    } else if (!isEconomicallyEligible(record)) {
      pending += cost;
    } else {
      weighted += Math.round(cost * weight);
    }
  }

  return {
    algorithmVersion: algorithm.version,
    weightedCostMicros: weighted,
    excludedCostMicros: excluded,
    pendingCostMicros: pending,
    points: algorithm.pointsForWeightedMicros(weighted),
  };
}

/** Per-UTC-day scores, ascending. Days with no usage are omitted. */
export function scoreDaily(
  records: readonly NormalizedUsageRecord[],
  version: string = CURRENT_SCORING_VERSION,
): DailyScore[] {
  const byDay = new Map<string, NormalizedUsageRecord[]>();
  for (const record of records) {
    const day = utcDay(record.occurredAt);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(record);
    else byDay.set(day, [record]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, dayRecords]) => ({ day, ...scoreRecords(dayRecords, version) }));
}

export function totalPoints(scores: readonly DailyScore[]): number {
  return roundPoints(scores.reduce((acc, s) => acc + s.points, 0));
}
