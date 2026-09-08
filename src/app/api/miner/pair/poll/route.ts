import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createPairingStore } from "@/lib/miner/pairing";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * Collect a paired credential.
 *
 * POST with the token in a JSON body, deliberately, not GET with it in a query
 * string. The poll token IS a credential -- whoever holds it receives the miner
 * token -- and a query string is written to server access logs, proxy logs and
 * CDN logs, none of which are meant to hold secrets. A request body is not.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return json({ error: "unavailable" }, 503);

  let body: { pollToken?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const pollToken = typeof body.pollToken === "string" ? body.pollToken : null;
  if (!pollToken) return json({ error: "invalid_request" }, 400);

  // Keyed by a hash, so the limiter's own map never holds the credential.
  const limitKey = createHash("sha256").update(pollToken).digest("hex").slice(0, 32);
  if (!checkRateLimit(`pair-poll:${limitKey}`, 60).allowed) {
    return json({ error: "rate_limited" }, 429);
  }

  const store = createPairingStore(createAdminSupabase());
  const state = await store.collect(pollToken);

  if (state.status !== "approved") return json({ status: state.status });

  // Returned exactly once, to the holder of the poll token.
  return json({
    status: "approved",
    token: state.token,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
  });
}
