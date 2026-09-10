import { createGatewayRoute } from "@/lib/gateway/handler";
import { protocolGateway } from "@/lib/compute/protocol-gateway";
import { fundingEvidenceForConnection } from "@/lib/protocol/funding";
import { createConnectionStore, ConnectionError } from "@/lib/providers/connections";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { SsrfError } from "@/lib/net/ssrf";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * The universal provider route.
 *
 * One route for every provider a user connects, rather than a new endpoint per
 * AI company. The connection id in the path selects a connection the SERVER
 * already validated and owns; the client never supplies a base URL, so it
 * cannot aim USAGE at an address of its choosing.
 *
 *   miner --(miner token)--> USAGE --(this user's stored credential)--> provider
 *                                  --> the same Proof of Usage pipeline
 *
 * Everything after the observation is identical to the built-in gateways. The
 * mining engine never learns which provider this was.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function openAiError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type, code: null, param: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const { POST, GET } = createGatewayRoute({
  clientType: "usage-miner",
  error: openAiError,

  async resolve({ userId, params }) {
    if (!isSupabaseConfigured()) {
      return openAiError(503, "api_error", "USAGE is not configured.");
    }

    const connectionId = String(params.connectionId ?? "");
    const store = createConnectionStore(createAdminSupabase());

    try {
      // Ownership, revocation, protocol and a fresh SSRF check all happen here.
      const resolved = await store.resolveForRequest(connectionId, userId);

      return {
        gateway: protocolGateway({
          protocol: resolved.protocol,
          connectionId,
          baseUrl: resolved.baseUrl,
          providerSlug: resolved.connection.provider,
          endpointTrusted: resolved.endpointTrusted,
          pathPrefix: resolved.pathPrefix,
          providerFamily: resolved.providerFamily,
          // What the provider told USAGE about this account when it was
          // connected. Nothing in the request can change it.
          funding: fundingEvidenceForConnection(resolved.connection),
        }),
        credential: resolved.credential,
        onOutcome: (outcome) => {
          void store.recordOutcome(connectionId, outcome).catch(() => undefined);
        },
      };
    } catch (error) {
      if (error instanceof ConnectionError) {
        // A connection that is not yours is indistinguishable from one that
        // does not exist, so probing for other users' ids reveals nothing.
        const status = error.code === "not_found" ? 404 : error.code === "revoked" ? 403 : 400;
        return openAiError(status, "invalid_request_error", error.message);
      }
      if (error instanceof SsrfError) {
        return openAiError(400, "invalid_request_error", error.message);
      }
      return openAiError(500, "api_error", "That connection could not be used.");
    }
  },
});
