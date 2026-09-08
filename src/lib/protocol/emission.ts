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
export type ProtocolStatus = "active" | "superseded";

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

const VERSIONS: readonly MiningProtocolVersion[] = [MINING_DEV_V1];

export const CURRENT_MINING_PROTOCOL = MINING_DEV_V1;

export function getMiningProtocol(version: string): MiningProtocolVersion | null {
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
