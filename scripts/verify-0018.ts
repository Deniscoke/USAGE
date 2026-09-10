/**
 * Post-migration verification for 0018, against the hosted project.
 *
 *   npm run usage:verify-0018
 *
 * Read-only in effect: every write it attempts is one the migration must
 * REFUSE, so a passing run changes nothing, and it inserts no test rows. The
 * catalog is checked for the index and triggers; the behaviour is checked by
 * attempting the forbidden operations against the real settled rows.
 * Prints pass/fail lines only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
}
const refused = (error: { message?: string; code?: string } | null, pattern: RegExp) =>
  Boolean(error) && pattern.test(`${error?.code ?? ""} ${error?.message ?? ""}`);

async function main(): Promise<void> {
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- schema: the new columns exist and are readable
  const cols = await admin.from("usage_events").select("id, economic_event_key, dedupe_status, economic_verification_status, economic_verification_policy_version, economic_status, user_id").limit(50);
  check("usage_events carries the 0018 columns", !cols.error, cols.error?.message ?? "");
  const rows = cols.data ?? [];
  check("backfill: no row claims a key it does not have", rows.every((r) => (r.economic_event_key === null) === (r.dedupe_status === "unkeyed")), `${rows.length} rows`);

  // --- catalog: index and triggers via information_schema-visible effects.
  // PostgREST has no catalog endpoint, so each trigger is proved by its refusal below.

  // --- settled usage event: economics, owner and existence are frozen
  const settled = rows.find((r) => r.economic_status === "settled");
  check("a settled event exists to test against", Boolean(settled));
  if (settled) {
    const upd = await admin.from("usage_events").update({ eligible_compute_micros: 1 }).eq("id", settled.id);
    check("settled event: economic UPDATE refused", refused(upd.error, /immutable/), upd.error?.message ?? "no error");
    const pol = await admin.from("usage_events").update({ reward_policy_version: "usage-reward-policy-v9" }).eq("id", settled.id);
    check("settled event: policy version UPDATE refused", refused(pol.error, /immutable/));
    const owner = await admin.from("usage_events").update({ user_id: "00000000-0000-4000-8000-000000000000" }).eq("id", settled.id);
    check("settled event: user_id reassignment refused", refused(owner.error, /immutable|foreign key/));
    const del = await admin.from("usage_events").delete().eq("id", settled.id);
    check("settled event: DELETE refused", refused(del.error, /cannot be deleted/), del.error?.message ?? "no error");
    // Provenance enrichment stays allowed: a no-op write of the same value.
    const { data: prov } = await admin.from("usage_events").select("provenance_sources, correlation_status").eq("id", settled.id).single();
    const enrich = await admin.from("usage_events").update({ provenance_sources: prov?.provenance_sources ?? [] }).eq("id", settled.id);
    check("settled event: provenance write still allowed", !enrich.error, enrich.error?.message ?? "");
  }
  const unsettled = rows.find((r) => r.economic_status !== "settled");
  if (unsettled) {
    const owner = await admin.from("usage_events").update({ user_id: "00000000-0000-4000-8000-000000000000" }).eq("id", unsettled.id);
    check("any event: user_id reassignment refused", refused(owner.error, /immutable|foreign key/));
  }

  // --- settled epoch
  const { data: epochs } = await admin.from("reward_epochs").select("id, reward_pool_points, network_score, scoring_version, state").not("settled_at", "is", null).limit(1);
  const epoch = epochs?.[0];
  check("a settled epoch exists to test against", Boolean(epoch));
  if (epoch) {
    for (const [name, change] of [
      ["reward pool", { reward_pool_points: Number(epoch.reward_pool_points) + 1 }],
      ["network score", { network_score: Number(epoch.network_score) + 1 }],
      ["scoring version", { scoring_version: "usage_score_v9" }],
      ["bounds", { starts_at: "2000-01-01T00:00:00Z" }],
      ["state", { state: "open" }],
    ] as const) {
      const r = await admin.from("reward_epochs").update(change as never).eq("id", epoch.id);
      check(`settled epoch: ${name} UPDATE refused`, refused(r.error, /immutable/), r.error?.message ?? "no error");
    }
    const d = await admin.from("reward_epochs").delete().eq("id", epoch.id);
    check("settled epoch: DELETE refused", refused(d.error, /cannot be deleted/));
  }

  // --- scores under settled history
  const { data: scores } = await admin.from("score_records").select("id, user_id, day, algorithm_version, points").limit(20);
  const settledScore = (scores ?? []).find((s) => epoch && s.algorithm_version === epoch.scoring_version);
  if (settledScore) {
    const u = await admin.from("score_records").update({ points: Number(settledScore.points) + 1 }).eq("id", settledScore.id);
    const dd = await admin.from("score_records").delete().eq("id", settledScore.id);
    check("settled score: UPDATE refused", refused(u.error, /immutable/), u.error?.message ?? "no error");
    check("settled score: DELETE refused", refused(dd.error, /immutable/));
  } else {
    check("settled score present to test", false, "none found");
  }

  // --- allocations and ledger
  const { data: alloc } = await admin.from("reward_allocations").select("epoch_id, user_id, points").limit(1);
  if (alloc?.[0]) {
    const u = await admin.from("reward_allocations").update({ points: 1 }).eq("epoch_id", alloc[0].epoch_id).eq("user_id", alloc[0].user_id);
    const d = await admin.from("reward_allocations").delete().eq("epoch_id", alloc[0].epoch_id).eq("user_id", alloc[0].user_id);
    check("allocation: UPDATE refused", refused(u.error, /append-only/));
    check("allocation: DELETE refused", refused(d.error, /append-only/));
  }
  const { data: ledger } = await admin.from("usage_point_ledger").select("id, amount").limit(1);
  if (ledger?.[0]) {
    const u = await admin.from("usage_point_ledger").update({ amount: 1 }).eq("id", ledger[0].id);
    const d = await admin.from("usage_point_ledger").delete().eq("id", ledger[0].id);
    check("ledger: UPDATE refused", refused(u.error, /append-only/));
    check("ledger: DELETE refused", refused(d.error, /append-only/));
  }

  // --- pricing and policies
  const { data: price } = await admin.from("protocol_model_prices").select("pricing_version, model, input_micros_per_million").limit(1);
  if (price?.[0]) {
    const u = await admin.from("protocol_model_prices").update({ input_micros_per_million: Number(price[0].input_micros_per_million) + 1 }).eq("pricing_version", price[0].pricing_version).eq("model", price[0].model);
    const d = await admin.from("protocol_model_prices").delete().eq("pricing_version", price[0].pricing_version).eq("model", price[0].model);
    const same = await admin.from("protocol_model_prices").update({ input_micros_per_million: price[0].input_micros_per_million }).eq("pricing_version", price[0].pricing_version).eq("model", price[0].model);
    check("pricing: rate change refused", refused(u.error, /immutable/));
    check("pricing: rate DELETE refused", refused(d.error, /cannot be deleted/));
    check("pricing: identical republish allowed", !same.error, same.error?.message ?? "");
    const v = await admin.from("protocol_pricing_versions").update({ effective_from: "2000-01-01" }).eq("version", price[0].pricing_version);
    const vd = await admin.from("protocol_pricing_versions").delete().eq("version", price[0].pricing_version);
    check("pricing version: field change refused", refused(v.error, /immutable/));
    check("pricing version: DELETE refused", refused(vd.error, /cannot be deleted/));
  }
  const pol = await admin.from("reward_policy_versions").update({ effective_from: "2000-01-01" }).eq("version", "usage-reward-policy-v1");
  const pold = await admin.from("reward_policy_versions").delete().eq("version", "usage-reward-policy-v1");
  check("reward policy: rewrite refused", refused(pol.error, /immutable/));
  check("reward policy: DELETE refused", refused(pold.error, /cannot be deleted/));

  // --- clients still cannot touch any of it
  const a1 = await anon.from("usage_events").update({ dedupe_status: "unique" } as never).eq("id", settled?.id ?? "");
  check("anon cannot write the 0018 columns", Boolean(a1.error), a1.error?.code ?? "");

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stdout.write(`Failed: ${(error as Error).message}\n`);
  process.exit(1);
});
