/**
 * Settle a mining epoch: turn daily mining scores into Usage Points.
 *
 *   npm run usage:settle-epoch                # today (UTC)
 *   npm run usage:settle-epoch -- 2026-06-01
 *
 * Two explicit phases, because crediting the ledger is permanent:
 *
 *   FINALIZING  the epoch stops accepting usage; late proofs from here on
 *               carry forward to the next open epoch
 *   SETTLED     allocations are computed once and credited once
 *
 * Running it again on a settled epoch is refused rather than silently
 * re-credited: settled allocations are immutable.
 *
 * Usage Points are an off-chain protocol accounting unit — not money, not a
 * security, not a claim on any future token.
 */
import { createClient } from "@supabase/supabase-js";
import { createSupabaseSettlementStore } from "../src/lib/db/supabase-settlement-store";
import { finalizeEpoch, settleEpoch } from "../src/lib/db/settlement";
import { dailyEpochFor, EpochLifecycleError } from "../src/lib/domain/epoch";
import { DAILY_REWARD_POOL_POINTS } from "../src/lib/demo/network";
import { CURRENT_SCORING_VERSION } from "../src/lib/domain/scoring";
import { formatNumber } from "../src/lib/domain/money";
import type { Database } from "../src/lib/supabase/database.types";

const line = (text = "") => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    line("Supabase is not configured.");
    return 1;
  }

  const admin = createClient<Database>(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const epoch = dailyEpochFor(new Date(`${day}T12:00:00.000Z`), DAILY_REWARD_POOL_POINTS);
  const store = createSupabaseSettlementStore(admin);
  const options = {
    algorithmVersion: CURRENT_SCORING_VERSION,
    // Not a public network yet, and the record says so.
    epochKind: "development",
  };

  let result;
  try {
    const finalized = await finalizeEpoch(store, epoch, options);
    line(`Finalized      : ${finalized.epochId} (no longer accepting usage)`);
    result = await settleEpoch(store, epoch, options);
  } catch (error) {
    if (error instanceof EpochLifecycleError) {
      line(`Refused: ${error.message}`);
      line("Settled allocations are immutable; nothing was changed.");
      return 1;
    }
    throw error;
  }

  line("USAGE — EPOCH SETTLEMENT (development epoch)");
  line("===========================================");
  line();
  line(`Epoch          : ${result.epochId}`);
  line(`Scoring        : ${CURRENT_SCORING_VERSION}`);
  line(`Participants   : ${result.participants}`);
  line(`Network score  : ${formatNumber(result.networkScore, 2)}`);
  line(`Pool           : ${formatNumber(result.pool)} Usage Points`);
  line(`Distributed    : ${formatNumber(result.distributed)} Usage Points`);
  line(`Newly credited : ${result.credited} allocation(s)`);
  line();

  for (const allocation of result.allocations) {
    line(
      `  ${allocation.userId}  ${(allocation.networkShare * 100).toFixed(3)}%  ` +
        `${formatNumber(allocation.points)} points`,
    );
  }

  if (result.participants > 0 && result.distributed !== result.pool) {
    line();
    line("WARNING: distributed does not equal the pool. Settlement is unsound.");
    return 1;
  }

  line();
  line("Usage Points — Beta. Off-chain, non-transferable, no monetary value.");
  return 0;
}

main().then((code) => process.exit(code));
