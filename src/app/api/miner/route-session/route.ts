import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createConnectionStore } from "@/lib/providers/connections";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { requireLiveDevice } from "@/lib/miner/devices";
import { buildMinerRoutes } from "@/lib/miner/routes";
import { mintRouteSessionToken, ROUTE_SESSION_TTL_SECONDS, routeSessionsAvailable } from "@/lib/miner/route-session";
import { SURFACE_LABELS } from "@/lib/providers/surfaces";

/**
 * Mint a route session (M16C0 §10).
 *
 * A paired device asks for a short-lived credential bound to one tool, one of
 * its owner's connections and one wire surface. The response carries that
 * token and the non-secret facts the miner shows before launch ("Selected
 * route: OpenRouter · Reward: ELIGIBLE · Wire: Anthropic-compatible"). It
 * never carries a provider credential, and the token itself is not one.
 *
 * Minting requires the DEVICE credential: a route session cannot mint another
 * (it lacks `miner:config`, and its binding is refused here outright).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_TOOLS: ReadonlySet<string> = new Set(["claude-code", "codex"]);

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });
  if (!routeSessionsAvailable()) return Response.json({ error: "route_sessions_unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const auth = await authenticateMiner(readPresentedToken(request.headers), createSupabaseMinerStore(admin));
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });
  if (auth.identity.routeSession) return Response.json({ error: "insufficient_scope" }, { status: 403 });
  if (!hasScope(auth.identity, "miner:route") || !hasScope(auth.identity, "miner:config")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (!checkRateLimit(`route-session:${auth.identity.credentialId}`, 30).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { tool?: unknown; connectionId?: unknown; surface?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "malformed" }, { status: 400 });
  }
  const tool = typeof body.tool === "string" ? body.tool : "";
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const surface = body.surface === "anthropic_compatible" || body.surface === "openai_compatible" ? body.surface : null;
  if (!SUPPORTED_TOOLS.has(tool) || !connectionId || !surface) {
    return Response.json({ error: "malformed" }, { status: 400 });
  }

  const device = await requireLiveDevice(admin, auth.identity);
  if (!device.ok) return Response.json({ error: device.reason }, { status: device.reason === "revoked" ? 403 : 404 });

  // The connection must be the caller's, usable today, and advertise the
  // requested surface. Anything else is "no such route".
  const origin = request.nextUrl.origin;
  const connections = await createConnectionStore(admin).list(auth.identity.userId);
  const route = buildMinerRoutes(connections, origin).find(
    (entry) => entry.connectionId === connectionId && entry.surface === surface,
  );
  if (!route) return Response.json({ error: "no_such_route" }, { status: 404 });

  const minted = mintRouteSessionToken({
    credentialId: auth.identity.credentialId,
    userId: auth.identity.userId,
    deviceId: device.device.id,
    tool,
    connectionId,
    surface,
  });
  if (!minted) return Response.json({ error: "route_sessions_unavailable" }, { status: 503 });

  return Response.json(
    {
      token: minted.token,
      expiresAt: minted.expiresAt,
      ttlSeconds: ROUTE_SESSION_TTL_SECONDS,
      tool,
      connectionId,
      surface,
      wire: SURFACE_LABELS[surface],
      url: route.url,
      label: route.label,
      providerFamily: route.providerFamily,
      rewardStatus: route.rewardStatus,
      miningLabel: route.miningLabel,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
