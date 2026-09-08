import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * Liveness, and the tools a device says it has enabled.
 *
 * The reported tool list is DISPLAY ONLY. A miner cannot assert usage, and it
 * cannot assert anything economic here either -- the worst a lying device can
 * do is mislabel itself in its owner's own device list.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const auth = await authenticateMiner(
    readPresentedToken(request.headers),
    createSupabaseMinerStore(admin),
  );
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });

  // One heartbeat a minute is plenty; this is not a telemetry stream.
  if (!checkRateLimit(`heartbeat:${auth.identity.credentialId}`, 10).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { enabledTools?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const enabledTools = Array.isArray(body.enabledTools)
    ? body.enabledTools.filter((tool): tool is string => typeof tool === "string").slice(0, 10)
    : [];

  const { data: credential } = await admin
    .from("usage_miner_credentials")
    .select("device_id")
    .eq("id", auth.identity.credentialId)
    .maybeSingle();

  if (credential?.device_id) {
    await admin
      .from("miner_devices")
      .update({ last_seen_at: new Date().toISOString(), enabled_tools: enabledTools })
      .eq("id", credential.device_id)
      .is("revoked_at", null);
  }

  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
