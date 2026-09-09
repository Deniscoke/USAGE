/**
 * Post-migration verification for 0017, against the hosted project.
 *
 *   npm run usage:verify-0017
 *
 * Checks the schema is what the migration says, and that the client roles
 * are held where they should be -- using the real anon key against the real
 * PostgREST, not a local shim. Prints pass/fail lines only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- tables exist and are readable by the service role
  for (const table of ["miner_tool_mappings", "local_usage_observations", "wallet_connections"] as const) {
    const { error } = await admin.from(table).select("*", { count: "exact", head: true });
    check(`${table} exists`, !error, error?.message ?? "");
  }

  // --- new columns exist (a select naming them succeeds)
  const dev = await admin.from("miner_devices").select("public_key, public_key_algorithm, os, tool_state, last_usage_event_at, device_trust_level").limit(1);
  check("miner_devices new fields", !dev.error, dev.error?.message ?? "");
  const ev = await admin.from("usage_events").select("provenance_sources, verification_level, correlation_status, identity_trust_level, provider_identity_hash").limit(5);
  check("usage_events provenance fields", !ev.error, ev.error?.message ?? "");
  check(
    "usage_events backfilled with a level",
    !ev.error && (ev.data ?? []).every((r) => r.verification_level !== null && (r.provenance_sources ?? []).length > 0),
    (ev.data ?? []).map((r) => `${r.verification_level}:${(r.provenance_sources ?? []).join("+")}`).join(", "),
  );

  // --- credential scopes
  const creds = await admin.from("usage_miner_credentials").select("scopes, revoked_at");
  const live = (creds.data ?? []).filter((c) => !c.revoked_at);
  check(
    "live credentials carry telemetry + mappings scopes",
    live.length > 0 && live.every((c) => c.scopes.includes("miner:telemetry") && c.scopes.includes("miner:mappings")),
    `${live.length} live`,
  );
  check(
    "no credential carries a non-miner scope",
    (creds.data ?? []).every((c) => c.scopes.every((s) => s.startsWith("miner:"))),
  );

  // --- anon cannot read or write the trusted telemetry tables
  for (const table of ["miner_tool_mappings", "local_usage_observations", "wallet_connections"] as const) {
    const read = await anon.from(table).select("*").limit(1);
    check(`anon cannot read ${table}`, Boolean(read.error) || (read.data ?? []).length === 0, read.error?.code ?? "empty");
    const write = await anon.from(table).insert({} as never);
    check(`anon cannot write ${table}`, Boolean(write.error), write.error?.code ?? "");
  }
  // wallet_connections must have no policy for any client role at all
  const walletAnon = await anon.from("wallet_connections").select("*").limit(1);
  check("wallet_connections has no client access", Boolean(walletAnon.error), walletAnon.error?.code ?? "");

  // --- anon cannot touch economic tables (unchanged, re-asserted)
  for (const table of ["usage_events", "usage_point_ledger", "reward_allocations"] as const) {
    const write = await anon.from(table).insert({} as never);
    check(`anon cannot write ${table}`, Boolean(write.error), write.error?.code ?? "");
  }

  // --- service role: observation constraints hold on the real database
  const { data: device } = await admin.from("miner_devices").select("id, user_id").is("revoked_at", null).limit(1).maybeSingle();
  if (device) {
    const negative = await admin.from("local_usage_observations").insert({
      user_id: device.user_id, device_id: device.id, schema_version: "local-usage-observation-v1",
      adapter: "claude-otel-adapter-v1", tool_id: "claude-code", source_type: "native_otel", provider: "anthropic",
      input_tokens: -1, occurred_at: new Date().toISOString(), local_session_id: "verify", local_event_id: "verify-negative",
    });
    check("negative token count refused by the database", Boolean(negative.error), negative.error?.code ?? "");

    const { data: other } = await admin.from("profiles").select("id").neq("id", device.user_id).limit(1).maybeSingle();
    if (other) {
      const crossUser = await admin.from("local_usage_observations").insert({
        user_id: other.id, device_id: device.id, schema_version: "local-usage-observation-v1",
        adapter: "claude-otel-adapter-v1", tool_id: "claude-code", source_type: "native_otel", provider: "anthropic",
        input_tokens: 1, occurred_at: new Date().toISOString(), local_session_id: "verify", local_event_id: "verify-cross",
      });
      check("observation cannot bind a device to another user", Boolean(crossUser.error), crossUser.error?.code ?? "");
    }
    // Nothing above should have inserted anything.
    const { count } = await admin.from("local_usage_observations").select("*", { count: "exact", head: true }).eq("local_session_id", "verify");
    check("verification inserted no rows", (count ?? 0) === 0);
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stdout.write(`Failed: ${(error as Error).message}\n`);
  process.exit(1);
});
