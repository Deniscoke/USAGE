/**
 * Close an owner-approved development calibration epoch with ZERO emission.
 *
 *   npm run usage:close-calibration -- --epoch epoch-2026-09-10 --confirm
 *
 * Not a general settlement command. The epoch id must be listed in
 * APPROVED_CALIBRATION_CLOSES with the exact facts the owner approved, the
 * database must carry 0019 (protocol binding, claimable flag, the
 * mining-dev-calibration-v1 row), and every precondition and postcondition
 * in src/lib/db/calibration-close.ts must hold. Otherwise nothing is written.
 *
 * Without --confirm it only prints the pre-close snapshot and the checks.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { createSupabaseSettlementStore } from "../src/lib/db/supabase-settlement-store";
import { CalibrationCloseRefused, approvedCalibrationClose, assertCalibrationPreconditions, closeCalibrationEpoch, snapshotCalibration, type CalibrationReadStore } from "../src/lib/db/calibration-close";
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
  const result = await closeCalibrationEpoch(createSupabaseSettlementStore(admin), reads, epochId);
  line(`  closed           network score ${result.networkScore}, distributed ${result.distributed}`);
  line(`  after            epoch=${result.after.epoch.state} protocol=${result.after.epoch.protocolVersion} claimable=${result.after.epoch.claimable} ledger ${result.after.ledger.rows}/${result.after.ledger.total} balance ${result.after.balance}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(`Failed: ${(error as Error).message}`);
    process.exit(1);
  });
