import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { requireLiveDevice } from "@/lib/miner/devices";
import { summarizeUsage, trackedByTool } from "@/lib/miner/usage-summary";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { LocalUsageObservationRow, UsageEventRow } from "@/lib/supabase/database.types";
import { minerPointsView } from "@/lib/miner/points";
import { protocolForEpoch } from "@/lib/protocol/schedule";

/**
 * Today's figures for the desktop window, computed by the server.
 *
 * The device never adds up its own numbers. It asks, and it displays what it
 * is told -- which is the same function the website uses, so the two cannot
 * disagree, and so a device cannot show its owner a "verified" total the
 * server would not stand behind.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const auth = await authenticateMiner(readPresentedToken(request.headers), createSupabaseMinerStore(admin));
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });
  if (!hasScope(auth.identity, "miner:config")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (!checkRateLimit(`usage:${auth.identity.credentialId}`, 30).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  const device = await requireLiveDevice(admin, auth.identity);
  if (!device.ok) return Response.json({ error: device.reason }, { status: device.reason === "revoked" ? 403 : 404 });

  const day = new Date().toISOString().slice(0, 10);
  const since = `${day}T00:00:00Z`;
  const epochId = `epoch-${day}`;
  const todayProtocol = protocolForEpoch(epochId);

  const [{ data: observations }, { data: events }, { data: ledgerRows }, { data: scoreRow }, { data: networkRow }, { data: epochRow }] = await Promise.all([
    // THIS device's observations: the window describes the computer it runs
    // on, exactly as the website's card for that device does.
    admin
      .from("local_usage_observations")
      .select("*")
      .eq("user_id", auth.identity.userId)
      .eq("device_id", device.device.id)
      .gte("occurred_at", since),
    // THIS device's routed requests only. Every credential this device has
    // held (rotation issues new ones), matched on the id the gateway signs into
    // each receipt. It used to be the whole account, so a request made from
    // another computer, or from chat on the website, showed up as "this PC".
    admin
      .from("usage_miner_credentials")
      .select("id")
      .eq("device_id", device.device.id)
      .then(async ({ data: credentials }) => {
        const ids = ((credentials ?? []) as { id: string }[]).map((row) => row.id);
        if (ids.length === 0) return { data: [] as UsageEventRow[] };
        return admin
          .from("usage_events")
          .select("*")
          .eq("user_id", auth.identity.userId)
          .gte("occurred_at", since)
          .in("raw_metadata->>miner_credential_id", ids);
      }),
    // Points: the settled ledger for the whole account, and today's score and
    // network total under the scoring version that governs today's epoch.
    admin.from("usage_point_ledger").select("epoch_id, amount, created_at").eq("user_id", auth.identity.userId),
    admin
      .from("score_records")
      .select("points")
      .eq("user_id", auth.identity.userId)
      .eq("day", day)
      .eq("algorithm_version", todayProtocol.scoringVersion)
      .maybeSingle(),
    admin
      .from("epoch_network_totals")
      .select("network_score")
      .eq("day", day)
      .eq("algorithm_version", todayProtocol.scoringVersion)
      .maybeSingle(),
    admin.from("reward_epochs").select("state").eq("id", epochId).maybeSingle(),
  ]);

  const points = minerPointsView({
    ledger: ((ledgerRows ?? []) as { epoch_id: string; amount: number; created_at: string }[]).map((row) => ({
      epochId: row.epoch_id,
      amount: Number(row.amount),
      createdAt: row.created_at,
    })),
    userScoreToday: Number((scoreRow as { points?: number | string } | null)?.points ?? 0),
    networkScoreToday: Number((networkRow as { network_score?: number | string } | null)?.network_score ?? 0),
    todayProtocol,
    // An epoch nobody has closed is open.
    todayEpochOpen: ((epochRow as { state?: string } | null)?.state ?? "open") === "open",
  });

  const usageInput = {
    day,
    observations: (observations ?? []) as LocalUsageObservationRow[],
    events: (events ?? []) as UsageEventRow[],
  };
  const summary = summarizeUsage(usageInput);
  // Per tool, same rules, same rows: the values add up to `tracked`.
  const byTool = trackedByTool(usageInput);

  return Response.json(
    {
      day: summary.day,
      trackedTokens: summary.trackedTokens,
      verifiedTokens: summary.verifiedTokens,
      // Every category, apart. The device displays; it never adds these up
      // into a figure the server did not produce.
      tracked: summary.tracked,
      verified: summary.verified,
      eligibleComputeMicros: summary.eligibleComputeMicros,
      // Today's open epoch, estimated with the dashboard's arithmetic, including
      // beta-v2's scaled pool. It was hard-coded null, which left the window's
      // USAGE tile empty on every day, mining or not.
      estimatedPoints: points.estimatedPoints,
      // Settled and final. Older windows ignore these fields; newer ones show them.
      balancePoints: points.balance,
      lastCredit: points.lastCredit,
      protocolVersion: todayProtocol.version,
      recent: summary.recent.slice(0, 10).map((r) => ({ tool: r.tool, model: r.model, tokens: r.tokens, breakdown: r.breakdown, status: r.status, at: r.at })),
      // Today's tracked breakdown for THIS device, per tool id (M17B, miner
      // 0.4.8+). Token categories and a request count only; a tool with no
      // usage today has no key. Older windows ignore it.
      byTool,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
