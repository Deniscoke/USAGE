import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { describeTool } from "@/lib/miner/tools";

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
  // Scope checked even though every device currently has it: the check is
  // what makes a narrower credential possible later without auditing routes.
  if (!hasScope(auth.identity, "miner:heartbeat")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  // One heartbeat a minute is plenty; this is not a telemetry stream.
  if (!checkRateLimit(`heartbeat:${auth.identity.credentialId}`, 10).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { enabledTools?: unknown; tools?: unknown; os?: unknown; minerVersion?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  // v2: per-tool safe state. Each entry is validated field by field and
  // truncated; anything that is not a known tool id is dropped. There is no
  // slot for a path, a username or a process, so none can arrive.
  const toolState = Array.isArray(body.tools)
    ? body.tools
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
        .map((t) => ({
          tool: typeof t.tool === "string" ? t.tool.slice(0, 40) : "",
          version: typeof t.version === "string" ? t.version.slice(0, 40) : null,
          detected: t.detected === true,
          mapped: t.mapped === true,
        }))
        .filter((t) => describeTool(t.tool) !== null)
        .slice(0, 10)
    : [];

  // v1 fallback, and the summary column either way.
  const enabledTools =
    toolState.length > 0
      ? toolState.filter((t) => t.mapped).map((t) => t.tool)
      : Array.isArray(body.enabledTools)
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
      .update({
        last_seen_at: new Date().toISOString(),
        enabled_tools: enabledTools,
        tool_state: toolState,
        os: typeof body.os === "string" ? body.os.slice(0, 60) : undefined,
        app_version: typeof body.minerVersion === "string" ? body.minerVersion.slice(0, 20) : undefined,
      })
      .eq("id", credential.device_id)
      .is("revoked_at", null);
  }

  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
