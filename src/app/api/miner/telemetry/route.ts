import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { requireLiveDevice } from "@/lib/miner/devices";
import { ingestLocalObservations } from "@/lib/miner/telemetry-ingest";
import { TELEMETRY_LIMITS } from "@/lib/miner/telemetry";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * Normalized local observations arrive here.
 *
 * What this route enforces, in order: a live scoped credential; a live,
 * unrevoked device owned by that credential's user; a body under the size
 * cap; a batch under the count cap; a schema this server accepts; a mapping
 * that is ENABLED for each observation's tool on this device. Then, per item:
 * strict validation, signature verification against the device's registered
 * key, dedupe on (device, local_event_id), and exact correlation.
 *
 * What it can never do: write a usage_event, a score, a point, or a price.
 * The ingestion function it calls has no such code path, and the table the
 * observations land in has no such column.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const auth = await authenticateMiner(readPresentedToken(request.headers), createSupabaseMinerStore(admin));
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });
  if (!hasScope(auth.identity, "miner:telemetry")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  // Claude Code exports every few seconds; this is generous for a human and
  // tight for a flood.
  if (!checkRateLimit(`telemetry:${auth.identity.credentialId}`, 60).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const device = await requireLiveDevice(admin, auth.identity);
  if (!device.ok) return Response.json({ error: device.reason }, { status: device.reason === "revoked" ? 403 : 404 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > TELEMETRY_LIMITS.maxBodyBytes) return Response.json({ error: "too_large" }, { status: 413 });
  const raw = await request.text();
  if (raw.length > TELEMETRY_LIMITS.maxBodyBytes) return Response.json({ error: "too_large" }, { status: 413 });

  let body: { schema?: unknown; observations?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (body.schema !== "local-usage-observation-v1") {
    return Response.json({ error: "unsupported_schema", accepted: ["local-usage-observation-v1"] }, { status: 400 });
  }
  if (!Array.isArray(body.observations)) return Response.json({ error: "bad_batch" }, { status: 400 });
  if (body.observations.length > TELEMETRY_LIMITS.maxObservationsPerBatch) {
    return Response.json({ error: "batch_too_large", max: TELEMETRY_LIMITS.maxObservationsPerBatch }, { status: 413 });
  }

  const result = await ingestLocalObservations(admin, {
    userId: auth.identity.userId,
    device: device.device,
    items: body.observations,
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
