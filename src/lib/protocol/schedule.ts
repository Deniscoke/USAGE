/**
 * Epoch-aware protocol resolution (M16A).
 *
 * THE RULE. The economic rule for a unit is selected from the unit's ASSIGNED
 * epoch, never from the wall clock at processing time, the deploy time, the
 * newest version in source, or whichever row happens to look "active". A
 * settled epoch is bound to its protocol version in `reward_epochs.protocol_version`
 * and that binding is authoritative forever; an unbound epoch resolves from
 * the schedule: the network protocol with the latest `effectiveFromEpoch`
 * that is not after the epoch. Drafts never resolve. Historical replay is
 * therefore identical no matter when it runs.
 *
 * Epoch ids are `epoch-YYYY-MM-DD` (UTC), so string order is date order.
 */
import { MINING_BETA_V2_DRAFT, MINING_DEV_CALIBRATION_V1, MINING_DEV_V1, MINING_DEV_V1_EMISSION, type EmissionParameters, type MiningProtocolVersion } from "./emission";

export type ScheduleStatus = "draft" | "scheduled" | "active" | "superseded";

export interface ProtocolScheduleEntry {
  version: string;
  role: "network" | "calibration";
  status: ScheduleStatus;
  /** First epoch this version governs. Null for drafts and for calibration dispositions. */
  effectiveFromEpoch: string | null;
  scoringVersion: string;
  pricingVersion: string;
  epochEmissionPoints: number;
  emissionAlgorithm: EmissionParameters["emissionAlgorithm"];
  baselineComputePico: bigint | null;
  floorPoints: number;
  undistributedPolicy: EmissionParameters["undistributedPolicy"];
  claimable: boolean;
  network: MiningProtocolVersion["network"];
}

function entry(v: MiningProtocolVersion & Partial<EmissionParameters>, effectiveFromEpoch: string | null, status: ScheduleStatus): ProtocolScheduleEntry {
  return {
    version: v.version,
    role: v.role ?? "network",
    status,
    effectiveFromEpoch,
    scoringVersion: v.scoringVersion,
    pricingVersion: v.pricingVersion,
    epochEmissionPoints: v.epochEmissionPoints,
    emissionAlgorithm: v.emissionAlgorithm ?? "fixed-pool-v1",
    baselineComputePico: v.baselineComputePico ?? null,
    floorPoints: v.floorPoints ?? 0,
    undistributedPolicy: v.undistributedPolicy ?? "distributed",
    claimable: v.claimable ?? false,
    network: v.network,
  };
}

/**
 * What the code knows. The database (`mining_protocol_versions`) is the
 * authority at settlement time; this must agree with it, and `verify-0021`
 * checks that it does. mining-beta-v2 stays a DRAFT here until the owner's
 * activation package deploys.
 */
export const CODE_SCHEDULE: readonly ProtocolScheduleEntry[] = Object.freeze([
  entry({ ...MINING_DEV_V1, ...MINING_DEV_V1_EMISSION }, "epoch-2026-09-01", "active"),
  entry(MINING_DEV_CALIBRATION_V1, "epoch-2026-09-10", "active"),
  // From this epoch the network mines under baseline-linear emission: the
  // pool scales with how much verified compute the network actually did, and
  // what is not distributed is never minted. The database resolves the same
  // boundary through protocol_for_epoch(); the two must agree, which is why
  // the migration and this constant are deployed together.
  entry(MINING_BETA_V2_DRAFT, "epoch-2026-09-14", "scheduled"),
]);

export class ProtocolResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolResolutionError";
  }
}

/**
 * Resolve the protocol for an epoch.
 *
 * `boundVersion` is `reward_epochs.protocol_version` when the epoch row
 * exists; it wins outright. Otherwise the latest scheduled/active/superseded
 * NETWORK version whose `effectiveFromEpoch <= epochId`.
 */
export function protocolForEpoch(epochId: string, schedule: readonly ProtocolScheduleEntry[] = CODE_SCHEDULE, boundVersion: string | null = null): ProtocolScheduleEntry {
  if (!/^epoch-\d{4}-\d{2}-\d{2}$/.test(epochId)) throw new ProtocolResolutionError(`not an epoch id: ${epochId}`);
  if (boundVersion) {
    const bound = schedule.find((s) => s.version === boundVersion);
    if (!bound) throw new ProtocolResolutionError(`epoch ${epochId} is bound to unknown protocol ${boundVersion}`);
    return bound;
  }
  const network = schedule
    .filter((s) => s.role === "network" && s.status !== "draft" && s.effectiveFromEpoch !== null)
    .sort((a, b) => (a.effectiveFromEpoch! < b.effectiveFromEpoch! ? -1 : a.effectiveFromEpoch! > b.effectiveFromEpoch! ? 1 : 0));
  if (network.length === 0) throw new ProtocolResolutionError(`no network protocol governs ${epochId}`);
  const governing = network.filter((s) => s.effectiveFromEpoch! <= epochId);
  // Before the genesis protocol's first epoch there was no other rule: the
  // genesis protocol governs all earlier epochs (only fixtures live there).
  return governing.length > 0 ? governing[governing.length - 1] : network[0];
}

export function scoringForEpoch(epochId: string, schedule?: readonly ProtocolScheduleEntry[], boundVersion?: string | null): string {
  return protocolForEpoch(epochId, schedule, boundVersion ?? null).scoringVersion;
}

export function pricingForEpoch(epochId: string, schedule?: readonly ProtocolScheduleEntry[], boundVersion?: string | null): string {
  return protocolForEpoch(epochId, schedule, boundVersion ?? null).pricingVersion;
}

/** The scheduled cap (fixed-pool: the whole pool) for an epoch. */
export function scheduledPoolForEpoch(epochId: string, schedule?: readonly ProtocolScheduleEntry[], boundVersion?: string | null): number {
  return protocolForEpoch(epochId, schedule, boundVersion ?? null).epochEmissionPoints;
}

/** Build a schedule from `mining_protocol_versions` rows (the database's view). */
export function scheduleFromRows(rows: readonly {
  version: string; status: string; role?: string | null; effective_from_epoch?: string | null; effective_from?: string | null; scoring_version: string; pricing_version: string;
  epoch_emission_points: number | string; emission_algorithm?: string | null; baseline_compute_pico?: string | number | null; floor_points?: number | string | null;
  undistributed_policy?: string | null; claimable?: boolean | null; network: string;
}[]): ProtocolScheduleEntry[] {
  return rows.map((r) => ({
    version: r.version,
    role: (r.role ?? "network") as "network" | "calibration",
    status: r.status as ScheduleStatus,
    // Before 0021 the genesis row carries only its effective_from DATE; that
    // date's epoch is its first epoch. 0021 stamps the column explicitly.
    effectiveFromEpoch: r.effective_from_epoch ?? (r.effective_from && r.role !== "calibration" && r.status !== "draft" ? `epoch-${String(r.effective_from).slice(0, 10)}` : null),
    scoringVersion: r.scoring_version,
    pricingVersion: r.pricing_version,
    epochEmissionPoints: Number(r.epoch_emission_points),
    emissionAlgorithm: (r.emission_algorithm ?? "fixed-pool-v1") as EmissionParameters["emissionAlgorithm"],
    baselineComputePico: r.baseline_compute_pico === null || r.baseline_compute_pico === undefined ? null : BigInt(String(r.baseline_compute_pico)),
    floorPoints: Number(r.floor_points ?? 0),
    undistributedPolicy: (r.undistributed_policy ?? "distributed") as EmissionParameters["undistributedPolicy"],
    claimable: Boolean(r.claimable),
    network: r.network as MiningProtocolVersion["network"],
  }));
}

/** Dashboard copy: what governs today, and whether a cutover is scheduled. */
export interface ProtocolStatusView {
  current: ProtocolScheduleEntry;
  next: ProtocolScheduleEntry | null;
  headline: string;
  scoringLabel: string;
  emissionLabel: string;
}

export function protocolStatusView(todayEpochId: string, schedule: readonly ProtocolScheduleEntry[] = CODE_SCHEDULE): ProtocolStatusView {
  const current = protocolForEpoch(todayEpochId, schedule);
  const next = schedule
    .filter((s) => s.role === "network" && s.status === "scheduled" && s.effectiveFromEpoch !== null && s.effectiveFromEpoch > todayEpochId)
    .sort((a, b) => (a.effectiveFromEpoch! < b.effectiveFromEpoch! ? -1 : 1))[0] ?? null;
  const isBeta = current.emissionAlgorithm === "baseline-linear-v1";
  const preparing = schedule.some((s) => s.version === "mining-beta-v2" && (s.status === "draft" || s.status === "scheduled"));
  return {
    current,
    next,
    headline: isBeta ? "BETA V2" : next ? `DEVELOPMENT V1 / BETA V2 SCHEDULED ${next.effectiveFromEpoch!.slice("epoch-".length)} 00:00 UTC` : preparing ? "DEVELOPMENT V1 / PREPARING BETA V2" : "DEVELOPMENT V1",
    scoringLabel: current.scoringVersion === "usage_score_v2" ? "LINEAR VERIFIED COMPUTE" : "CONCAVE (√) DAILY VERIFIED COMPUTE",
    emissionLabel: isBeta ? `UP TO ${current.epochEmissionPoints.toLocaleString("en-US")} USAGE POINTS PER UTC EPOCH` : `${current.epochEmissionPoints.toLocaleString("en-US")} DEVELOPMENT POINTS PER EPOCH`,
  };
}
