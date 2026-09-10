/**
 * M15C — v2 epoch settlement plan, pure and exact.
 *
 * Owner parameters (2026-09-10), versioned as `mining-beta-v2` (DRAFT):
 *
 *   scoring          usage_score_v2      linear eligible protocol compute
 *   scheduled cap    100,000 points per UTC epoch
 *   emission         baseline-linear-v1  effective = scheduled × min(1, N / B)
 *   baseline B       $1,000 per day = 1,000,000,000 micro = 10^15 pico
 *   floor F          0
 *   undistributed    never minted
 *
 * Everything is BigInt. Compute is in PICO-USD (10^-12 USD): one token at a
 * price of p micro-USD per million tokens is exactly p pico. Points are
 * whole integers; the effective pool floors; allocations use largest
 * remainder so they sum to the effective pool exactly.
 *
 * This is a beta emission parameter. It is not a token price, not a
 * conversion rate, and not a promise about any future token.
 *
 * Nothing here is wired into production settlement.
 */

export const PICO_PER_MICRO = 1_000_000n;
export const PICO_PER_USD = 1_000_000_000_000n;

export interface EmissionPolicyV2 {
  version: "mining-beta-v2";
  scoringVersion: "usage_score_v2";
  pricingVersion: "usage-pricing-v3";
  emissionAlgorithm: "baseline-linear-v1";
  scheduledPoolPoints: bigint;
  baselineComputePico: bigint;
  floorPoints: 0n;
  undistributedPolicy: "never_minted";
}

export const MINING_BETA_V2_PARAMETERS: EmissionPolicyV2 = Object.freeze({
  version: "mining-beta-v2",
  scoringVersion: "usage_score_v2",
  pricingVersion: "usage-pricing-v3",
  emissionAlgorithm: "baseline-linear-v1",
  scheduledPoolPoints: 100_000n,
  baselineComputePico: 1_000n * PICO_PER_USD,
  floorPoints: 0n,
  undistributedPolicy: "never_minted",
});

/**
 * baseline-linear-v1:  effective = floor( scheduled × min(N, B) / B )
 *
 * Exact in BigInt. Zero when N = 0. Reaches `scheduled` exactly at N = B and
 * stays there. Points per protocol dollar are therefore at most
 * scheduled / B_usd = 100,000 / 1,000 = 100 for every N ≤ B, and fall as
 * scheduled / N_usd above it.
 */
export function effectivePoolBaselineLinear(scheduledPoints: bigint, networkPico: bigint, baselinePico: bigint): bigint {
  if (scheduledPoints < 0n || networkPico < 0n) throw new Error("negative input");
  if (baselinePico <= 0n) throw new Error("baseline must be positive");
  const n = networkPico < baselinePico ? networkPico : baselinePico;
  return (scheduledPoints * n) / baselinePico;
}

export interface V2Participant {
  userId: string;
  /** Σ eligible compute for the epoch, pico-USD. The v2 score IS this number. */
  eligiblePico: bigint;
}

export interface V2Allocation {
  userId: string;
  score: bigint;
  points: bigint;
}

export interface V2SettlementPlan {
  policy: EmissionPolicyV2;
  networkPico: bigint;
  scheduledPoints: bigint;
  effectivePoints: bigint;
  undistributedPoints: bigint;
  allocations: V2Allocation[];
  /** Σ allocation points. Always equals `effectivePoints`. */
  ledgerDelta: bigint;
}

/**
 * Plan one epoch's settlement. Pure; the caller writes nothing until every
 * invariant in `assertV2Invariants` has been checked against the real store.
 */
export function planV2Settlement(participants: readonly V2Participant[], policy: EmissionPolicyV2 = MINING_BETA_V2_PARAMETERS): V2SettlementPlan {
  for (const p of participants) if (p.eligiblePico < 0n) throw new Error(`negative eligible compute for ${p.userId}`);
  const eligible = participants.filter((p) => p.eligiblePico > 0n);
  const networkPico = eligible.reduce((s, p) => s + p.eligiblePico, 0n);
  const effective = effectivePoolBaselineLinear(policy.scheduledPoolPoints, networkPico, policy.baselineComputePico) + policy.floorPoints;

  // Largest remainder, exact: floor(effective × score / network), then hand
  // the leftover points one each to the largest remainders (ties by userId).
  const rows = eligible.map((p) => {
    const exactNumerator = effective * p.eligiblePico;
    const floor = networkPico > 0n ? exactNumerator / networkPico : 0n;
    const remainder = networkPico > 0n ? exactNumerator % networkPico : 0n;
    return { userId: p.userId, score: p.eligiblePico, floor, remainder };
  });
  let leftover = effective - rows.reduce((s, r) => s + r.floor, 0n);
  const order = [...rows].sort((a, b) => (a.remainder === b.remainder ? (a.userId < b.userId ? -1 : 1) : a.remainder > b.remainder ? -1 : 1));
  for (const r of order) {
    if (leftover <= 0n) break;
    r.floor += 1n;
    leftover -= 1n;
  }
  const allocations = rows.map((r) => ({ userId: r.userId, score: r.score, points: r.floor })).sort((a, b) => (a.userId < b.userId ? -1 : 1));
  const ledgerDelta = allocations.reduce((s, a) => s + a.points, 0n);
  return { policy, networkPico, scheduledPoints: policy.scheduledPoolPoints, effectivePoints: effective, undistributedPoints: policy.scheduledPoolPoints - effective, allocations, ledgerDelta };
}

/**
 * Pre-settlement invariants (M15C §18). Every one must hold before a v2
 * epoch may write a single ledger row. `context` carries the facts only the
 * store can assert; the plan carries the arithmetic.
 */
export interface V2SettlementContext {
  /** 0018: rows with dedupe_status = unique per economic_event_key, must be 1:1. */
  duplicateEconomicKeys: number;
  pricingVersionStatus: "frozen" | "active" | "draft" | "missing";
  scoringVersionActive: boolean;
  emissionVersionActive: boolean;
  /** The epoch row's bound versions. */
  epochScoringVersion: string | null;
  epochPricingVersion: string | null;
  epochEmissionVersion: string | null;
  /** Σ eligible pico recomputed independently from the events (not from score rows). */
  recomputedNetworkPico: bigint;
  /** Ledger rows already present for this epoch. Must be 0 before the first credit. */
  existingLedgerRowsForEpoch: number;
  /** Any participant whose eligible units are not `reward_status = eligible`. */
  ineligibleParticipants: number;
}

export function assertV2Invariants(plan: V2SettlementPlan, ctx: V2SettlementContext): void {
  const failures: string[] = [];
  if (ctx.duplicateEconomicKeys !== 0) failures.push(`economic identity uniqueness: ${ctx.duplicateEconomicKeys} duplicate keys`);
  if (ctx.pricingVersionStatus !== "frozen" && ctx.pricingVersionStatus !== "active") failures.push(`pricing version ${plan.policy.pricingVersion} is ${ctx.pricingVersionStatus}, not frozen/active`);
  if (!ctx.scoringVersionActive) failures.push(`scoring version ${plan.policy.scoringVersion} is not active`);
  if (!ctx.emissionVersionActive) failures.push(`emission version ${plan.policy.version} is not active`);
  if (ctx.epochScoringVersion !== plan.policy.scoringVersion || ctx.epochPricingVersion !== plan.policy.pricingVersion || ctx.epochEmissionVersion !== plan.policy.version) {
    failures.push(`epoch is bound to (${ctx.epochScoringVersion}, ${ctx.epochPricingVersion}, ${ctx.epochEmissionVersion}), plan is (${plan.policy.scoringVersion}, ${plan.policy.pricingVersion}, ${plan.policy.version})`);
  }
  if (ctx.recomputedNetworkPico !== plan.networkPico) failures.push(`network eligible pico not deterministic: plan ${plan.networkPico}, recomputed ${ctx.recomputedNetworkPico}`);
  const expectedEffective = effectivePoolBaselineLinear(plan.policy.scheduledPoolPoints, plan.networkPico, plan.policy.baselineComputePico) + plan.policy.floorPoints;
  if (plan.effectivePoints !== expectedEffective) failures.push(`effective pool not deterministic: ${plan.effectivePoints} vs ${expectedEffective}`);
  if (plan.ledgerDelta !== plan.effectivePoints) failures.push(`allocations sum to ${plan.ledgerDelta}, effective pool is ${plan.effectivePoints}`);
  if (plan.effectivePoints > plan.policy.scheduledPoolPoints) failures.push(`effective pool ${plan.effectivePoints} exceeds scheduled cap ${plan.policy.scheduledPoolPoints}`);
  if (plan.undistributedPoints + plan.ledgerDelta !== plan.policy.scheduledPoolPoints) failures.push("undistributed + distributed must equal the schedule");
  if (plan.allocations.some((a) => a.points > 0n && a.score <= 0n)) failures.push("allocation to a participant with no eligible compute");
  if (ctx.ineligibleParticipants !== 0) failures.push(`${ctx.ineligibleParticipants} participants carry non-eligible units`);
  if (ctx.existingLedgerRowsForEpoch !== 0) failures.push(`ledger already has ${ctx.existingLedgerRowsForEpoch} rows for this epoch (double credit)`);
  if (failures.length > 0) throw new Error(`v2 settlement invariants failed:\n  - ${failures.join("\n  - ")}`);
}

/** Non-binding UI preview: effective pool with 4 fractional digits, never stored. */
export function previewEffectivePoolFractional(networkPico: bigint, policy: EmissionPolicyV2 = MINING_BETA_V2_PARAMETERS): string {
  const n = networkPico < policy.baselineComputePico ? networkPico : policy.baselineComputePico;
  const scaled = (policy.scheduledPoolPoints * n * 10_000n) / policy.baselineComputePico;
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}
