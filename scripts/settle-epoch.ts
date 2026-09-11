/**
 * Settle a mining epoch: turn daily mining scores into Usage Points.
 *
 *   npm run usage:settle-epoch                # yesterday (UTC), the safe default
 *   npm run usage:settle-epoch -- 2026-06-01  # a named day, including today
 *
 * The decisions live in `settleDailyEpoch`, shared with the nightly job at
 * /api/cron/settle-epoch, so the automated path and the operator path cannot
 * drift apart. This file is the terminal in front of it.
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
 * Naming a day explicitly permits settling one that is still in progress. The
 * nightly job never does that; a person doing it deliberately may.
 *
 * Usage Points are an off-chain protocol accounting unit — not money, not a
 * security, not a claim on any future token.
 */
import { createClient } from "@supabase/supabase-js";
import { settleDailyEpoch } from "../src/lib/db/settle-daily";
import { lastCompleteDay } from "../src/lib/domain/epoch-day";
import { formatNumber } from "../src/lib/domain/money";
import type { Database } from "../src/lib/supabase/database.types";

const line = (text = "") => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const named = process.argv[2];
  const day = named ?? lastCompleteDay();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    line("Supabase is not configured.");
    return 1;
  }

  const admin = createClient<Database>(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await settleDailyEpoch(admin, { day, allowIncompleteDay: Boolean(named) });

  line("USAGE — EPOCH SETTLEMENT (development epoch)");
  line("===========================================");
  line();
  line(`Epoch          : ${result.epochId}`);
  line(`Outcome        : ${result.outcome.toUpperCase()}`);
  line(`Reason         : ${result.reason}`);
  if (result.protocolVersion) line(`Protocol       : ${result.protocolVersion}`);

  if (result.outcome === "settled") {
    line(`Participants   : ${result.participants}`);
    line(`Pool           : ${formatNumber(result.pool ?? 0)} Usage Points`);
    line(`Distributed    : ${formatNumber(result.distributed ?? 0)} Usage Points`);
    line(`Newly credited : ${result.credited} allocation(s)`);
    line();
    for (const allocation of result.allocations ?? []) {
      line(
        `  ${allocation.userId}  ${(allocation.networkShare * 100).toFixed(3)}%  ` +
          `${formatNumber(allocation.points)} points`,
      );
    }
  }

  line();
  line("Usage Points — Beta. Off-chain, non-transferable, no monetary value.");
  // A refusal is a decision, not a crash, but the exit code should still say
  // that nothing was written.
  return result.outcome === "refused" ? 1 : 0;
}

main().then((code) => process.exit(code));
