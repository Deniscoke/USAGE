import { CURRENT_SCORING_VERSION } from "@/lib/domain/scoring";
import { CURRENT_PRICING_VERSION } from "@/lib/pricing/compute";

/**
 * Mining protocol configuration.
 *
 * Emission, epoch length, scoring and pricing are one versioned bundle rather
 * than constants scattered through the code. A protocol change is a new
 * version, never an edit -- the same rule that keeps pricing and scoring
 * historically stable.
 *
 * The emission is a FIXED POOL per epoch, and that is the anti-farming property
 * the whole design rests on: extra compute cannot mint extra points, it only
 * dilutes every participant including the one spending. There is deliberately
 * no "tokens per point" rate anywhere in this file, because there must not be
 * one anywhere in the protocol.
 *
 * `development` emission is a development figure. It is not tokenomics, it is
 * not a promise, and it says nothing about any future $USAGE token.
 */

export type ProtocolNetwork = "development" | "production";
/** `draft` exists only in code: the database check constraint (0008) allows active|superseded, so a draft is never inserted. */
export type ProtocolStatus = "active" | "superseded" | "draft";

export interface MiningProtocolVersion {
  version: string;
  /** Seconds. Daily epochs today; the field exists so that can change by version. */
  epochDurationSeconds: number;
  /** Whole Usage Points distributed across all participants, per epoch. */
  epochEmissionPoints: number;
  scoringVersion: string;
  pricingVersion: string;
  effectiveFrom: string;
  network: ProtocolNetwork;
  status: ProtocolStatus;
}

export const MINING_DEV_V1: MiningProtocolVersion = {
  version: "mining-dev-v1",
  epochDurationSeconds: 86_400,
  epochEmissionPoints: 100_000,
  scoringVersion: CURRENT_SCORING_VERSION,
  pricingVersion: CURRENT_PRICING_VERSION,
  effectiveFrom: "2026-09-01",
  network: "development",
  status: "active",
};

/**
 * mining-beta-v2 — DRAFT (M15C). Owner parameters of 2026-09-10.
 *
 * Linear scoring, exact pico pricing, scheduled cap 100,000 points per UTC
 * epoch, emission `baseline-linear-v1`: effective = scheduled × min(1, N/B)
 * with B = $1,000/day, floor 0, undistributed points never minted.
 *
 * NOT ACTIVE. `effectiveFrom` is a placeholder until the owner names the
 * cutover epoch. mining-dev-v1 is not mutated; every v1 epoch remains
 * reproducible under its own recorded versions.
 *
 * This is a beta emission parameter. It is not a token price and not a
 * conversion promise.
 */
export interface EmissionParameters {
  emissionAlgorithm: "fixed-pool-v1" | "baseline-linear-v1" | "zero-reward-calibration-v1";
  baselineComputePico: bigint | null;
  floorPoints: number;
  undistributedPolicy: "distributed" | "never_minted";
  /**
   * `network`: the protocol the network mines under. `calibration`: a
   * disposition applied to one explicitly approved development epoch.
   */
  role: "network" | "calibration";
  /**
   * DEVELOPMENT EPOCHS ARE NOT FUTURE TOKEN CLAIMS. Every development
   * version is `claimable: false`; a future production version may say
   * otherwise only through an owner-approved migration.
   */
  claimable: boolean;
}

export const MINING_DEV_V1_EMISSION: EmissionParameters = Object.freeze({
  emissionAlgorithm: "fixed-pool-v1",
  baselineComputePico: null,
  floorPoints: 0,
  undistributedPolicy: "distributed",
  role: "network",
  claimable: false,
});

/**
 * mining-dev-calibration-v1 — zero-reward development calibration (M15D).
 *
 * The disposition for epoch-2026-09-10: the real M14C unit is scored under
 * usage_score_v1 and priced under usage-pricing-v2 exactly as recorded, the
 * epoch settles, and the emission is ZERO by definition of this version,
 * not by an unexplained override of mining-dev-v1's 100,000-point pool.
 * An auditor reading reward_epochs.protocol_version and this row can
 * reproduce the epoch without source code or prose.
 *
 * DRAFT in code until 0019 inserts the row; role `calibration`, so it is
 * never "the current protocol" and never conflicts with the one active
 * network version.
 */
export const MINING_DEV_CALIBRATION_V1: MiningProtocolVersion & EmissionParameters = Object.freeze({
  version: "mining-dev-calibration-v1",
  epochDurationSeconds: 86_400,
  epochEmissionPoints: 0,
  scoringVersion: "usage_score_v1",
  pricingVersion: "usage-pricing-v2",
  effectiveFrom: "2026-09-10",
  network: "development",
  status: "draft",
  emissionAlgorithm: "zero-reward-calibration-v1",
  baselineComputePico: null,
  floorPoints: 0,
  undistributedPolicy: "never_minted",
  role: "calibration",
  claimable: false,
});

export const MINING_BETA_V2_DRAFT: MiningProtocolVersion & EmissionParameters = Object.freeze({
  version: "mining-beta-v2",
  epochDurationSeconds: 86_400,
  epochEmissionPoints: 100_000,
  scoringVersion: "usage_score_v2",
  pricingVersion: "usage-pricing-v3",
  effectiveFrom: "TBD-owner-cutover-epoch",
  network: "development",
  status: "draft",
  emissionAlgorithm: "baseline-linear-v1",
  baselineComputePico: 1_000_000_000_000_000n,
  floorPoints: 0,
  undistributedPolicy: "never_minted",
  role: "network",
  claimable: false,
});

/** Only non-draft versions are listed; the draft is reachable by name for tests and previews. */
const VERSIONS: readonly MiningProtocolVersion[] = [MINING_DEV_V1];

export const CURRENT_MINING_PROTOCOL = MINING_DEV_V1;

export function getMiningProtocol(version: string): MiningProtocolVersion | null {
  if (version === MINING_BETA_V2_DRAFT.version) return MINING_BETA_V2_DRAFT;
  if (version === MINING_DEV_CALIBRATION_V1.version) return MINING_DEV_CALIBRATION_V1;
  return VERSIONS.find((entry) => entry.version === version) ?? null;
}

export function listMiningProtocols(): readonly MiningProtocolVersion[] {
  return VERSIONS;
}

/** Usage Points emitted per epoch under the active protocol. */
export function epochEmissionPoints(): number {
  return CURRENT_MINING_PROTOCOL.epochEmissionPoints;
}

/** True while the protocol is a development network rather than a public one. */
export function isDevelopmentNetwork(): boolean {
  return CURRENT_MINING_PROTOCOL.network === "development";
}
