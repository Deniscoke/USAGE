import { createGatewayRoute } from "@/lib/gateway/handler";
import { anthropicError } from "@/lib/gateway/anthropic";
import { protocolGateway } from "@/lib/compute/protocol-gateway";
import { anthropicCompatibleProtocol } from "@/lib/protocols/anthropic-compatible";
import { fundingEvidenceForConnection } from "@/lib/protocol/funding";
import { createConnectionStore, ConnectionError } from "@/lib/providers/connections";
import { wireSurfacesFor } from "@/lib/providers/surfaces";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { SsrfError } from "@/lib/net/ssrf";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * The Anthropic-compatible surface of a provider connection (M16C0).
 *
 * Claude Code speaks the Anthropic Messages format and nothing else. A
 * connection stored as OpenAI-compatible -- the owner's OpenRouter OAuth
 * connection -- could therefore never carry it, and Claude Code fell back to
 * USAGE's own held gateway. OpenRouter answers the Anthropic format at the
 * same base URL with the same credential, so this route exposes that surface
 * for the SAME connection: same row, same server-held secret, same
 * `connection:<id>` gateway id, same funding context, same reward verdict.
 *
 *   Claude Code --(route session)--> USAGE --(stored OpenRouter key)--> openrouter.ai/api/v1/messages
 *
 * Only a connection whose provider family is documented to answer on both
 * surfaces resolves here; everything else is 404, indistinguishable from a
 * connection that does not exist. The privacy baseline (zdr, data_collection
 * deny) is written into every body by the protocol, exactly as on the
 * OpenAI-compatible surface. Everything after the observation is the same
 * Proof of Usage pipeline.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { POST, GET } = createGatewayRoute({
  clientType: "usage-miner",
  error: anthropicError,
  surface: "anthropic_compatible",

  async resolve({ userId, params }) {
    if (!isSupabaseConfigured()) {
      return anthropicError(503, "api_error", "USAGE is not configured.");
    }

    const connectionId = String(params.connectionId ?? "");
    const store = createConnectionStore(createAdminSupabase());

    try {
      const resolved = await store.resolveForRequest(connectionId, userId);
      const surfaces = wireSurfacesFor({
        provider: resolved.connection.provider,
        providerFamily: resolved.providerFamily,
        protocol: resolved.connection.protocol,
      });
      if (!surfaces.includes("anthropic_compatible")) {
        return anthropicError(404, "not_found_error", "No such connection.");
      }

      return {
        gateway: protocolGateway({
          protocol: anthropicCompatibleProtocol,
          connectionId,
          baseUrl: resolved.baseUrl,
          providerSlug: resolved.connection.provider,
          endpointTrusted: resolved.endpointTrusted,
          pathPrefix: resolved.pathPrefix,
          providerFamily: resolved.providerFamily,
          funding: fundingEvidenceForConnection(resolved.connection),
        }),
        credential: resolved.credential,
        onOutcome: (outcome) => {
          void store.recordOutcome(connectionId, outcome).catch(() => undefined);
        },
      };
    } catch (error) {
      if (error instanceof ConnectionError) {
        const status = error.code === "not_found" ? 404 : error.code === "revoked" ? 403 : 400;
        return anthropicError(status, "invalid_request_error", error.message);
      }
      if (error instanceof SsrfError) {
        return anthropicError(400, "invalid_request_error", error.message);
      }
      return anthropicError(500, "api_error", "That connection could not be used.");
    }
  },
});
