import { createGatewayRoute } from "@/lib/gateway/handler";
import { openRouterComputeGateway } from "@/lib/compute/openrouter-gateway";
import { gatewayCredential } from "@/lib/compute/registry";

/**
 * USAGE Gateway — OpenAI-compatible surface, routed through OpenRouter.
 *
 * The second real gateway, sharing every line of the trust boundary with the
 * first. Same miner authentication, same signing, same ingestion, same score.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OpenAI-shaped error, so an OpenAI-compatible client sees a protocol it knows. */
function openAiError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type, code: null, param: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const { POST, GET } = createGatewayRoute({
  gateway: openRouterComputeGateway,
  credential: () => gatewayCredential("openrouter"),
  clientType: "openrouter-miner",
  error: openAiError,
});
