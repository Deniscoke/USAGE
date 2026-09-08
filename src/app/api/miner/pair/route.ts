import type { NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createPairingStore } from "@/lib/miner/pairing";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * Device pairing, from the miner's side.
 *
 *   POST  start an attempt, get a code to show the user and a poll token
 *   GET   poll with that token until the user approves
 *
 * Deliberately unauthenticated: nothing owns a pairing request until a
 * signed-in user approves it in a browser. What stops abuse is that an
 * unapproved request grants nothing, codes expire in ten minutes, and both
 * endpoints are rate limited.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Coarse per-IP limiting. A pairing attempt is a human action, not a loop. */
function limitKey(request: NextRequest, prefix: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${prefix}:${forwarded ?? "unknown"}`;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return json({ error: "unavailable" }, 503);
  if (!checkRateLimit(limitKey(request, "pair-start"), 10).allowed) {
    return json({ error: "rate_limited" }, 429);
  }

  let body: { deviceName?: unknown; platform?: unknown; appVersion?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const store = createPairingStore(createAdminSupabase());
  const started = await store.start({
    deviceName: typeof body.deviceName === "string" ? body.deviceName : "Unnamed device",
    platform: typeof body.platform === "string" ? body.platform : "unknown",
    appVersion: typeof body.appVersion === "string" ? body.appVersion : "0.0.0",
  });

  const origin = request.nextUrl.origin;
  return json({
    userCode: started.userCode,
    pollToken: started.pollToken,
    expiresAt: started.expiresAt,
    // Where to send the user. Includes the code so approving is one click.
    verificationUrl: `${origin}/pair?code=${encodeURIComponent(started.userCode)}`,
    verificationUrlPlain: `${origin}/pair`,
  });
}

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) return json({ error: "unavailable" }, 503);

  const pollToken = request.nextUrl.searchParams.get("poll_token");
  if (!pollToken) return json({ error: "invalid_request" }, 400);

  // Polling is bounded so a miner cannot hammer this while it waits.
  if (!checkRateLimit(`pair-poll:${pollToken.slice(0, 16)}`, 60).allowed) {
    return json({ error: "rate_limited" }, 429);
  }

  const store = createPairingStore(createAdminSupabase());
  const state = await store.collect(pollToken);

  if (state.status !== "approved") return json({ status: state.status });

  // The credential is returned exactly once, to the holder of the poll token.
  return json({
    status: "approved",
    token: state.token,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
  });
}
