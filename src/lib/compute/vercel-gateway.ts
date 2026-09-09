import {
  buildUpstreamHeaders,
  isStreamingRequest,
  sanitizeResponseHeaders,
  upstreamBaseUrl,
  withAttribution,
} from "@/lib/gateway/anthropic";
import {
  AnthropicStreamUsageCollector,
  buildGatewayObservation,
  extractFromMessage,
  readGatewayHeaders,
  type ExtractedUsage,
} from "@/lib/gateway/usage-extract";
import type {
  ComputeGateway,
  GatewayRequest,
  ObservedGeneration,
  StreamObserver,
  UpstreamCall,
} from "./gateway";
import { upstreamRequestIdFrom } from "./gateway";

/**
 * The Vercel AI Gateway implementation -- the one USAGE runs in production.
 *
 * Every line here already existed and was proven in M3-M5B; this file only
 * gathers it behind the ComputeGateway interface so a second gateway is an
 * addition rather than a rewrite. Behaviour is deliberately unchanged.
 */

export const VERCEL_COMPUTE_GATEWAY_ID = "vercel-ai-gateway";

function toObserved(
  extracted: ExtractedUsage,
  headers: Headers,
): ObservedGeneration {
  const headerMetadata = readGatewayHeaders(headers);
  return {
    identity: {
      generationId: headerMetadata.generationId ?? extracted.generationId,
      source: headerMetadata.generationIdSource ?? (extracted.generationId ? "anthropic_message_id" : null),
      model: extracted.model,
      provider: extracted.model?.includes("/") ? extracted.model.split("/")[0] : null,
      upstreamRequestId: upstreamRequestIdFrom(headers),
    },
    usage: extracted.usage,
    cost: headerMetadata.cost ? { value: headerMetadata.cost, currency: "USD" } : null,
    finishReason: extracted.finishReason,
    hasUsage: extracted.hasUsage,
  };
}

export const vercelComputeGateway: ComputeGateway = {
  id: VERCEL_COMPUTE_GATEWAY_ID,
  providerSlug: "vercel",

  buildUpstreamCall(request: GatewayRequest, credential: string): UpstreamCall {
    // Attribution is added by the server from the authenticated identity, and
    // overwrites anything the client sent: attribution a caller controls is
    // attribution we cannot trust.
    const body =
      request.body === null
        ? request.rawBody
        : JSON.stringify(
            withAttribution(request.body, {
              user: request.attribution.user,
              tags: [...request.attribution.tags],
            }),
          );

    return {
      url: `${upstreamBaseUrl()}/${request.path.join("/")}`,
      headers: buildUpstreamHeaders(request.headers, credential),
      body,
    };
  },

  isStreaming(body) {
    return isStreamingRequest(body);
  },

  observe(payload, responseHeaders) {
    return toObserved(extractFromMessage(payload), responseHeaders);
  },

  observeStream(responseHeaders): StreamObserver {
    const collector = new AnthropicStreamUsageCollector();
    return {
      push: (chunk) => collector.push(chunk),
      result: () => toObserved(collector.result(), responseHeaders),
    };
  },

  sanitizeResponseHeaders(headers) {
    return sanitizeResponseHeaders(headers);
  },

  toObservation({ observed, requestedModel, environment, clientType, occurredAt, latencyMs }) {
    return buildGatewayObservation({
      gatewayId: VERCEL_COMPUTE_GATEWAY_ID,
      extracted: {
        generationId: observed.identity.generationId,
        model: observed.identity.model,
        usage: observed.usage,
        finishReason: observed.finishReason,
        hasUsage: observed.hasUsage,
      },
      headerMetadata: {
        generationId: observed.identity.generationId,
        generationIdSource: observed.identity.source,
        cost: observed.cost ? String(observed.cost.value) : null,
      },
      upstreamRequestId: observed.identity.upstreamRequestId ?? null,
      requestedModel,
      environment,
      clientType,
      occurredAt,
      latencyMs,
    });
  },
};
