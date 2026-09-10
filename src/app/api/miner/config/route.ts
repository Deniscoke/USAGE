import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createConnectionStore } from "@/lib/providers/connections";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { CURRENT_MINING_PROTOCOL } from "@/lib/protocol/emission";
import { MINING_ELIGIBILITY_COPY } from "@/lib/protocols/protocol";
// One source of truth for what build the server expects: a device that is told
// it is current here and out of date on the download page would be a bug.
import { MINER_PROTOCOL_VERSION, MINIMUM_MINER_VERSION } from "@/lib/miner/release";
import { requireLiveDevice } from "@/lib/miner/devices";
import { accountDisplay, networkLabel } from "@/lib/miner/identity";

/**
 * What a paired device needs to route requests, and nothing more.
 *
 * WHAT THIS RETURNS: which endpoint to send a tool's traffic to, which of the
 * user's connections are usable, and what protocol each expects. All of it is
 * non-secret routing information.
 *
 * WHAT IT NEVER RETURNS: a provider API key, an OpenRouter key, a Supabase
 * secret, a gateway key, or the receipt signing key. The device holds exactly
 * one credential -- its own scoped miner token -- and the provider credential
 * stays on the server, which is the entire point of routing through USAGE.
 *
 * It is also DECLARATIVE. There is no field here that tells a device to run
 * anything; tool adapters ship with the miner and are not remotely steerable.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const auth = await authenticateMiner(
    readPresentedToken(request.headers),
    createSupabaseMinerStore(admin),
  );
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });
  // Scope checked even though every device currently has it: the check is
  // what makes a narrower credential possible later without auditing routes.
  if (!hasScope(auth.identity, "miner:config")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  if (!checkRateLimit(`config:${auth.identity.credentialId}`, 30).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const origin = request.nextUrl.origin;

  // The device this credential belongs to, and what the SERVER says about
  // its mappings. The desktop window displays this, never its own memory:
  // a mapping that exists only on the device is a mapping that meters nothing.
  const device = await requireLiveDevice(admin, auth.identity);
  if (!device.ok) return Response.json({ error: device.reason }, { status: device.reason === "revoked" ? 403 : 404 });
  const [{ data: mappingRows }, { data: userData }] = await Promise.all([
    admin
      .from("miner_tool_mappings")
      .select("tool_id, status, last_event_at, updated_at")
      .eq("device_id", device.device.id)
      .eq("user_id", auth.identity.userId),
    admin.auth.admin.getUserById(auth.identity.userId),
  ]);

  const connections = await createConnectionStore(admin).list(auth.identity.userId);

  // Only connections that can actually carry traffic today.
  const usable = connections.filter(
    (connection) =>
      connection.revokedAt === null &&
      connection.protocol !== null &&
      ["active", "limited", "pending_pricing"].includes(connection.status),
  );

  const routes = usable.map((connection) => ({
    connectionId: connection.id,
    label: connection.displayName,
    protocol: connection.protocol,
    url: `${origin}/api/gateway/provider/${connection.id}`,
    miningEligibility: connection.miningEligibility,
    miningLabel: MINING_ELIGIBILITY_COPY[connection.miningEligibility].label,
  }));

  /**
   * Which route suits which tool.
   *
   * A tool speaks one wire format, so it can only use a connection whose
   * protocol matches. Claude Code additionally falls back to USAGE's own
   * Anthropic surface when the user has connected nothing Anthropic-shaped --
   * that traffic is proven but USAGE-funded, so it is held rather than earning,
   * and the miner is told that up front rather than discovering it later.
   */
  const anthropicRoutes = routes.filter((route) => route.protocol === "anthropic_compatible");
  const openAiRoutes = routes.filter((route) => route.protocol === "openai_compatible");

  return Response.json(
    {
      protocolVersion: MINER_PROTOCOL_VERSION,
      minimumMinerVersion: MINIMUM_MINER_VERSION,
      updateRequired: false,
      // The account is a person; the device is a computer. They are shown
      // apart, and the account identity is a safe display form -- never the
      // full email, which the device has no need to hold.
      account: { label: auth.identity.name, display: accountDisplay(userData?.user?.email ?? null) },
      device: { id: device.device.id, name: device.device.name },
      mappings: (mappingRows ?? []).map((m) => ({
        tool: m.tool_id,
        status: m.status,
        lastEventAt: m.last_event_at,
        updatedAt: m.updated_at,
      })),
      mining: {
        network: CURRENT_MINING_PROTOCOL.network,
        networkLabel: networkLabel(CURRENT_MINING_PROTOCOL.network),
        scoringVersion: CURRENT_MINING_PROTOCOL.scoringVersion,
      },
      routes,
      tools: {
        "claude-code": {
          protocol: "anthropic_compatible",
          routes: anthropicRoutes,
          fallback: {
            label: "USAGE gateway",
            url: `${origin}/api/gateway/anthropic`,
            miningEligibility: "held",
            note: "USAGE's own gateway credit pays for this, so it is proven but does not earn.",
          },
        },
        codex: {
          protocol: "openai_compatible",
          routes: openAiRoutes,
          fallback: null,
        },
      },
      privacy: {
        recorded: ["model", "token_counts", "timestamps"],
        neverRecorded: ["prompts", "responses", "tool_arguments", "source_code"],
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
