/**
 * Re-check an existing provider connection with its STORED credential.
 *
 *   npm run usage:revalidate -- --connection <id> [--family openai]
 *
 * Non-generative: it runs the provider profile's documented probe (a model
 * list or a key-info endpoint) and updates the connection's status,
 * capabilities and models from what actually came back. The credential is
 * read server-side inside the connection store and is never printed.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { createConnectionStore } from "../src/lib/providers/connections";

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const connectionId = flag("connection");
  if (!connectionId) throw new Error("usage: --connection <id> [--family <provider family>]");
  const admin = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: row, error } = await admin
    .from("provider_connections")
    .select("id, user_id, account_label, provider, protocol, base_url, connection_status, mining_eligibility, last_error_code")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("no such connection");

  const store = createConnectionStore(admin);
  const before = { status: row.connection_status, eligibility: row.mining_eligibility, error: row.last_error_code, baseHost: row.base_url ? new URL(row.base_url).host : null };
  const result = await store.revalidate(row.id, row.user_id, { providerFamily: flag("family") });

  const out = (label: string, value: unknown) => process.stdout.write(`  ${label.padEnd(22)} ${String(value)}\n`);
  process.stdout.write("\nREVALIDATION (non-generative)\n");
  out("connection", row.id);
  out("display name", row.account_label ?? row.provider);
  out("protocol", row.protocol);
  out("base URL before", before.baseHost);
  out("base URL after", new URL(result.baseUrl).host + new URL(result.baseUrl).pathname);
  out("probed", result.validation.probed);
  out("verdict", result.validation.verdict);
  out("failure", result.validation.failure ?? "none");
  out("message", result.validation.message);
  out("status before → after", `${before.status} → ${result.status}`);
  out("eligibility", `${before.eligibility} → ${result.eligibility}`);
  out("models discovered", result.validation.models.length);
  out("capabilities", JSON.stringify(result.validation.capabilities));
  out("account context", result.validation.accountContext ? JSON.stringify(result.validation.accountContext) : "none");
  process.stdout.write("\n");
}

main().catch((error: unknown) => {
  process.stdout.write(`Failed: ${(error as Error).message}\n`);
  process.exit(1);
});
