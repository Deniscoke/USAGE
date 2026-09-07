/**
 * First hosted proof: create a test miner, ask the deployment what it trusts,
 * and (if it can issue) run one tiny request through the hosted gateway.
 */
import { createClient } from "@supabase/supabase-js";
import { createSupabaseMinerStore } from "../src/lib/miner/credentials";
import type { Database } from "../src/lib/supabase/database.types";

const HOST = process.env.USAGE_HOST!;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const admin = createClient<Database>(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function out(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const email = `miner-${Date.now()}@usage.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password: `Mm1!${Date.now()}zz`,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "no user");
  const userId = created.data.user.id;
  out(`user id      : ${userId}`);

  const store = createSupabaseMinerStore(admin);
  const credential = await store.create(userId, "hosted-first-proof");
  out(`credential id: ${credential.credentialId}`);
  out(`token prefix : ${credential.token.slice(0, 12)}...  (plaintext held in memory only)`);

  // Persist for the follow-up steps, in the gitignored artifact directory.
  const fs = await import("node:fs");
  fs.mkdirSync("C:/Users/Admin/Desktop/USAGE/.usage", { recursive: true });
  fs.writeFileSync(
    "C:/Users/Admin/Desktop/USAGE/.usage/hosted-miner.json",
    JSON.stringify({ userId, credentialId: credential.credentialId, token: credential.token }),
  );

  out("");
  out("Trust diagnostics from the deployment");
  out("-------------------------------------");
  const trust = await fetch(`${HOST}/api/gateway/trust`, {
    headers: { "x-usage-miner-token": credential.token },
  });
  const body = await trust.text();
  out(`HTTP ${trust.status}`);
  out(body.slice(0, 600));
}

void main().catch((error: unknown) => {
  out(`Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
