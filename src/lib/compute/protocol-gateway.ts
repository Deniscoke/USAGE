import type { ComputeGateway, GatewayRequest, UpstreamCall } from "./gateway";
import type { ProviderProtocol } from "@/lib/protocols/protocol";

/**
 * A user's provider connection, presented as a ComputeGateway.
 *
 * This is the join that makes "connect any AI provider" work without touching
 * the mining engine: a protocol plus a validated connection becomes an ordinary
 * gateway, and everything downstream -- observation, receipt, signature,
 * pricing, score, epoch, points -- runs exactly as it does for Vercel or
 * OpenRouter. The mining code cannot tell the difference, and that is the whole
 * design goal.
 *
 * The base URL comes from the stored, validated connection, never from the
 * request. The gateway id is `connection:<id>` so a proof records which
 * connection executed it, and two users connecting the same provider still
 * produce distinguishable evidence.
 */

export const CONNECTION_GATEWAY_PREFIX = "connection:";

export function connectionGatewayId(connectionId: string): string {
  return `${CONNECTION_GATEWAY_PREFIX}${connectionId}`;
}

export function protocolGateway(input: {
  protocol: ProviderProtocol;
  connectionId: string;
  /** Validated at connection time and re-validated per request. */
  baseUrl: string;
  /** Registry family when known, else the connection's own slug. */
  providerSlug: string;
}): ComputeGateway {
  const { protocol, baseUrl } = input;
  const id = connectionGatewayId(input.connectionId);

  return {
    id,
    providerSlug: input.providerSlug,

    buildUpstreamCall(request: GatewayRequest, credential: string): UpstreamCall {
      return protocol.buildUpstreamCall({
        baseUrl,
        credential,
        path: request.path,
        headers: request.headers,
        body: request.body,
        rawBody: request.rawBody,
        attributionUser: request.attribution.user,
      });
    },

    isStreaming: (body) => protocol.isStreaming(body),
    observe: (payload, headers) => protocol.observe(payload, headers),
    observeStream: (headers) => protocol.observeStream(headers),
    sanitizeResponseHeaders: (headers) => protocol.sanitizeResponseHeaders(headers),

    toObservation({ observed, requestedModel, environment, clientType, occurredAt, latencyMs }) {
      const generationId = observed.identity.generationId;
      // No request identity means no way to dedupe, and no way to stop the same
      // request being rewarded twice. A synthetic id would make duplicates
      // invisible rather than impossible, so there is simply no proof.
      if (!generationId || !observed.hasUsage) return null;

      const model = observed.identity.model ?? requestedModel;
      if (!model) return null;

      return {
        environment,
        generationId,
        generationIdSource: observed.identity.source ?? "provider_response_id",
        // Namespaced by connection: upstream model ids are not globally unique,
        // and two providers can both serve "llama-3.1-70b".
        model: model.includes("/") ? model : `${input.providerSlug}/${model}`,
        gatewayId: id,
        clientType,
        servedByProvider: observed.identity.provider ?? input.providerSlug,
        occurredAt: occurredAt.toISOString(),
        usage: observed.usage,
        cost: observed.cost,
        finishReason: observed.finishReason,
        latencyMs,
      };
    },
  };
}
