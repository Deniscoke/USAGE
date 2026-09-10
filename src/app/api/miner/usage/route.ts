import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { requireLiveDevice } from "@/lib/miner/devices";
import { summarizeUsage } from "@/lib/miner/usage-summary";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { LocalUsageObservationRow, UsageEventRow } from "@/lib/supabase/database.types";

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
  const [{ data: observations }, { data: events }] = await Promise.all([
    // THIS device's observations: the window describes the computer it runs
    // on, exactly as the website's card for that device does.
    admin
      .from("local_usage_observations")
      .select("*")
      .eq("user_id", auth.identity.userId)
      .eq("device_id", device.device.id)
      .gte("occurred_at", since),
    admin.from("usage_events").select("*").eq("user_id", auth.identity.userId).gte("occurred_at", since),
  ]);

  const summary = summarizeUsage({
    day,
    observations: (observations ?? []) as LocalUsageObservationRow[],
    events: (events ?? []) as UsageEventRow[],
  });

  return Response.json(
    {
      day: summary.day,
      trackedTokens: summary.trackedTokens,
      verifiedTokens: summary.verifiedTokens,
      eligibleComputeMicros: summary.eligibleComputeMicros,
      // Not computed here: the epoch estimate needs the whole network's score
      // and belongs to the dashboard pipeline. Null is honest.
      estimatedPoints: null,
      recent: summary.recent.slice(0, 10).map((r) => ({ tool: r.tool, tokens: r.tokens, status: r.status, at: r.at })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
