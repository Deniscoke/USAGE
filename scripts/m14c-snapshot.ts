/**
 * M14C snapshot: the economic state around ONE real paid request.
 *
 *   npm run usage:m14c:snapshot
 *
 * Reads only. No secrets, no prompts, no responses. Run once before the
 * request and once after; the diff is the evidence.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { epochIdForDate, estimateReward, networkShare } from "../src/lib/domain/epoch";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const userId = flag("user") ?? "da93cec8-8f02-4fc7-b86a-d70be521a19f";
const connectionId = flag("connection") ?? "f0f97095-4a68-432c-ac10-93746c370af3";

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(30)}${value === null || value === undefined ? "unknown" : String(value)}\n`);
}

async function main(): Promise<void> {
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false } });
  const now = new Date();
  const epochId = epochIdForDate(now);
  const day = now.toISOString().slice(0, 10);

  const { data: connection, error: connectionError } = await admin
    .from("provider_connections")
    .select("id, provider, auth_method, connection_status, revoked_at, account_context, validated_at")
    .eq("id", connectionId)
    .maybeSingle();
  if (connectionError) line("connection error", connectionError.message);
  line("connection", connection?.id);
  line("provider / auth", `${connection?.provider} / ${connection?.auth_method}`);
  line("status", `${connection?.connection_status}${connection?.revoked_at ? " (revoked)" : ""}`);
  line("account context", JSON.stringify(connection?.account_context));

  const events = await admin.from("usage_events").select("id", { count: "exact", head: true });
  line("usage_events", events.count);
  const keyed = await admin.from("usage_events").select("id", { count: "exact", head: true }).not("economic_event_key", "is", null);
  line("keyed economic units", keyed.count);

  const { data: epoch } = await admin.from("reward_epochs").select("*").eq("id", epochId).maybeSingle();
  line("open epoch id", epochId);
  line("open epoch row", epoch ? `${epoch.state} (${epoch.epoch_kind})` : "not materialised yet (opens on first settlement pass)");

  const { data: scores } = await admin.from("score_records").select("user_id, points, weighted_cost_micros, pending_cost_micros").eq("day", day);
  const mine = (scores ?? []).find((row) => row.user_id === userId);
  const network = (scores ?? []).reduce((sum, row) => sum + Number(row.points), 0);
  const userScore = Number(mine?.points ?? 0);
  line("user mining score (today)", userScore.toFixed(4));
  line("user weighted cost micros", mine?.weighted_cost_micros ?? 0);
  line("network score (today)", network.toFixed(4));
  const pool = epoch?.reward_pool_points ?? 100000;
  const estimate = estimateReward({ userScore, networkScore: network, rewardPoolPoints: pool });
  line("estimated open-epoch USAGE", network > 0 ? `${estimate.points} (share ${(networkShare(userScore, network) * 100).toFixed(2)}%)` : "0 (no score yet)");

  const { data: ledger } = await admin.from("usage_point_ledger").select("user_id, amount");
  const total = (ledger ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
  const balance = (ledger ?? []).filter((row) => row.user_id === userId).reduce((sum, row) => sum + Number(row.amount), 0);
  line("settled balance (this user)", balance);
  line("ledger rows", (ledger ?? []).length);
  line("ledger total", total);
  const { data: allocations, error: allocationsError } = await admin.from("reward_allocations").select("epoch_id, user_id, points");
  line("reward allocations", allocationsError ? allocationsError.message : allocations?.length);

  const { data: mine24h } = await admin
    .from("usage_events")
    .select("id, model, economic_event_key, dedupe_status, economic_verification_status, economic_verification_policy_version, eligible_compute_micros, protocol_compute_micros, reward_status")
    .eq("user_id", userId)
    .eq("gateway_id", `connection:${connectionId}`)
    .order("created_at", { ascending: false })
    .limit(3);
  for (const event of mine24h ?? []) {
    line("event", `${event.id.slice(0, 8)} ${event.model} key=${event.economic_event_key ? event.economic_event_key.slice(0, 16) + "…" : "null"} dedupe=${event.dedupe_status} econ=${event.economic_verification_status}/${event.economic_verification_policy_version} protocol=${event.protocol_compute_micros} eligible=${event.eligible_compute_micros} reward=${event.reward_status}`);
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`Failed: ${(error as Error).message}\n`);
  process.exit(1);
});
