/**
 * Funding audit: is there any authoritatively PAID funding source?
 *
 *   npm run usage:funding
 *
 * Read-only. Answers the one question M14 makes a gate: can a live request
 * be proven paid by the provider's own account surface, under
 * economic-verification-v1? It reads two things and prints neither
 * credential:
 *
 *   1. Vercel AI Gateway `GET /v1/credits` with USAGE's own key: balance and
 *      lifetime spend. The API does not say whether credits were purchased;
 *      a balance at or under the free monthly allowance with no purchase on
 *      record is promotional funding, and promotional is held.
 *   2. Every provider connection's stored `account_context` -- what the
 *      provider stated at connection time (OpenRouter `is_free_tier`).
 *
 * It never sends an inference request and never spends anything.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { fundingEvidenceForConnection } from "../src/lib/protocol/funding";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function vercelCredits(): Promise<{ balance: string; totalUsed: string } | null> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) return null;
  const response = await fetch("https://ai-gateway.vercel.sh/v1/credits", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    line(`  Vercel AI Gateway credits: HTTP ${response.status}`);
    return null;
  }
  const body = (await response.json()) as { balance?: string; total_used?: string };
  return { balance: String(body.balance ?? "?"), totalUsed: String(body.total_used ?? "?") };
}

async function main(): Promise<void> {
  line();
  line("FUNDING AUDIT (read-only; no request is sent to any model)");
  line();

  const credits = await vercelCredits();
  if (credits) {
    line("  USAGE's own Vercel AI Gateway key");
    line(`    balance        $${credits.balance}`);
    line(`    total used     $${credits.totalUsed}`);
    line("    funding class  usage_credit -> promotional (held). The credits API");
    line("                   does not distinguish purchased from free-tier credit,");
    line("                   and USAGE's own budget is never a user's payment.");
    line();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    line("  Supabase is not configured; connection audit skipped.");
    return;
  }
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin
    .from("provider_connections")
    .select("id, provider, account_label, auth_method, account_context, validated_at, revoked_at, connection_status")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  let paid = 0;
  line("  Provider connections");
  for (const row of data ?? []) {
    const funding = fundingEvidenceForConnection(row);
    const live = !row.revoked_at && row.connection_status !== "revoked";
    const verdict = funding ? funding.class : "unknown";
    if (live && funding?.class === "paid_account") paid += 1;
    line(`    ${row.provider.padEnd(12)} ${(row.account_label ?? "").padEnd(28)} ${live ? "live   " : "revoked"}  funding=${verdict}${funding ? `  (${funding.basis}${funding.observedAt ? ` @ ${funding.observedAt}` : ""})` : ""}`);
  }
  line();
  if (paid === 0) {
    line("  PAID E2E BLOCKED — NO AUTHORITATIVELY PAID FUNDING SOURCE.");
    line("  No live connection carries a provider statement that the account has");
    line("  purchased credit. Under economic-verification-v1 nothing here can");
    line("  become metered_paid, so a live request would be held, not eligible.");
  } else {
    line(`  ${paid} live connection(s) carry provider-stated paid funding.`);
  }
  line();
}

main().catch((error: unknown) => {
  line(`Failed: ${(error as Error).message}`);
  process.exit(1);
});
