import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseSettlementStore } from "./supabase-settlement-store";
import { finalizeEpoch, settleEpoch } from "./settlement";
import { approvedCalibrationClose } from "./calibration-close";
import { dailyEpochFor, EpochLifecycleError } from "@/lib/domain/epoch";
import { isDayComplete, lastCompleteDay } from "@/lib/domain/epoch-day";
import { protocolForEpoch } from "@/lib/protocol/schedule";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Settle one day's epoch, once.
 *
 * One implementation, two callers: the operator script and the scheduled job.
 * They were going to be written twice, and the second copy would have been the
 * one missing a guard.
 *
 * CREDITING THE LEDGER IS PERMANENT, so every refusal below is a refusal to
 * write rather than a warning:
 *
 *   - a day that is not over yet is never settled; usage is still arriving
 *   - an epoch governed by anything but the fixed-pool algorithm is left to
 *     the path that understands it
 *   - an owner-approved calibration epoch is left to its own script, because
 *     settling it here would distribute a pool that is meant to be zero
 *   - an already-settled epoch is refused by the store itself; allocations are
 *     immutable and re-crediting is not a thing this system can do
 *
 * Nothing here decides reward policy. It applies the protocol the epoch was
 * already governed by, which is recorded on the epoch rather than read from
 * today's configuration.
 */

export type SettleOutcome =
  | "settled"
  /** Nothing to do: already settled, or the day has no usage. */
  | "skipped"
  /** Refused on purpose, with a reason a human should read. */
  | "refused";

export interface SettleDailyResult {
  outcome: SettleOutcome;
  epochId: string;
  reason: string;
  participants?: number;
  pool?: number;
  distributed?: number;
  credited?: number;
  protocolVersion?: string;
  allocations?: readonly { userId: string; networkShare: number; points: number }[];
}

export { isDayComplete, lastCompleteDay };

/** What `settle_beta_v2_epoch` returns: one audit row, or a raise. */
interface BetaV2Audit {
  epoch_id: string;
  state: string;
  protocol_version: string;
  scheduled_points: number;
  effective_points: number;
  undistributed_points: number;
  distributed_points: number;
  ledger_points: number;
  participants: number;
}

async function settleThroughDatabase(
  admin: SupabaseClient<Database>,
  epochId: string,
  protocolVersion: string,
): Promise<SettleDailyResult> {
  // The function is declared in a migration, so it is not in the generated
  // database types. Narrowed to exactly what it returns rather than widened to
  // `any`, so a change in its shape is still a type error here.
  const call = admin.rpc as unknown as (
    name: string,
    params: Record<string, string>,
  ) => Promise<{ data: BetaV2Audit[] | BetaV2Audit | null; error: { message: string } | null }>;
  const { data, error } = await call.call(admin, "settle_beta_v2_epoch", { p_epoch_id: epochId });

  if (error) {
    // Every refusal inside that function is deliberate and already rolled
    // back: an epoch that has not ended, a unit that is not exact-pico, a
    // stored score that does not match the recomputed sum. Surfacing the
    // message verbatim is the point -- it names which invariant failed.
    return { outcome: "refused", epochId, protocolVersion, reason: error.message };
  }

  const audit = (Array.isArray(data) ? data[0] : data) as BetaV2Audit | undefined;
  if (!audit) {
    return { outcome: "skipped", epochId, protocolVersion, reason: `${epochId} returned no audit row; nothing was credited.` };
  }

  return {
    outcome: audit.participants === 0 ? "skipped" : "settled",
    epochId,
    protocolVersion: audit.protocol_version ?? protocolVersion,
    reason:
      audit.participants === 0
        ? `${epochId} had no eligible compute; the pool was not minted.`
        : `${epochId} settled for ${audit.participants} participant(s); ${audit.undistributed_points} point(s) were never minted.`,
    participants: Number(audit.participants),
    pool: Number(audit.effective_points),
    distributed: Number(audit.distributed_points),
    credited: Number(audit.ledger_points),
  };
}

export async function settleDailyEpoch(
  admin: SupabaseClient<Database>,
  input: {
    day: string;
    now?: Date;
    /**
     * Allow settling a day that is still in progress.
     *
     * Never set by the scheduled job. Set by the operator script only when a
     * person named the day on the command line, because that is a deliberate
     * act: usage arriving after settlement carries forward to the next open
     * epoch rather than being lost, but it does leave today's epoch closed
     * early, and nobody should do that by accident.
     */
    allowIncompleteDay?: boolean;
  },
): Promise<SettleDailyResult> {
  const { day } = input;
  const now = input.now ?? new Date();
  const epochId = `epoch-${day}`;

  // A day still in progress has usage yet to arrive.
  if (!input.allowIncompleteDay && !isDayComplete(day, now)) {
    return { outcome: "refused", epochId, reason: `${day} is not over yet (UTC); nothing was settled.` };
  }

  // The rule comes from the epoch, not from today's protocol.
  const governing = protocolForEpoch(epochId);

  // baseline-linear-v1 settles inside the database, in one transaction.
  //
  // Not a preference. M15E showed the multi-request path cannot hold the
  // invariants a positive-ledger settlement needs: the effective pool, the
  // largest-remainder allocation and the ledger rows must be computed and
  // written under one lock, or two concurrent runs can each credit a share of
  // the same pool. The function raises and rolls everything back rather than
  // credit anything it cannot prove.
  if (governing.emissionAlgorithm === "baseline-linear-v1") {
    return settleThroughDatabase(admin, epochId, governing.version);
  }

  if (governing.emissionAlgorithm !== "fixed-pool-v1") {
    return {
      outcome: "refused",
      epochId,
      protocolVersion: governing.version,
      reason: `${epochId} is governed by ${governing.version} (${governing.emissionAlgorithm}), which settles through its own path.`,
    };
  }

  if (approvedCalibrationClose(epochId)) {
    return {
      outcome: "refused",
      epochId,
      protocolVersion: governing.version,
      reason: `${epochId} is an owner-approved development calibration epoch and settles at zero through its own script.`,
    };
  }

  const epoch = dailyEpochFor(new Date(`${day}T12:00:00.000Z`), governing.epochEmissionPoints);
  const store = createSupabaseSettlementStore(admin);
  const options = {
    algorithmVersion: governing.scoringVersion,
    // Not a public network yet, and the record says so.
    epochKind: "development",
  };

  try {
    await finalizeEpoch(store, epoch, options);
    const result = await settleEpoch(store, epoch, options);

    // Settlement that does not distribute the pool it opened is unsound, and
    // an unsound settlement must be loud rather than logged.
    if (result.participants > 0 && result.distributed !== result.pool) {
      return {
        outcome: "refused",
        epochId,
        protocolVersion: governing.version,
        reason: `distributed ${result.distributed} of a ${result.pool} point pool; settlement is unsound.`,
        participants: result.participants,
        pool: result.pool,
        distributed: result.distributed,
      };
    }

    return {
      outcome: result.participants === 0 ? "skipped" : "settled",
      epochId,
      protocolVersion: governing.version,
      reason:
        result.participants === 0
          ? `${epochId} had no eligible compute; no points were credited.`
          : `${epochId} settled for ${result.participants} participant(s).`,
      participants: result.participants,
      pool: result.pool,
      distributed: result.distributed,
      credited: result.credited,
      allocations: result.allocations,
    };
  } catch (error) {
    if (error instanceof EpochLifecycleError) {
      // Already settled is the normal case for a job that runs every day and
      // may be retried. It is not an error and must not page anybody.
      return { outcome: "skipped", epochId, protocolVersion: governing.version, reason: error.message };
    }
    throw error;
  }
}
