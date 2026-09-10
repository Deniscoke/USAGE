/**
 * Close an owner-approved development calibration epoch with ZERO emission.
 *
 *   npm run usage:close-calibration -- --epoch epoch-2026-09-10 --confirm
 *
 * Not a general settlement command. The epoch id must be listed in
 * APPROVED_CALIBRATION_CLOSES with the exact facts the owner approved, the
 * database must carry 0019 (protocol binding, claimable flag, the
 * mining-dev-calibration-v1 row) and 0020 (the atomic close function).
 *
 * Without --confirm: the TypeScript preflight (calibration-close.ts) runs
 * read-only and prints the snapshot and every check.
 *
 * With --confirm: ONE call to the PostgreSQL function
 * close_development_calibration_epoch(p_epoch_id). Every read, lock, write
 * and postcondition happens inside that single transaction; a raise rolls
 * back all of it. The multi-request SettlementStore path is deliberately
 * NOT used for the confirmed operation, because application-side checks
 * cannot undo requests that have already committed. After the RPC returns,
 * an independent read-only audit prints before/after as a second layer.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { CalibrationCloseRefused, approvedCalibrationClose, assertCalibrationPostconditions, assertCalibrationPreconditions, snapshotCalibration, type CalibrationReadStore } from "../src/lib/db/calibration-close";
import { epochDay, type EpochState } from "../src/lib/domain/epoch";

const line = (text = "") => process.stdout.write(`${text}\n`);
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function createReads(admin: ReturnType<typeof createClient<Database>>): CalibrationReadStore {
  // Columns from 0019 are read through untyped selects so this script compiles
  // against the pre-0019 generated types; the close itself refuses to run if
  // the rows it needs are absent.
  const raw = admin as unknown as ReturnType<typeof createClient>;
  type Row = Record<string, unknown>;
  const rows = (data: unknown): Row[] => (data as Row[] | null) ?? [];
  const one = (data: unknown): Row | null => (data as Row | null) ?? null;
  return {
    async loadEvent(eventId) {
      const data = one((await raw.from("usage_events").select("id, user_id, epoch_id, economic_event_key, eligible_compute_micros, economic_status, reward_status, protocol_pricing_version").eq("id", eventId).maybeSingle()).data);
      if (!data) return null;
      return { id: data.id as string, userId: data.user_id as string, epochId: data.epoch_id as string | null, economicEventKey: data.economic_event_key as string | null, eligibleComputeMicros: Number(data.eligible_compute_micros), economicStatus: data.economic_status as string, rewardStatus: data.reward_status as string | null, protocolPricingVersion: data.protocol_pricing_version as string | null };
    },
    async loadProof(proofId) {
      const data = one((await raw.from("proof_records").select("id, usage_event_id, signature").eq("id", proofId).maybeSingle()).data);
      return data ? { id: data.id as string, usageEventId: data.usage_event_id as string, signed: typeof data.signature === "string" && data.signature.length > 0 } : null;
    },
    async loadScore(userId, day, algorithmVersion) {
      const data = one((await raw.from("score_records").select("points").eq("user_id", userId).eq("day", day).eq("algorithm_version", algorithmVersion).maybeSingle()).data);
      return data ? Number(data.points) : null;
    },
    async loadEpochRow(epochId) {
      const data = one((await raw.from("reward_epochs").select("state, epoch_kind, reward_pool_points, protocol_version, claimable").eq("id", epochId).maybeSingle()).data);
      return data ? { state: data.state as EpochState, epochKind: data.epoch_kind as string, rewardPoolPoints: Number(data.reward_pool_points), protocolVersion: (data.protocol_version as string | null) ?? null, claimable: (data.claimable as boolean | null) ?? null } : null;
    },
    async ledgerStats() {
      const data = rows((await raw.from("usage_point_ledger").select("amount")).data);
      return { rows: data.length, total: data.reduce((s, r) => s + Number(r.amount), 0) };
    },
    async allocationStats(epochId) {
      const data = rows((await raw.from("reward_allocations").select("points").eq("epoch_id", epochId)).data);
      return { rows: data.length, positive: data.filter((r) => Number(r.points) > 0).length };
    },
    async userBalance(userId) {
      const data = rows((await raw.from("usage_point_ledger").select("amount").eq("user_id", userId)).data);
      return data.reduce((s, r) => s + Number(r.amount), 0);
    },
    async protocolVersionRow(version) {
      const row = one((await raw.from("mining_protocol_versions").select("status, role, epoch_emission_points, claimable").eq("version", version).maybeSingle()).data);
      return row ? { status: row.status as string, role: (row.role as string | undefined) ?? "missing", epochEmissionPoints: Number(row.epoch_emission_points), claimable: Boolean(row.claimable) } : null;
    },
  };
}

async function main(): Promise<number> {
  const epochId = flag("epoch");
  const confirmed = process.argv.includes("--confirm");
  if (!epochId) {
    line("usage: --epoch <epoch-id> [--confirm]");
    return 1;
  }
  const approved = approvedCalibrationClose(epochId);
  if (!approved) {
    line(`Refused: ${epochId} is not an owner-approved calibration epoch.`);
    return 1;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    line("Supabase is not configured.");
    return 1;
  }
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const reads = createReads(admin);

  const before = await snapshotCalibration(reads, approved);
  line(`CALIBRATION CLOSE — ${epochId} (day ${epochDay(epochId)})`);
  line(`  event            ${before.event.id} key=${before.event.economicEventKey?.slice(0, 20)}… eligible=${before.event.eligibleComputeMicros} status=${before.event.economicStatus} pricing=${before.event.pricingVersion}`);
  line(`  proof            ${before.proof.id} signed=${before.proof.signed}`);
  line(`  score (v1)       ${before.score}`);
  line(`  epoch            ${before.epoch.state} kind=${before.epoch.epochKind} protocol=${before.epoch.protocolVersion} claimable=${before.epoch.claimable}`);
  line(`  ledger           ${before.ledger.rows} rows, total ${before.ledger.total}`);
  line(`  allocations      ${before.allocations.rows} (${before.allocations.positive} positive)`);
  line(`  settled balance  ${before.balance}`);
  line();
  try {
    await assertCalibrationPreconditions(reads, approved, before);
    line("  preconditions    all hold");
  } catch (error) {
    if (error instanceof CalibrationCloseRefused) {
      line(`  ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (!confirmed) {
    line("  Dry run. Re-run with --confirm to close the epoch with ZERO emission.");
    return 0;
  }
  // The single atomic operation. Either the whole close committed, or the
  // database rolled every write back and nothing below changed.
  type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  const rpc = await (admin.rpc as unknown as Rpc)("close_development_calibration_epoch", { p_epoch_id: epochId });
  if (rpc.error) {
    line("  REFUSED by the database; the transaction rolled back and nothing was written:");
    line(`  ${rpc.error.message}`);
    return 1;
  }
  const audit = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as Record<string, unknown> | undefined;
  line(`  committed        ${JSON.stringify(audit ?? null)}`);
  line();
  // Second, independent layer: re-read everything and hold it to the same
  // postconditions the preflight defines. This verifies; it cannot undo.
  const after = await snapshotCalibration(reads, approved);
  line(`  after            epoch=${after.epoch.state} kind=${after.epoch.epochKind} protocol=${after.epoch.protocolVersion} claimable=${after.epoch.claimable}`);
  line(`  event            status=${after.event.economicStatus} eligible=${after.event.eligibleComputeMicros} pricing=${after.event.pricingVersion}`);
  line(`  score (v1)       ${after.score}`);
  line(`  ledger           ${after.ledger.rows} rows, total ${after.ledger.total} (before: ${before.ledger.rows}, ${before.ledger.total})`);
  line(`  allocations      ${after.allocations.rows} (${after.allocations.positive} positive)`);
  line(`  settled balance  ${after.balance} (before: ${before.balance})`);
  try {
    assertCalibrationPostconditions(before, after, approved);
    line("  postconditions   all hold (independent audit)");
  } catch (error) {
    line(`  ${(error as Error).message}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(`Failed: ${(error as Error).message}`);
    process.exit(1);
  });
