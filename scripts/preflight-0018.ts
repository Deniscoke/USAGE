/**
 * Read-only preflight for migration 0018 against the hosted database.
 *
 *   npm run usage:preflight-0018
 *
 * Computes what 0018's backfill WOULD produce from usage_events.raw_metadata
 * and checks whether the global unique index could be built on it. Reads
 * only. Prints counts and categories, never a row, never a secret. If any
 * blocking category is non-zero the exit code is 1 and the migration must
 * not be applied until the owner has looked at those rows.
 *
 * Also records the invariant snapshot the approval gate asks for.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database, UsageEventRow } from "../src/lib/supabase/database.types";

const KEY_SHAPE = /^ecu1:[0-9a-f]{64}$/;

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const admin = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const events: UsageEventRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("usage_events").select("*").order("created_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    events.push(...((data ?? []) as UsageEventRow[]));
    if (!data || data.length < 1000) break;
  }

  // --- what the backfill would write
  let keyed = 0;
  let invalidShape = 0;
  let unkeyed = 0;
  const statusCounts: Record<string, number> = {};
  const primaryByKey = new Map<string, { id: string; user: string }[]>();
  let settledMissingPolicy = 0;
  let settledMissingPricing = 0;
  let settledMissingVerification = 0;
  let conflictingStatus = 0;

  for (const e of events) {
    const raw = e.raw_metadata ?? {};
    const rawKey = raw.economic_event_key;
    if (typeof rawKey === "string" && rawKey.length > 0 && !KEY_SHAPE.test(rawKey)) invalidShape += 1;
    const key = typeof rawKey === "string" && KEY_SHAPE.test(rawKey) ? rawKey : null;
    const rawStatus = String(raw.dedupe_status ?? "");
    const dedupe = ["unique", "duplicate", "conflict"].includes(rawStatus) ? rawStatus : key ? "unique" : "unkeyed";
    statusCounts[dedupe] = (statusCounts[dedupe] ?? 0) + 1;
    if (key) keyed += 1;
    else unkeyed += 1;
    if (!key && rawStatus === "unique") conflictingStatus += 1;
    if (key && dedupe === "unique") {
      const list = primaryByKey.get(key) ?? [];
      list.push({ id: e.id, user: e.user_id });
      primaryByKey.set(key, list);
    }
    if (e.economic_status === "settled") {
      if (!e.reward_policy_version) settledMissingPolicy += 1;
      if (!e.protocol_pricing_version) settledMissingPricing += 1;
      if (typeof raw.economic_verification_policy_version !== "string") settledMissingVerification += 1;
    }
  }

  const duplicatePrimaryKeys = [...primaryByKey.values()].filter((rows) => rows.length > 1);
  const crossUserKeys = duplicatePrimaryKeys.filter((rows) => new Set(rows.map((r) => r.user)).size > 1);

  line();
  line("0018 BACKFILL PREFLIGHT (read-only)");
  line(`  usage_events                       ${events.length}`);
  line(`  would carry a key                  ${keyed}`);
  line(`  would stay unkeyed                 ${unkeyed}`);
  line(`  dedupe_status after backfill       ${JSON.stringify(statusCounts)}`);
  line(`  invalid key shapes                 ${invalidShape}   (would be dropped to null; blocking if > 0)`);
  line(`  status 'unique' without a key      ${conflictingStatus}   (blocking if > 0)`);
  line(`  keys with >1 primary unit          ${duplicatePrimaryKeys.length}   (UNIQUE INDEX WOULD FAIL if > 0)`);
  line(`    of which across users            ${crossUserKeys.length}`);
  line(`  settled rows missing reward policy ${settledMissingPolicy}`);
  line(`  settled rows missing pricing ver.  ${settledMissingPricing}`);
  line(`  settled rows predating economic-verification-v1 ${settledMissingVerification}   (informational: left as they are)`);

  // --- invariant snapshot
  const exact = { count: "exact" as const, head: true as const };
  const counted = (r: { count: number | null; error: { message: string } | null }, what: string): number => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.count ?? 0;
  };
  const { data: ledger } = await admin.from("usage_point_ledger").select("amount");
  const ledgerTotal = (ledger ?? []).reduce((sum, row) => sum + BigInt(String(row.amount)), 0n);
  const { data: settledEpochs } = await admin.from("reward_epochs").select("id, starts_at, ends_at, scoring_version").not("settled_at", "is", null);
  let settledScores = 0;
  for (const ep of settledEpochs ?? []) {
    const { count: n } = await admin
      .from("score_records")
      .select("*", { count: "exact", head: true })
      .eq("algorithm_version", ep.scoring_version)
      .gte("day", ep.starts_at.slice(0, 10))
      .lt("day", ep.ends_at.slice(0, 10));
    settledScores += n ?? 0;
  }
  const { data: pricing } = await admin.from("protocol_pricing_versions").select("version, status").order("version");

  line();
  line("INVARIANT SNAPSHOT");
  line(`  usage_events                ${counted(await admin.from("usage_events").select("*", exact), "usage_events")}`);
  line(`  settled usage events        ${counted(await admin.from("usage_events").select("*", exact).eq("economic_status", "settled"), "settled")}`);
  line(`  reward allocations          ${counted(await admin.from("reward_allocations").select("*", exact), "reward_allocations")}`);
  line(`  ledger total                ${ledgerTotal.toString()}`);
  line(`  settled epochs              ${counted(await admin.from("reward_epochs").select("*", exact).not("settled_at", "is", null), "reward_epochs")}`);
  line(`  score records in settled    ${settledScores}`);
  line(`  pricing versions            ${(pricing ?? []).map((p) => `${p.version}:${p.status}`).join(", ") || "none"}`);
  line(`  active miner credentials    ${counted(await admin.from("usage_miner_credentials").select("*", exact).is("revoked_at", null), "usage_miner_credentials")}`);
  line();

  const blocking = invalidShape + conflictingStatus + duplicatePrimaryKeys.length;
  if (blocking > 0) {
    line(`STOP: ${blocking} blocking finding(s). Do not apply 0018.`);
    process.exit(1);
  }
  line("No backfill collisions. The unique index can be built on today's rows.");
}

main().catch((error: unknown) => {
  line(`Failed: ${(error as Error).message}`);
  process.exit(1);
});
