import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { requireLiveDevice } from "@/lib/miner/devices";
import { describeTool, meteringMethodFor } from "@/lib/miner/tools";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * A device asks to meter a tool, or to stop.
 *
 * The device supplies exactly two facts it is entitled to: which tool, and
 * whether the user opted in. It may also say which version it found, which
 * is display information. Everything with trust in it -- the metering method,
 * the verification ceiling -- is looked up in the server's own registry and
 * written from there. A body carrying those fields is not honoured; it is
 * not even read.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const auth = await authenticateMiner(readPresentedToken(request.headers), createSupabaseMinerStore(admin));
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });
  if (!hasScope(auth.identity, "miner:mappings")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (!checkRateLimit(`mappings:${auth.identity.credentialId}`, 30).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const device = await requireLiveDevice(admin, auth.identity);
  if (!device.ok) return Response.json({ error: device.reason }, { status: device.reason === "revoked" ? 403 : 404 });

  let body: { tool?: unknown; enabled?: unknown; toolVersion?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const toolId = typeof body.tool === "string" ? body.tool.slice(0, 40) : "";
  const tool = describeTool(toolId);
  if (!tool) return Response.json({ error: "unknown_tool" }, { status: 400 });
  if (tool.meteringMethods.includes("unsupported")) {
    return Response.json({ error: "not_meterable", note: tool.availabilityNote }, { status: 400 });
  }
  const enabled = body.enabled === true;
  const toolVersion = typeof body.toolVersion === "string" ? body.toolVersion.slice(0, 40) : null;
  const now = new Date().toISOString();

  const { data: row, error } = await admin
    .from("miner_tool_mappings")
    .upsert(
      {
        device_id: device.device.id,
        user_id: auth.identity.userId,
        tool_id: tool.id,
        tool_version: toolVersion,
        metering_method: meteringMethodFor(tool),
        verification_capability: tool.verificationCapability,
        status: enabled ? "enabled" : "disabled",
        enabled_at: now,
        disabled_at: enabled ? null : now,
        updated_at: now,
      },
      { onConflict: "device_id,tool_id" },
    )
    .select("tool_id, status, metering_method, verification_capability")
    .single();
  if (error || !row) return Response.json({ error: "store" }, { status: 500 });

  // Keep the device's summary column in step, so the device list needs no join.
  const mapped = new Set(device.device.enabled_tools);
  if (enabled) mapped.add(tool.id);
  else mapped.delete(tool.id);
  await admin
    .from("miner_devices")
    .update({ enabled_tools: [...mapped], last_seen_at: now })
    .eq("id", device.device.id);

  return Response.json(
    {
      tool: row.tool_id,
      status: row.status,
      meteringMethod: row.metering_method,
      verificationCapability: row.verification_capability,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
