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
  /**
   * `active` is what production scores new epochs with. `draft` exists in
   * the registry so it can be simulated, tested and previewed, and MUST NOT
   * be selected for production scoring until an owner activates it.
   */
  status: "active" | "draft";
  /** What one point means, so a number is never read without its unit. */
  unit: string;
  weights: Readonly<Record<VerificationType, number>>;
  /** Score a single day's already trust-weighted spend. */
  pointsForWeightedMicros(weightedCostMicros: number): number;
}

const V1: ScoringAlgorithm = {
  version: CURRENT_SCORING_VERSION,
  status: "active",
  unit: "1000 × sqrt(daily eligible protocol USD), 4 decimals",
  weights: VERIFICATION_WEIGHTS_V1,
  pointsForWeightedMicros(weightedCostMicros) {
    if (weightedCostMicros <= 0) return 0;
    const points = Math.sqrt(microsToUsd(weightedCostMicros)) * SCORE_SCALE_V1;
    return roundPoints(points);
  },
};

/**
 * usage_score_v2 — LINEAR. DRAFT (M15B). NOT ACTIVE.
 *
 * score = Σ eligible protocol compute, in integer micro-USD, per account per
 * epoch. No sqrt, no log, no power, no cap of any kind. M15 showed that every
 * strictly concave per-account transformation pays a Sybil bonus equal to its
 * whale dampening (n·f(C/n) > f(C) for any n by Jensen), and that USAGE has
 * no provable principal to aggregate across for most compute. Linear is the
 * only function under which the number of accounts, devices, connections,
 * keys, models, requests and days an actor uses is irrelevant to the reward.
 *
 * Unit: eligible protocol micro-USD. Integer in, integer out. The exact form
 * (pico-USD, BigInt, see src/lib/pricing/exact.ts) needs a column production
 * does not have; until then the score is exact to the per-request micro
 * rounding of the pricing version that priced each event.
 *
 * Accepted trade-off, recorded by the owner in M15B: whales receive
 * proportional influence.
 */
export const SCORING_VERSION_V2_DRAFT = "usage_score_v2";

const V2_DRAFT: ScoringAlgorithm = {
  version: SCORING_VERSION_V2_DRAFT,
  status: "draft",
  unit: "eligible protocol micro-USD (integer)",
  weights: VERIFICATION_WEIGHTS_V1,
  pointsForWeightedMicros(weightedCostMicros) {
    if (!Number.isSafeInteger(weightedCostMicros)) throw new Error(`usage_score_v2 needs an integer micro-USD amount, got ${weightedCostMicros}`);
    return weightedCostMicros <= 0 ? 0 : weightedCostMicros;
  },
};

const ALGORITHMS: Readonly<Record<string, ScoringAlgorithm>> = Object.freeze({
  [V1.version]: V1,
  [V2_DRAFT.version]: V2_DRAFT,
});

/** Draft algorithms may be simulated and previewed, never used to settle. */
export function isActiveScoringVersion(version: string): boolean {
  return ALGORITHMS[version]?.status === "active";
}

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

  // The reward policy decides economics; proof status decides truth. A
  // CONFIRMED proof that the policy did not make eligible earns nothing, and
  // keeps its evidence.
  if (record.rewardStatus) return record.rewardStatus === "eligible";

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
    // Mining values ELIGIBLE compute. `eligibleComputeMicros` is the protocol
    // compute value after the reward policy has had its say, so free and held
    // compute contributes nothing without any special case here. Records from
    // before the policy existed fall back to what they were scored on.
    const cost =
      record.eligibleComputeMicros ??
      record.protocolComputeMicros ??
      record.normalizedCostMicros;
    // What the compute would be worth if it were eligible, for reporting.
    const measured = record.protocolComputeMicros ?? record.normalizedCostMicros;

    if (weight === 0) {
      excluded += measured;
    } else if (!isEconomicallyEligible(record)) {
      // Held and ineligible compute is reported, never scored. Saying "pending"
      // rather than dropping it keeps the number visible to the user.
      pending += measured;
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
