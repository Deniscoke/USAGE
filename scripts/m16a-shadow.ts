/**
 * M16A — SHADOW / NON-BINDING mining-beta-v2 computation.
 *
 *   npm run usage:m16a:shadow [-- --epoch epoch-2026-09-14]
 *
 * Reads eligible units for the epoch from production (read-only), adds the
 * documented fixture set, and shows what mining-beta-v2 WOULD produce:
 * network pico, effective pool, per-user score, share and estimated
 * allocation. Writes nothing: no score rows, no allocations, no ledger, no
 * event status. Every line is SHADOW / NON-BINDING.
 *
 * Also checks that the code schedule agrees with the persisted
 * mining_protocol_versions rows (the authority at settlement).
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { MINING_BETA_V2_PARAMETERS, planV2Settlement, previewEffectivePoolFractional, type V2Participant } from "../src/lib/domain/tokenomics/settlement-v2";
import { CODE_SCHEDULE, protocolForEpoch, scheduleFromRows } from "../src/lib/protocol/schedule";

const line = (t = "") => process.stdout.write(`${t}\n`);
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const USD = 1_000_000_000_000n;

async function main(): Promise<number> {
  const epochId = flag("epoch") ?? "epoch-2026-09-14";
  line(`SHADOW / NON-BINDING — mining-beta-v2 for ${epochId}`);
  line("  Nothing below is written anywhere. Parameters: linear usage_score_v2, cap 100,000, B = $1,000/day (10^15 pico), F = 0, never minted.");
  line();

  let production: V2Participant[] = [];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && secret) {
    const admin = createClient<Database>(url, secret, { auth: { persistSession: false } });
    const raw = admin as unknown as ReturnType<typeof createClient>;
    const { data: rows } = await raw.from("mining_protocol_versions").select("version, status, role, effective_from_epoch, effective_from, scoring_version, pricing_version, epoch_emission_points, emission_algorithm, baseline_compute_pico, floor_points, undistributed_policy, claimable, network");
    const dbSchedule = scheduleFromRows((rows ?? []) as Parameters<typeof scheduleFromRows>[0]);
    const codeGov = protocolForEpoch(epochId, CODE_SCHEDULE);
    const dbGov = protocolForEpoch(epochId, dbSchedule);
    line(`  governing protocol  code: ${codeGov.version} (${codeGov.status})   database: ${dbGov.version} (${dbGov.status})${codeGov.version === dbGov.version ? "" : "   <-- DISAGREE: activation package not deployed or schedule not applied"}`);
    const { data: units } = await raw.from("usage_events").select("user_id, eligible_compute_pico, reward_status, economic_status, protocol_pricing_version, pricing_components_pending").eq("epoch_id", epochId).eq("reward_status", "eligible");
    const byUser = new Map<string, bigint>();
    let withoutPico = 0;
    for (const u of (units ?? []) as { user_id: string; eligible_compute_pico: string | null }[]) {
      if (u.eligible_compute_pico === null) { withoutPico += 1; continue; }
      byUser.set(u.user_id, (byUser.get(u.user_id) ?? 0n) + BigInt(u.eligible_compute_pico));
    }
    production = [...byUser].map(([userId, eligiblePico]) => ({ userId, eligiblePico }));
    line(`  production eligible units in ${epochId}: ${(units ?? []).length} (${withoutPico} without exact pico, which a v2 settlement would refuse)`);
  } else {
    line("  (no Supabase configuration: production read skipped)");
  }

  const fixtures: V2Participant[] = [
    { userId: "fixture:alice", eligiblePico: 300n * USD },
    { userId: "fixture:bob", eligiblePico: 200n * USD },
    { userId: "fixture:carol", eligiblePico: USD / 3n },
  ];

  for (const [label, participants] of [["PRODUCTION ONLY", production], ["PRODUCTION + FIXTURES", [...production, ...fixtures]]] as const) {
    const plan = planV2Settlement(participants, MINING_BETA_V2_PARAMETERS);
    line();
    line(`  ${label} — SHADOW / NON-BINDING`);
    line(`    network eligible pico     ${plan.networkPico} (${(Number(plan.networkPico / 1_000_000n) / 1_000_000).toFixed(6)} USD)`);
    line(`    baseline progress         ${((Number(plan.networkPico / 1_000_000n) / 1_000_000 / 1000) * 100).toFixed(4)} % of $1,000`);
    line(`    effective pool            ${plan.effectivePoints} of ${plan.scheduledPoints} (preview ${previewEffectivePoolFractional(plan.networkPico)}); never minted: ${plan.undistributedPoints}`);
    for (const a of plan.allocations) {
      const share = plan.networkPico > 0n ? Number((a.score * 1_000_000n) / plan.networkPico) / 10_000 : 0;
      line(`    ${a.userId.padEnd(40)} score ${a.score.toString().padStart(20)} pico  share ${share.toFixed(4)} %  estimated ${a.points} points`);
    }
    if (plan.allocations.length === 0) line("    (no participants)");
  }
  line();
  line("  SHADOW / NON-BINDING. No production write occurred.");
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => { line(`Failed: ${(e as Error).message}`); process.exit(1); });
