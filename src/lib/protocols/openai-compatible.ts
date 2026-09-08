import { safeFetch } from "@/lib/net/ssrf";
import type { ObservedGeneration, StreamObserver } from "@/lib/compute/gateway";
import type { GatewayCost, GatewayTokenUsage } from "@/lib/providers/vercel-gateway/observation";
import {
  UNKNOWN_CAPABILITIES,
  upstreamPath,
  type DiscoveredModel,
  type ProbeResult,
  type ProtocolCapabilities,
  type ProtocolRequestContext,
  type ProviderProtocol,
} from "./protocol";

/**
 * The OpenAI-compatible protocol.
 *
 * The most widely implemented AI wire format: DeepSeek, Together, Groq,
 * OpenRouter, Fireworks, vLLM and most self-hosted servers speak it. One
 * implementation covers all of them, and a provider that ships tomorrow works
 * without a code change.
 *
 * CRITICAL: "compatible" is a spectrum. Many implementations omit `usage`,
 * omit cached-token detail, or return no stable `id`. None of that is assumed
 * -- capability is probed, and absence is recorded as absence rather than
 * filled in with zeros.
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

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAiCompletion {
  id?: unknown;
  model?: unknown;
  provider?: unknown;
  usage?: OpenAiUsage;
  choices?: { finish_reason?: unknown }[];
}

export function openAiUsageToGateway(usage: OpenAiUsage): GatewayTokenUsage {
  const cachedRead = usage.prompt_tokens_details?.cached_tokens;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;

  return {
    // `prompt_tokens` is the INCLUSIVE input total with cached reads counted
    // inside it. Recording the fresh remainder explicitly means the normalizer
    // never has to guess which convention produced a number.
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    inputTokenDetails:
      cachedRead === undefined && cacheWrite === undefined
        ? undefined
        : {
            noCacheTokens:
              usage.prompt_tokens === undefined || cachedRead === undefined
                ? undefined
                : Math.max(0, usage.prompt_tokens - cachedRead),
            // Absent stays absent: a provider that reported no cache fields has
            // not told us they were zero.
            cacheReadTokens: cachedRead,
            cacheWriteTokens: cacheWrite,
          },
    outputTokenDetails: reasoning === undefined ? undefined : { reasoningTokens: reasoning },
  };
}

/** Cost, only when the provider actually states one. Zero is a real answer. */
export function openAiCost(usage: OpenAiUsage | undefined): GatewayCost | null {
  if (!usage || typeof usage.cost !== "number" || !Number.isFinite(usage.cost)) return null;
  // Passed as a string so the micro-USD parser sees the exact decimal.
  return { value: usage.cost.toFixed(12), currency: "USD" };
}

export function observeOpenAiCompletion(payload: unknown): ObservedGeneration {
  if (typeof payload !== "object" || payload === null) {
    return {
      identity: { generationId: null, source: null, model: null, provider: null },
      usage: {},
      cost: null,
      hasUsage: false,
    };
  }

  const completion = payload as OpenAiCompletion;
  const model = typeof completion.model === "string" ? completion.model : null;

  return {
    identity: {
      generationId: typeof completion.id === "string" ? completion.id : null,
      source: "openai_response_id",
      model,
      provider:
        typeof completion.provider === "string"
          ? completion.provider
          : model?.includes("/")
            ? model.split("/")[0]
            : null,
    },
    usage: completion.usage ? openAiUsageToGateway(completion.usage) : {},
    cost: openAiCost(completion.usage),
    finishReason:
      typeof completion.choices?.[0]?.finish_reason === "string"
        ? completion.choices[0].finish_reason
        : undefined,
    hasUsage: Boolean(completion.usage),
  };
}

/**
 * Streamed responses. Only `usage`, `id`, `model` and `finish_reason` are read;
 * delta content is never touched.
 */
export class OpenAiStreamObserver implements StreamObserver {
  private buffer = "";
  private latest: OpenAiCompletion = {};
  private usage: OpenAiUsage | undefined;

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const frame = JSON.parse(data) as OpenAiCompletion;
        if (typeof frame.id === "string") this.latest.id = frame.id;
        if (typeof frame.model === "string") this.latest.model = frame.model;
        if (typeof frame.provider === "string") this.latest.provider = frame.provider;
        if (frame.choices?.[0]?.finish_reason) this.latest.choices = frame.choices;
        if (frame.usage) this.usage = frame.usage;
      } catch {
        // A malformed frame is not evidence. Skip it rather than failing the
        // passthrough the client is still reading.
      }
    }
  }

  result(): ObservedGeneration {
    return observeOpenAiCompletion({ ...this.latest, usage: this.usage });
  }
}

/** Strip a trailing `/v1` so a user pasting either form gets the same result. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

interface ModelListing {
  data?: { id?: unknown; name?: unknown }[];
}

function classifyStatus(status: number): ProbeResult["failure"] {
  if (status === 401) return "invalid_credentials";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 405) return "unsupported";
  return "unreachable";
}

export const openAiCompatibleProtocol: ProviderProtocol = {
  id: "openai_compatible",
  label: "OpenAI compatible",
  routable: true,

  normalizeBaseUrl: normalizeBase,

  /**
   * Probe with the models endpoint: it authenticates the credential and lists
   * models in one request, and it generates nothing, so it cannot cost the user
   * anything. No inference request is made -- a capability check that spends the
   * user's money to learn something is not a good trade.
   */
  async probe({ baseUrl, credential, fetchImpl, resolve, allowInsecure }): Promise<ProbeResult> {
    const capabilities: ProtocolCapabilities = { ...UNKNOWN_CAPABILITIES };

    let response: Response;
    try {
      response = await safeFetch(
        `${normalizeBase(baseUrl)}/v1/models`,
        {
          headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
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
        // The SSRF guard's message is safe to show; anything else is ours.
        message:
          error instanceof Error && error.name === "SsrfError"
            ? error.message
            : "USAGE could not reach that endpoint.",
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        capabilities,
        models: [],
        failure: classifyStatus(response.status),
        message:
          response.status === 401
            ? "That credential was rejected."
            : response.status === 404
              ? "That endpoint does not expose an OpenAI-compatible model list."
              : "That endpoint refused the request.",
      };
    }

    capabilities.authenticated = true;

    let models: DiscoveredModel[] = [];
    try {
      const payload = (await response.json()) as ModelListing;
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
        message: "That endpoint answered, but not with an OpenAI-compatible model list.",
      };
    }

    // What the models endpoint cannot tell us. These are the protocol's
    // documented shape, confirmed for real on the first observed generation --
    // never asserted from the provider's name.
    capabilities.streaming = true;
    capabilities.usage = true;
    capabilities.requestIdentity = true;

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
    // The connection's own credential, resolved server-side.
    headers.set("authorization", `Bearer ${context.credential}`);

    // Attribution is added server-side and overwrites anything the caller sent.
    const body =
      typeof context.body === "object" && context.body !== null && !Array.isArray(context.body)
        ? JSON.stringify({
            ...(context.body as Record<string, unknown>),
            user: context.attributionUser,
          })
        : context.rawBody;

    return {
      url: `${normalizeBase(context.baseUrl)}/${upstreamPath(context.path)}`,
      headers,
      body,
    };
  },

  isStreaming(body) {
    return (
      typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true
    );
  },

  observe(payload) {
    return observeOpenAiCompletion(payload);
  },

  observeStream() {
    return new OpenAiStreamObserver();
  },

  sanitizeResponseHeaders(incoming) {
    const headers = new Headers();
    for (const [name, value] of incoming) {
      if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    return headers;
  },

  error(status, type, message) {
    return new Response(JSON.stringify({ error: { message, type, code: null, param: null } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  },
};
