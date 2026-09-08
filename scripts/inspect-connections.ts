/**
 * What is connected, in production, right now.
 *
 *   npm run usage:connections
 *
 * Read-only. It answers "does this account already have a working provider
 * connection?" without anyone opening the database by hand and without a second
 * connection being created by accident.
 *
 * It never prints a credential. It cannot: the connection rows hold a secret
 * *reference*, and this script never resolves one.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !secret) {
  process.stdout.write("Supabase is not configured in this environment.\n");
  process.exit(1);
}

const admin = createClient<Database>(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const { data: users, error: usersError } = await admin.auth.admin.listUsers();
  if (usersError) throw new Error(usersError.message);

  const { data: connections, error } = await admin
    .from("provider_connections")
    .select(
      "id, user_id, provider, account_label, method, auth_method, protocol, base_url, status, connection_status, mining_eligibility, capabilities, account_context, validated_at, created_at, revoked_at, last_success_at, last_error_code",
    )
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  line();
  line(`  ${users.users.length} account(s), ${connections?.length ?? 0} connection(s)`);
  line();

  for (const user of users.users) {
    const owned = (connections ?? []).filter((row) => row.user_id === user.id);
    line(`  ${user.email ?? user.id}`);
    if (owned.length === 0) {
      line("    no provider connections");
      line();
      continue;
    }
    for (const row of owned) {
      line(`    ${row.provider}  ${row.account_label ?? "(no label)"}`);
      line(`      id            ${row.id}`);
      line(`      method        ${row.method} via ${row.auth_method}`);
      line(`      protocol      ${row.protocol ?? "unknown"}`);
      line(`      base url      ${row.base_url ?? "(default)"}`);
      line(`      status        ${row.status} / ${row.connection_status}${row.revoked_at ? "  REVOKED" : ""}`);
      line(`      eligibility   ${row.mining_eligibility}`);
      line(`      capabilities  ${JSON.stringify(row.capabilities)}`);
      line(`      account       ${JSON.stringify(row.account_context)}`);
      line(`      validated     ${row.validated_at ?? "never"}`);
      line(`      last success  ${row.last_success_at ?? "never"}`);
      line(`      last error    ${row.last_error_code ?? "none"}`);
      line(`      created       ${row.created_at}`);
      line();
    }
  }
}

main().catch((error: unknown) => {
  line(`Failed: ${(error as Error).message}`);
  process.exit(1);
});
