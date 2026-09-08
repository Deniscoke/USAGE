import { anthropicError } from "@/lib/gateway/anthropic";
import { createGatewayRoute } from "@/lib/gateway/handler";
import { vercelComputeGateway } from "@/lib/compute/vercel-gateway";

/**
 * USAGE Gateway — Anthropic-compatible surface.
 *
 * Claude Code points ANTHROPIC_BASE_URL here; the shared handler carries the
 * trust boundary and this file only says which gateway and which error shape.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { POST, GET } = createGatewayRoute({
  gateway: vercelComputeGateway,
  credential: () => process.env.AI_GATEWAY_API_KEY?.trim() || null,
  clientType: "claude-code",
  error: anthropicError,
});
