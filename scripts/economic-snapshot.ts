/**
 * Economic invariant snapshot.
 *
 *   npm run usage:snapshot
 *
 * Five numbers that a schema migration must leave exactly where it found
 * them, read directly from the tables that hold them. Run before and after,
 * diff by eye. Prints counts and sums only -- no ids, no secrets.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const admin = createClient<Database>(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const exact = { count: "exact" as const, head: true as const };
  const counted = (result: { count: number | null; error: { message: string } | null }, what: string): number => {
    if (result.error) throw new Error(`${what}: ${result.error.message}`);
    return result.count ?? 0;
  };

  const { data: ledger, error: ledgerError } = await admin.from("usage_point_ledger").select("amount");
  if (ledgerError) throw new Error(`ledger: ${ledgerError.message}`);
  const ledgerTotal = (ledger ?? []).reduce((sum, row) => sum + BigInt(String(row.amount)), 0n);

  const snapshot = {
    takenAt: new Date().toISOString(),
    usageEvents: counted(await admin.from("usage_events").select("*", exact), "usage_events"),
    settledAllocations: counted(await admin.from("usage_point_ledger").select("*", exact), "usage_point_ledger"),
    usagePointLedgerTotal: ledgerTotal.toString(),
    settledEpochs: counted(await admin.from("reward_epochs").select("*", exact).not("settled_at", "is", null), "reward_epochs"),
    activeMinerCredentials: counted(await admin.from("usage_miner_credentials").select("*", exact).is("revoked_at", null), "usage_miner_credentials"),
  };

  line(JSON.stringify(snapshot, null, 2));
}

main().catch((error: unknown) => {
  line(`Failed: ${(error as Error).message}`);
  process.exit(1);
});
