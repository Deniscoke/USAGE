import { safeFetch } from "@/lib/net/ssrf";
import { anthropicError } from "@/lib/gateway/anthropic";
import {
  AnthropicStreamUsageCollector,
  extractFromMessage,
} from "@/lib/gateway/usage-extract";
import type { ObservedGeneration, StreamObserver } from "@/lib/compute/gateway";
import {
  UNKNOWN_CAPABILITIES,
  type ProbeResult,
  type ProtocolCapabilities,
  type ProtocolRequestContext,
  type ProviderProtocol,
} from "./protocol";

/**
 * The Anthropic-compatible protocol.
 *
 * PROVIDER IDENTITY AND PROTOCOL IDENTITY ARE SEPARATE. An endpoint that speaks
 * this wire format is not necessarily Anthropic: it may be a gateway, a proxy,
 * a self-hosted server or a company that chose the same shape. The connection
 * records `provider = <whatever the user named it>` and
 * `protocol = anthropic_compatible`, and nothing downstream assumes the two are
 * the same thing.
 *
 * The extraction logic is the same code the production Vercel path has used
 * since M3 -- shared, not reimplemented, so a fix reaches both.
 */

const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-usage-miner-token",
  "x-ai-gateway-api-key",
  "cookie",
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "transfer-encoding",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "x-api-key",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const ANTHROPIC_VERSION = "2023-06-01";

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function toObserved(payload: unknown): ObservedGeneration {
  const extracted = extractFromMessage(payload);
  return {
    identity: {
      generationId: extracted.generationId,
      source: extracted.generationId ? "anthropic_message_id" : null,
      model: extracted.model,
      provider: extracted.model?.includes("/") ? extracted.model.split("/")[0] : null,
    },
    usage: extracted.usage,
    // The Anthropic message shape carries no cost. Absent means unknown.
    cost: null,
    finishReason: extracted.finishReason,
    hasUsage: extracted.hasUsage,
  };
}

class AnthropicObserver implements StreamObserver {
  private collector = new AnthropicStreamUsageCollector();

  push(chunk: string): void {
    this.collector.push(chunk);
  }

  result(): ObservedGeneration {
    const extracted = this.collector.result();
    return {
      identity: {
        generationId: extracted.generationId,
        source: extracted.generationId ? "anthropic_message_id" : null,
        model: extracted.model,
        provider: null,
      },
      usage: extracted.usage,
      cost: null,
      finishReason: extracted.finishReason,
      hasUsage: extracted.hasUsage,
    };
  }
}

export const anthropicCompatibleProtocol: ProviderProtocol = {
  id: "anthropic_compatible",
  label: "Anthropic compatible",
  routable: true,

  normalizeBaseUrl: normalizeBase,

  /**
   * Probe with the models endpoint when the endpoint offers one.
   *
   * Anthropic-compatible servers vary in whether they implement `/v1/models`,
   * so a 404 there is not a failed connection -- it means capability is unknown
   * until the first real generation, and the result says exactly that rather
   * than spending the user's credit on an inference call to find out.
   */
  async probe({ baseUrl, credential, fetchImpl, resolve, allowInsecure }): Promise<ProbeResult> {
    const capabilities: ProtocolCapabilities = { ...UNKNOWN_CAPABILITIES };

    let response: Response;
    try {
      response = await safeFetch(
        `${normalizeBase(baseUrl)}/v1/models`,
        {
          headers: {
            "x-api-key": credential,
            "anthropic-version": ANTHROPIC_VERSION,
            accept: "application/json",
          },
          cache: "no-store",
        },
        { fetchImpl, resolve, allowInsecure },
      );
    } catch (error) {
      return {
        ok: false,
        capabilities,
        models: [],
        failure: "unreachable",
        message:
          error instanceof Error && error.name === "SsrfError"
            ? error.message
            : "USAGE could not reach that endpoint.",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        capabilities,
        models: [],
        failure: response.status === 401 ? "invalid_credentials" : "forbidden",
        message: "That credential was rejected.",
      };
    }

    if (response.status === 404 || response.status === 405) {
      // Reachable and not rejected, but it lists no models. Honest outcome:
      // connected, capability unproven.
      capabilities.authenticated = true;
      capabilities.streaming = true;
      capabilities.usage = true;
      capabilities.requestIdentity = true;
      return {
        ok: true,
        capabilities,
        models: [],
        message:
          "Connected. This endpoint does not list models, so models must be entered manually.",
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        capabilities,
        models: [],
        failure: "unreachable",
        message: "That endpoint refused the request.",
      };
    }

    capabilities.authenticated = true;
    capabilities.streaming = true;
    capabilities.usage = true;
    capabilities.requestIdentity = true;
    // Anthropic reports cache read and creation tokens as part of its usage
    // block, which is the protocol's documented shape.
    capabilities.cacheUsage = true;

    let models: { upstreamModelId: string }[] = [];
    try {
      const payload = (await response.json()) as { data?: { id?: unknown }[] };
      models = (payload.data ?? [])
        .filter((entry): entry is { id: string } => typeof entry.id === "string")
        .map((entry) => ({ upstreamModelId: entry.id }));
      capabilities.models = models.length > 0;
    } catch {
      return {
        ok: false,
        capabilities,
        models: [],
        failure: "malformed",
        message: "That endpoint answered, but not with a model list USAGE understands.",
      };
    }

    return {
      ok: true,
      capabilities,
      models,
      message: `Connected. ${models.length} model${models.length === 1 ? "" : "s"} discovered.`,
    };
  },

  buildUpstreamCall(context: ProtocolRequestContext) {
    const headers = new Headers();
    for (const [name, value] of context.headers) {
      if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    headers.set("content-type", "application/json");
    headers.set("x-api-key", context.credential);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", ANTHROPIC_VERSION);

    // The Anthropic messages API has no attribution field, so the body is
    // forwarded unchanged rather than having one invented into it.
    return {
      url: `${normalizeBase(context.baseUrl)}/v1/${context.path.join("/")}`,
      headers,
      body: context.rawBody,
    };
  },

  isStreaming(body) {
    return (
      typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true
    );
  },

  observe(payload) {
    return toObserved(payload);
  },

  observeStream() {
    return new AnthropicObserver();
  },

  sanitizeResponseHeaders(incoming) {
    const headers = new Headers();
    for (const [name, value] of incoming) {
      if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    return headers;
  },

  error: anthropicError,
};
