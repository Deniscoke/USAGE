/**
 * Logical export of every table a rollback would need, as JSON.
 *
 *   npm run usage:export -- <directory>
 *
 * `supabase db dump` needs Docker, which this machine does not have, and a
 * pg_dump needs the database password, which is not held here. This reads
 * every row of the named tables through the service role and writes one JSON
 * file per table into the given directory -- which must be OUTSIDE the
 * repository. It prints row counts only. It never prints a row.
 *
 * Not a substitute for platform backups; a recoverable copy of the tables a
 * schema migration touches, taken by the same hands that run the migration.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

const TABLES = [
  "profiles",
  "provider_connections",
  "usage_events",
  "proof_records",
  "usage_daily_aggregates",
  "score_records",
  "reward_epochs",
  "reward_allocations",
  "usage_point_ledger",
  "usage_miner_credentials",
  "miner_devices",
  "miner_pairing_requests",
  "miner_tool_mappings",
  "local_usage_observations",
  "protocol_pricing_versions",
  "protocol_model_prices",
  "reward_policy_versions",
  "mining_protocol_versions",
] as const;

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error("usage: logical-export <directory outside the repo>");
  const resolved = path.resolve(target);
  if (resolved.startsWith(path.resolve(process.cwd()))) {
    throw new Error("refusing to export inside the repository");
  }
  await mkdir(resolved, { recursive: true });

  const admin = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  for (const table of TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from(table).select("*").range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    await writeFile(path.join(resolved, `${table}.json`), JSON.stringify(rows), { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`  ${table.padEnd(26)} ${rows.length} row(s)\n`);
  }
  process.stdout.write(`written to ${resolved}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(`Failed: ${(error as Error).message}\n`);
  process.exit(1);
});
