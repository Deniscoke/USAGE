import { createGatewayRoute } from "@/lib/gateway/handler";
import { resolveConnectionGateway } from "@/lib/gateway/connection-gateway";

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
  // The stored protocol's surface. A route session minted for the Anthropic
  // surface of the same connection is refused here, and vice versa.
  surface: "openai_compatible",

  // Shared with the web chat, which is the same trust boundary with a
  // different front door.
  resolve: ({ userId, params }) =>
    resolveConnectionGateway({ connectionId: String(params.connectionId ?? ""), userId, error: openAiError }),
});
