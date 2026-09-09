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

  const count = async (table: keyof Database["public"]["Tables"], filter?: (q: any) => any) => {
    let q = admin.from(table).select("*", { count: "exact", head: true });
    if (filter) q = filter(q);
    const { count: n, error } = await q;
    if (error) throw new Error(`${String(table)}: ${error.message}`);
    return n ?? 0;
  };

  const { data: ledger, error: ledgerError } = await admin.from("usage_point_ledger").select("amount");
  if (ledgerError) throw new Error(`ledger: ${ledgerError.message}`);
  const ledgerTotal = (ledger ?? []).reduce((sum, row) => sum + BigInt(String(row.amount)), 0n);

  const snapshot = {
    takenAt: new Date().toISOString(),
    usageEvents: await count("usage_events"),
    settledAllocations: await count("usage_point_ledger"),
    usagePointLedgerTotal: ledgerTotal.toString(),
    settledEpochs: await count("reward_epochs", (q) => q.not("settled_at", "is", null)),
    activeMinerCredentials: await count("usage_miner_credentials", (q) => q.is("revoked_at", null)),
  };

  line(JSON.stringify(snapshot, null, 2));
}

main().catch((error: unknown) => {
  line(`Failed: ${(error as Error).message}`);
  process.exit(1);
});
