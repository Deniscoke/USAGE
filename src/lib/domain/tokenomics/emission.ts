/**
 * M15B — bootstrap emission design.
 *
 * THE PROBLEM. A fixed 100,000-point pool per daily epoch is distributed in
 * full to whoever is present. With one miner and 1 micro-USD of eligible
 * compute (the real M14C day), that miner receives the entire pool: 10^11
 * points per protocol dollar. The scheduled emission must therefore be a CAP
 * on what an epoch may distribute, not an amount an epoch must distribute.
 *
 * Every candidate below maps (scheduled pool, network eligible compute) to an
 * EFFECTIVE pool, deterministically, in integer arithmetic. Compute is in
 * micro-USD; pools are whole points. Nothing here is wired into settlement.
 *
 * Precedent, not parameters: Filecoin's "baseline minting" unlocks part of the
 * emission as a function of network storage reaching a growing baseline rather
 * than of time alone. The lesson transfers (emission can be utility-linked);
 * its numbers do not.
 */

export interface EmissionInput {
  /** Scheduled (maximum) points for the epoch. */
  scheduledPool: number;
  /** Σ eligible protocol compute across the network for the epoch, micro-USD. */
  networkComputeMicros: number;
}

export interface EmissionCandidate {
  id: "A_fixed" | "B_baseline" | "C_difficulty" | "D_hybrid" | "E_minimum";
  name: string;
  formula: string;
  effectivePool(input: EmissionInput): number;
}

const USD = 1_000_000;

function clampPool(value: number, scheduled: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(scheduled, Math.floor(value));
}

/** A. What production does today: the whole pool, whoever is there. */
export const FIXED_FULL_POOL: EmissionCandidate = {
  id: "A_fixed",
  name: "A fixed full pool",
  formula: "effective = scheduled",
  effectivePool: ({ scheduledPool, networkComputeMicros }) => (networkComputeMicros > 0 ? scheduledPool : 0),
};

/**
 * B. Baseline utilisation. Linear unlock until the network reaches a baseline
 * compute B, then the full pool. Points per protocol dollar are therefore
 * capped at `scheduled / B` for all N ≤ B and fall as `scheduled / N` above it.
 *
 *     effective = scheduled × min(1, N / B)
 *
 * Integer form: floor(scheduled × min(N, B) / B).
 */
export function baselineUtilisation(baselineMicros: number): EmissionCandidate {
  if (!Number.isInteger(baselineMicros) || baselineMicros <= 0) throw new Error("baseline must be a positive integer micro-USD amount");
  return {
    id: "B_baseline",
    name: `B baseline utilisation (B = $${baselineMicros / USD})`,
    formula: "effective = scheduled × min(1, N / B)",
    effectivePool: ({ scheduledPool, networkComputeMicros: n }) => clampPool(Number((BigInt(scheduledPool) * BigInt(Math.min(n, baselineMicros))) / BigInt(baselineMicros)), scheduledPool),
  };
}

/**
 * C. Difficulty / target compute. A smooth saturating unlock: half the pool
 * at the target T, asymptotically the whole pool. Never reaches 100%, so
 * there is no threshold to game, and the marginal unlock per extra dollar
 * falls continuously.
 *
 *     effective = scheduled × N / (N + T)
 *
 * Points per protocol dollar = scheduled / (N + T) ≤ scheduled / T always.
 */
export function difficultyTarget(targetMicros: number): EmissionCandidate {
  if (!Number.isInteger(targetMicros) || targetMicros <= 0) throw new Error("target must be a positive integer micro-USD amount");
  return {
    id: "C_difficulty",
    name: `C difficulty target (T = $${targetMicros / USD})`,
    formula: "effective = scheduled × N / (N + T)",
    effectivePool: ({ scheduledPool, networkComputeMicros: n }) => (n <= 0 ? 0 : clampPool(Number((BigInt(scheduledPool) * BigInt(n)) / BigInt(n + targetMicros)), scheduledPool)),
  };
}

/**
 * D. Hybrid. A small bootstrap floor F that is always emitted when anyone
 * is present (so the first honest miners are not paid zero), plus a
 * baseline-linked unlock of the remainder up to the cap.
 *
 *     effective = F + (scheduled − F) × min(1, N / B)
 *
 * The floor is the bootstrap over-emission, made explicit and bounded: the
 * most a sole tiny miner can ever take from one epoch is F.
 */
export function hybrid(floorPoints: number, baselineMicros: number): EmissionCandidate {
  if (!Number.isInteger(floorPoints) || floorPoints < 0) throw new Error("floor must be a non-negative integer");
  const base = baselineUtilisation(baselineMicros);
  return {
    id: "D_hybrid",
    name: `D hybrid (floor ${floorPoints}, B = $${baselineMicros / USD})`,
    formula: "effective = F + (scheduled − F) × min(1, N / B)",
    effectivePool: ({ scheduledPool, networkComputeMicros: n }) => {
      if (n <= 0) return 0;
      const floor = Math.min(floorPoints, scheduledPool);
      return floor + base.effectivePool({ scheduledPool: scheduledPool - floor, networkComputeMicros: n });
    },
  };
}

/**
 * E. No emission below minimum activity, baseline above it. The epoch closes
 * with zero distribution when N < M. The step at M is a threshold an attacker
 * can aim for, which is why E is documented and not recommended alone.
 *
 *     effective = 0            if N < M
 *               = B(N)         otherwise
 */
export function minimumActivity(minimumMicros: number, baselineMicros: number): EmissionCandidate {
  const base = baselineUtilisation(baselineMicros);
  return {
    id: "E_minimum",
    name: `E minimum activity (M = $${minimumMicros / USD}, B = $${baselineMicros / USD})`,
    formula: "effective = N < M ? 0 : scheduled × min(1, N / B)",
    effectivePool: (input) => (input.networkComputeMicros < minimumMicros ? 0 : base.effectivePool(input)),
  };
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export interface EpochEconomics {
  networkComputeMicros: number;
  effectivePool: number;
  undistributed: number;
  /** Points per protocol USD. Infinity when N = 0 and pool > 0 (cannot happen under any candidate). */
  pointsPerUsd: number;
  /** Hypothetical value per point at which one protocol dollar of compute is exactly recovered. Normalised, not a price. */
  breakEvenValuePerPoint: number;
}

export function epochEconomics(candidate: EmissionCandidate, scheduledPool: number, networkComputeMicros: number): EpochEconomics {
  const effectivePool = candidate.effectivePool({ scheduledPool, networkComputeMicros });
  const usd = networkComputeMicros / USD;
  const pointsPerUsd = usd > 0 ? effectivePool / usd : effectivePool > 0 ? Number.POSITIVE_INFINITY : 0;
  return {
    networkComputeMicros,
    effectivePool,
    undistributed: scheduledPool - effectivePool,
    pointsPerUsd,
    breakEvenValuePerPoint: pointsPerUsd > 0 ? 1 / pointsPerUsd : Number.POSITIVE_INFINITY,
  };
}

/**
 * The §9 invariant, made checkable:
 *
 *   For any network state, an actor who contributes c micro-USD of eligible
 *   compute to an epoch receives at most  scheduled × c / B  points, where B
 *   is the candidate's baseline (or target). Equivalently, points per
 *   protocol dollar never exceed scheduled / B, however empty the network.
 *
 * Under linear scoring the actor's points are effective × c / N, so the
 * invariant holds iff effective / N ≤ scheduled / B for all N > 0.
 */
export function maxPointsForContribution(candidate: EmissionCandidate, scheduledPool: number, contributionMicros: number, networkComputeMicros: number): number {
  const n = Math.max(networkComputeMicros, contributionMicros);
  const pool = candidate.effectivePool({ scheduledPool, networkComputeMicros: n });
  return n > 0 ? (pool * contributionMicros) / n : 0;
}

/**
 * Rational farming under linear scoring.
 *
 * Entrants add wash compute while  P × (points per USD) > 1, i.e. while a
 * dollar of compute returns more than a dollar of point value. Given a
 * hypothetical value per point P (normalised sweep, NOT a token price), the
 * equilibrium network compute N* is where P × effective(N*) / N* = 1.
 *
 *   A fixed:      N* = P × scheduled                   (from any N > 0)
 *   B baseline:   N* = P × scheduled  if that ≥ B,     else NO entry (rate capped at scheduled/B < 1/P)
 *   C difficulty: N* = P × scheduled − T  if positive, else NO entry
 *
 * Solved numerically here by bisection so every candidate is treated alike.
 */
export function farmingEquilibrium(candidate: EmissionCandidate, scheduledPool: number, valuePerPoint: number, honestMicros: number): { entry: boolean; equilibriumMicros: number; washMicros: number; pointsPerUsdAtEquilibrium: number } {
  const rate = (n: number) => (n > 0 ? (candidate.effectivePool({ scheduledPool, networkComputeMicros: n }) * USD) / n : 0);
  const start = Math.max(honestMicros, 1);
  // Is a marginal dollar profitable at the current network size?
  if (valuePerPoint * rate(start) <= 1) return { entry: false, equilibriumMicros: honestMicros, washMicros: 0, pointsPerUsdAtEquilibrium: rate(start) };
  let lo = start;
  let hi = Math.max(start * 2, 1);
  while (valuePerPoint * rate(hi) > 1) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1; i += 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (valuePerPoint * rate(mid) > 1) lo = mid;
    else hi = mid;
  }
  return { entry: true, equilibriumMicros: hi, washMicros: hi - honestMicros, pointsPerUsdAtEquilibrium: rate(hi) };
}
