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
  emissionAlgorithm: "fixed-pool-v1" | "baseline-linear-v1";
  baselineComputePico: bigint | null;
  floorPoints: number;
  undistributedPolicy: "distributed" | "never_minted";
}

export const MINING_DEV_V1_EMISSION: EmissionParameters = Object.freeze({
  emissionAlgorithm: "fixed-pool-v1",
  baselineComputePico: null,
  floorPoints: 0,
  undistributedPolicy: "distributed",
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
});

/** Only non-draft versions are listed; the draft is reachable by name for tests and previews. */
const VERSIONS: readonly MiningProtocolVersion[] = [MINING_DEV_V1];

export const CURRENT_MINING_PROTOCOL = MINING_DEV_V1;

export function getMiningProtocol(version: string): MiningProtocolVersion | null {
  return VERSIONS.find((entry) => entry.version === version) ?? (version === MINING_BETA_V2_DRAFT.version ? MINING_BETA_V2_DRAFT : null);
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
