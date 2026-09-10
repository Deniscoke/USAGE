import { applyOpenRouterPrivacy } from "@/lib/providers/openrouter-privacy";
import type {
  ComputeGateway,
  GatewayRequest,
  ObservedGeneration,
  StreamObserver,
  UpstreamCall,
} from "./gateway";
import type { GatewayCost, GatewayTokenUsage } from "@/lib/providers/vercel-gateway/observation";

/**
 * OpenRouter — the second real compute gateway.
 *
 * Deliberately written against the same ComputeGateway contract as Vercel, and
 * nothing downstream knows the difference: the same receipt signing, the same
 * canonical hashing, the same dedupe, the same protocol pricing, the same
 * score. There is no OpenRouter-specific reward path, because a second reward
 * path is how a protocol quietly stops being one protocol.
 *
 * Two real differences from the Vercel surface, both handled here:
 *
 *   1. The wire format is OpenAI chat-completions, not Anthropic messages.
 *   2. OpenRouter returns an AUTHORITATIVE per-request cost. That is recorded
 *      as actual cost for audit and reconciliation. Mining still runs on
 *      protocol compute value -- a route that happens to report its bill must
 *      not earn differently from one that does not.
 *
 * Only usage metadata is read. Message content streams through untouched and
 * is never inspected, buffered or stored.
 */

export const OPENROUTER_GATEWAY_ID = "openrouter";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function openRouterBaseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Headers never copied from the caller.
 *
 * Any client-supplied credential is dropped: letting a caller choose the
 * upstream identity would let it choose who pays and whose usage this becomes.
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

/** The OpenAI-compatible usage block OpenRouter returns. Every field optional. */
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost_details?: { upstream_inference_cost?: number | null };
}

interface OpenRouterCompletion {
  id?: unknown;
  model?: unknown;
  provider?: unknown;
  usage?: OpenRouterUsage;
  choices?: { finish_reason?: unknown }[];
}

function toGatewayUsage(usage: OpenRouterUsage): GatewayTokenUsage {
  const cachedRead = usage.prompt_tokens_details?.cached_tokens;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;

  return {
    // OpenAI-shaped `prompt_tokens` is the INCLUSIVE input total, with cached
    // reads broken out inside it -- the opposite of Anthropic's exclusive
    // count. Recording the breakdown explicitly means the normalizer never has
    // to guess which convention produced a number.
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
            // Absent stays absent: a model that reported no cache fields has
            // not told us they were zero.
            cacheReadTokens: cachedRead,
            cacheWriteTokens: cacheWrite,
          },
    outputTokenDetails: reasoning === undefined ? undefined : { reasoningTokens: reasoning },
  };
}

/**
 * Cost, only when OpenRouter actually states one.
 *
 * `cost: 0` is a real observation (a free model) and is kept. Absent is
 * unknown, and is never turned into zero.
 */
function toCost(usage: OpenRouterUsage | undefined): GatewayCost | null {
  if (!usage || typeof usage.cost !== "number" || !Number.isFinite(usage.cost)) return null;
  // Passed as a string so the micro-USD parser sees the exact decimal rather
  // than a float that has already lost digits.
  return { value: usage.cost.toFixed(12), currency: "USD" };
}

function observedFrom(payload: unknown): ObservedGeneration {
  if (typeof payload !== "object" || payload === null) {
    return {
      identity: { generationId: null, source: null, model: null, provider: null },
      usage: {},
      cost: null,
      hasUsage: false,
    };
  }

  const completion = payload as OpenRouterCompletion;
  const model = typeof completion.model === "string" ? completion.model : null;

  return {
    identity: {
      generationId: typeof completion.id === "string" ? completion.id : null,
      source: "openrouter_generation_id",
      model,
      // OpenRouter names the upstream provider that actually served the
      // request, which is better evidence than parsing the model slug.
      provider:
        typeof completion.provider === "string"
          ? completion.provider
          : model?.includes("/")
            ? model.split("/")[0]
            : null,
    },
    usage: completion.usage ? toGatewayUsage(completion.usage) : {},
    cost: toCost(completion.usage),
    finishReason:
      typeof completion.choices?.[0]?.finish_reason === "string"
        ? completion.choices[0].finish_reason
        : undefined,
    hasUsage: Boolean(completion.usage),
  };
}

/**
 * Streamed responses.
 *
 * OpenRouter streams OpenAI-style SSE and puts the usage block on a late chunk.
 * Only `usage`, `id`, `model` and `finish_reason` are read; delta content is
 * never touched.
 */
export class OpenRouterStreamObserver implements StreamObserver {
  private buffer = "";
  private latest: OpenRouterCompletion = {};
  private usage: OpenRouterUsage | undefined;

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last partial line for the next chunk.
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const frame = JSON.parse(data) as OpenRouterCompletion;
        if (typeof frame.id === "string") this.latest.id = frame.id;
        if (typeof frame.model === "string") this.latest.model = frame.model;
        if (typeof frame.provider === "string") this.latest.provider = frame.provider;
        if (frame.choices?.[0]?.finish_reason) this.latest.choices = frame.choices;
        if (frame.usage) this.usage = frame.usage;
      } catch {
        // A malformed frame is not evidence of anything. Skip it rather than
        // failing the passthrough the client is still reading.
      }
    }
  }

  result(): ObservedGeneration {
    return observedFrom({ ...this.latest, usage: this.usage });
  }
}

/** A raw body we could not parse earlier: try once more, else start empty. */
function parseRawBody(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const openRouterComputeGateway: ComputeGateway = {
  id: OPENROUTER_GATEWAY_ID,
  providerSlug: "openrouter",

  buildUpstreamCall(request: GatewayRequest, credential: string): UpstreamCall {
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    headers.set("content-type", "application/json");
    // Ours, and only ours.
    headers.set("authorization", `Bearer ${credential}`);
    // App identification, documented by OpenRouter. Non-secret.
    headers.set("http-referer", "https://usage-ten.vercel.app");
    headers.set("x-openrouter-title", "USAGE");

    // Attribution is added server-side from the authenticated identity and
    // overwrites anything the caller sent. `user` is OpenAI-compatible. The
    // privacy baseline (zdr, data_collection = deny) is written into the body
    // on every request; a body that could not be parsed gets the baseline
    // alone, which fails closed upstream rather than routing unrestricted.
    const parsed =
      typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : parseRawBody(request.rawBody);
    const body = JSON.stringify({
      ...applyOpenRouterPrivacy(parsed).body,
      user: request.attribution.user,
    });

    return { url: `${openRouterBaseUrl()}/${request.path.join("/")}`, headers, body };
  },

  isStreaming(body) {
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { stream?: unknown }).stream === true
    );
  },

  observe(payload) {
    return observedFrom(payload);
  },

  observeStream() {
    return new OpenRouterStreamObserver();
  },

  sanitizeResponseHeaders(incoming) {
    const headers = new Headers();
    for (const [name, value] of incoming) {
      if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    return headers;
  },

  toObservation({ observed, requestedModel, environment, clientType, occurredAt, latencyMs }) {
    const generationId = observed.identity.generationId;
    // No identity or no usage means no usage event, ever. A broken response
    // must not mint economic value.
    if (!generationId || !observed.hasUsage) return null;

    const model = observed.identity.model ?? requestedModel;
    if (!model) return null;

    return {
      environment,
      generationId,
      generationIdSource: observed.identity.source ?? "openrouter_generation_id",
      model,
      gatewayId: OPENROUTER_GATEWAY_ID,
      upstreamRequestId: observed.identity.upstreamRequestId ?? null,
      clientType,
      servedByProvider: observed.identity.provider ?? undefined,
      occurredAt: occurredAt.toISOString(),
      usage: observed.usage,
      cost: observed.cost,
      finishReason: observed.finishReason,
      latencyMs,
    };
  },
};
