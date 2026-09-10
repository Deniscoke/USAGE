/**
 * Guarded zero-reward close of an explicitly approved development
 * calibration epoch (M15D).
 *
 * This is NOT a general "settle with pool X" command. The only epochs it can
 * touch are listed in APPROVED_CALIBRATION_CLOSES with the exact facts the
 * owner approved; anything else fails closed before a single read. The close
 * uses the ordinary two-phase settlement (finalize, then settle) under
 * `mining-dev-calibration-v1`, whose emission is zero BY DEFINITION, so the
 * persisted epoch explains itself: scoring usage_score_v1, pricing
 * usage-pricing-v2, protocol mining-dev-calibration-v1, reward 0,
 * claimable false.
 *
 * Requires 0019 (protocol_version binding, claimable flag, the calibration
 * protocol row). Refuses to run against a database that lacks them.
 */
import { finalizeEpoch, settleEpoch, type SettlementStore } from "./settlement";
import { dailyEpochFor, epochDay, type EpochState } from "@/lib/domain/epoch";
import { MINING_DEV_CALIBRATION_V1 } from "@/lib/protocol/emission";

export interface ApprovedCalibrationClose {
  epochId: string;
  /** The one economic unit the epoch holds, as approved. */
  eventId: string;
  economicEventKey: string;
  userId: string;
  eligibleComputeMicros: number;
  /** usage_score_v1 points for that user and day, as recorded. */
  expectedScore: number;
  proofId: string;
}

/** Owner-approved on 2026-09-10 (M15D). Adding an entry is an owner act. */
export const APPROVED_CALIBRATION_CLOSES: readonly ApprovedCalibrationClose[] = Object.freeze([
  {
    epochId: "epoch-2026-09-10",
    eventId: "c75acc2e-7f79-4161-b18f-3d8783561394",
    economicEventKey: "ecu1:cf605dfe61da51020d3e406fba288c137d4b1059268e68064322a44d3a1a2107",
    userId: "da93cec8-8f02-4fc7-b86a-d70be521a19f",
    eligibleComputeMicros: 1,
    expectedScore: 1,
    proofId: "b60f5602-9ea5-4292-a1c8-fda3e874c025",
  },
]);

export function approvedCalibrationClose(epochId: string, approvals: readonly ApprovedCalibrationClose[] = APPROVED_CALIBRATION_CLOSES): ApprovedCalibrationClose | null {
  return approvals.find((entry) => entry.epochId === epochId) ?? null;
}

/** Everything the close must read to prove its preconditions and postconditions. */
export interface CalibrationReadStore {
  loadEvent(eventId: string): Promise<{
    id: string;
    userId: string;
    epochId: string | null;
    economicEventKey: string | null;
    eligibleComputeMicros: number;
    economicStatus: string;
    rewardStatus: string | null;
    protocolPricingVersion: string | null;
  } | null>;
  loadProof(proofId: string): Promise<{ id: string; usageEventId: string; signed: boolean } | null>;
  loadScore(userId: string, day: string, algorithmVersion: string): Promise<number | null>;
  loadEpochRow(epochId: string): Promise<{ state: EpochState; epochKind: string; rewardPoolPoints: number; protocolVersion: string | null; claimable: boolean | null } | null>;
  ledgerStats(): Promise<{ rows: number; total: number }>;
  allocationStats(epochId: string): Promise<{ rows: number; positive: number }>;
  userBalance(userId: string): Promise<number>;
  protocolVersionRow(version: string): Promise<{ status: string; role: string; epochEmissionPoints: number; claimable: boolean } | null>;
}

export interface CalibrationSnapshot {
  event: { id: string; economicEventKey: string | null; eligibleComputeMicros: number; economicStatus: string; pricingVersion: string | null };
  proof: { id: string; signed: boolean };
  score: number | null;
  epoch: { state: EpochState | "unmaterialised"; epochKind: string | null; protocolVersion: string | null; claimable: boolean | null };
  ledger: { rows: number; total: number };
  allocations: { rows: number; positive: number };
  balance: number;
}

export class CalibrationCloseRefused extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`calibration close refused:\n  - ${reasons.join("\n  - ")}`);
    this.name = "CalibrationCloseRefused";
  }
}

export async function snapshotCalibration(reads: CalibrationReadStore, approved: ApprovedCalibrationClose): Promise<CalibrationSnapshot> {
  const event = await reads.loadEvent(approved.eventId);
  const proof = await reads.loadProof(approved.proofId);
  const score = await reads.loadScore(approved.userId, epochDay(approved.epochId), "usage_score_v1");
  const epoch = await reads.loadEpochRow(approved.epochId);
  return {
    event: event ? { id: event.id, economicEventKey: event.economicEventKey, eligibleComputeMicros: event.eligibleComputeMicros, economicStatus: event.economicStatus, pricingVersion: event.protocolPricingVersion } : { id: "missing", economicEventKey: null, eligibleComputeMicros: 0, economicStatus: "missing", pricingVersion: null },
    proof: proof ? { id: proof.id, signed: proof.signed } : { id: "missing", signed: false },
    score,
    epoch: epoch ? { state: epoch.state, epochKind: epoch.epochKind, protocolVersion: epoch.protocolVersion, claimable: epoch.claimable } : { state: "unmaterialised", epochKind: null, protocolVersion: null, claimable: null },
    ledger: await reads.ledgerStats(),
    allocations: await reads.allocationStats(approved.epochId),
    balance: await reads.userBalance(approved.userId),
  };
}

/** Preconditions. Every failure is listed; none is skipped. */
export async function assertCalibrationPreconditions(reads: CalibrationReadStore, approved: ApprovedCalibrationClose, before: CalibrationSnapshot): Promise<void> {
  const reasons: string[] = [];
  const event = await reads.loadEvent(approved.eventId);
  if (!event) reasons.push(`event ${approved.eventId} does not exist`);
  else {
    if (event.userId !== approved.userId) reasons.push("event owner differs from the approved owner");
    if (event.epochId !== approved.epochId) reasons.push(`event is assigned to ${event.epochId}, not ${approved.epochId}`);
    if (event.economicEventKey !== approved.economicEventKey) reasons.push("economic_event_key differs from the approved key");
    if (event.eligibleComputeMicros !== approved.eligibleComputeMicros) reasons.push(`eligible_compute_micros is ${event.eligibleComputeMicros}, approved ${approved.eligibleComputeMicros}`);
    if (event.economicStatus !== "eligible") reasons.push(`event economic_status is ${event.economicStatus}, expected eligible`);
    if (event.rewardStatus !== "eligible") reasons.push(`event reward_status is ${event.rewardStatus}, expected eligible`);
    if (event.protocolPricingVersion !== MINING_DEV_CALIBRATION_V1.pricingVersion) reasons.push(`event priced under ${event.protocolPricingVersion}, calibration version binds ${MINING_DEV_CALIBRATION_V1.pricingVersion}`);
  }
  const proof = await reads.loadProof(approved.proofId);
  if (!proof || proof.usageEventId !== approved.eventId || !proof.signed) reasons.push("approved proof missing, detached, or unsigned");
  if (before.score !== approved.expectedScore) reasons.push(`usage_score_v1 for the day is ${before.score}, approved ${approved.expectedScore}`);
  if (before.epoch.state !== "unmaterialised" && before.epoch.state !== "open" && before.epoch.state !== "finalizing") reasons.push(`epoch is ${before.epoch.state}`);
  if (before.epoch.epochKind !== null && before.epoch.epochKind !== "development") reasons.push(`epoch kind is ${before.epoch.epochKind}, not development`);
  if (before.allocations.positive !== 0) reasons.push("epoch already has a positive allocation");
  const protocol = await reads.protocolVersionRow(MINING_DEV_CALIBRATION_V1.version);
  if (!protocol) reasons.push(`${MINING_DEV_CALIBRATION_V1.version} is not persisted (apply 0019 first)`);
  else {
    if (protocol.role !== "calibration") reasons.push("calibration protocol row has the wrong role");
    if (protocol.epochEmissionPoints !== 0) reasons.push("calibration protocol row does not define zero emission");
    if (protocol.claimable) reasons.push("calibration protocol row is marked claimable");
    if (protocol.status !== "active") reasons.push(`calibration protocol row status is ${protocol.status}`);
  }
  if (reasons.length > 0) throw new CalibrationCloseRefused(reasons);
}

/** Postconditions: the close changed the epoch state and nothing of economic value. */
export function assertCalibrationPostconditions(before: CalibrationSnapshot, after: CalibrationSnapshot, approved: ApprovedCalibrationClose): void {
  const reasons: string[] = [];
  if (after.event.id !== approved.eventId || after.event.economicEventKey !== approved.economicEventKey) reasons.push("event identity changed");
  if (after.event.eligibleComputeMicros !== before.event.eligibleComputeMicros) reasons.push("event economics changed");
  if (after.event.pricingVersion !== before.event.pricingVersion) reasons.push("event pricing version changed");
  if (after.event.economicStatus !== "settled") reasons.push(`event economic_status is ${after.event.economicStatus}, expected settled`);
  if (!after.proof.signed || after.proof.id !== before.proof.id) reasons.push("proof changed");
  if (after.score !== before.score) reasons.push(`score changed from ${before.score} to ${after.score}`);
  if (after.epoch.state !== "settled") reasons.push(`epoch is ${after.epoch.state}, expected settled`);
  if (after.epoch.epochKind !== "development") reasons.push("epoch kind is not development");
  if (after.epoch.protocolVersion !== MINING_DEV_CALIBRATION_V1.version) reasons.push(`epoch bound to ${after.epoch.protocolVersion}`);
  if (after.epoch.claimable !== false) reasons.push("epoch is not marked non-claimable");
  if (after.allocations.positive !== 0) reasons.push(`${after.allocations.positive} positive allocations were created`);
  if (after.ledger.rows !== before.ledger.rows) reasons.push(`ledger rows changed ${before.ledger.rows} → ${after.ledger.rows}`);
  if (after.ledger.total !== before.ledger.total) reasons.push(`ledger total changed ${before.ledger.total} → ${after.ledger.total}`);
  if (after.balance !== before.balance) reasons.push(`settled balance changed ${before.balance} → ${after.balance}`);
  if (reasons.length > 0) throw new CalibrationCloseRefused(reasons);
}

export interface CalibrationCloseResult {
  epochId: string;
  before: CalibrationSnapshot;
  after: CalibrationSnapshot;
  networkScore: number;
  distributed: number;
}

/**
 * The close. Finalize then settle, under the calibration version with a
 * zero pool, bound to the epoch row, marked non-claimable. Refuses anything
 * that is not exactly the approved fact set, before and after.
 */
export async function closeCalibrationEpoch(
  store: SettlementStore,
  reads: CalibrationReadStore,
  epochId: string,
  approvals: readonly ApprovedCalibrationClose[] = APPROVED_CALIBRATION_CLOSES,
): Promise<CalibrationCloseResult> {
  const approved = approvedCalibrationClose(epochId, approvals);
  if (!approved) throw new CalibrationCloseRefused([`${epochId} is not an owner-approved calibration epoch`]);

  const before = await snapshotCalibration(reads, approved);
  await assertCalibrationPreconditions(reads, approved, before);

  const epoch = {
    ...dailyEpochFor(new Date(`${epochDay(approved.epochId)}T12:00:00.000Z`), MINING_DEV_CALIBRATION_V1.epochEmissionPoints),
    scoringVersion: MINING_DEV_CALIBRATION_V1.scoringVersion,
    protocolVersion: MINING_DEV_CALIBRATION_V1.version,
    claimable: false,
  };
  if (epoch.rewardPoolPoints !== 0) throw new CalibrationCloseRefused(["calibration pool is not zero"]);
  const options = { algorithmVersion: MINING_DEV_CALIBRATION_V1.scoringVersion, epochKind: "development" };

  if (before.epoch.state !== "finalizing") await finalizeEpoch(store, epoch, options);
  const result = await settleEpoch(store, epoch, options);
  if (result.distributed !== 0 || result.credited !== 0) throw new CalibrationCloseRefused([`settlement distributed ${result.distributed} and credited ${result.credited}`]);

  const after = await snapshotCalibration(reads, approved);
  assertCalibrationPostconditions(before, after, approved);
  return { epochId, before, after, networkScore: result.networkScore, distributed: result.distributed };
}
