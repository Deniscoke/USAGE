import type { GatewayObservation, GatewayTokenUsage } from "@/lib/providers/vercel-gateway/observation";

/**
 * Extracting compute metadata from an Anthropic-compatible response.
 *
 * ONLY usage metadata is read. Text blocks, tool arguments, thinking content and
 * system prompts stream straight through to the client and are never inspected,
 * buffered or stored: USAGE is a compute ledger, not a transcript store.
 */

/** The Anthropic usage block. Every field is optional in practice. */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ExtractedUsage {
  generationId: string | null;
  model: string | null;
  usage: GatewayTokenUsage;
  finishReason?: string;
  /** True when the response carried a usage block at all. */
  hasUsage: boolean;
}

function toGatewayUsage(usage: AnthropicUsage): GatewayTokenUsage {
  const fresh = usage.input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;

  // Anthropic reports `input_tokens` EXCLUDING cached reads and writes, while
  // USAGE's normalizer expects an inclusive total with the breakdown alongside.
  // Setting noCacheTokens explicitly means the normalizer never has to subtract.
  const inclusive =
    fresh === undefined && cacheRead === undefined
      ? undefined
      : (fresh ?? 0) + (cacheRead ?? 0);

  return {
    inputTokens: inclusive,
    outputTokens: usage.output_tokens,
    inputTokenDetails:
      fresh === undefined && cacheRead === undefined && cacheWrite === undefined
        ? undefined
        : {
            // Absent stays absent. A model that reported no cache fields has
            // not told us they were zero, and a fabricated zero would be
            // indistinguishable from a measured one.
            noCacheTokens: fresh,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
          },
  };
}

/** Non-streaming `POST /v1/messages` response body. */
export function extractFromMessage(payload: unknown): ExtractedUsage {
  if (typeof payload !== "object" || payload === null) {
    return { generationId: null, model: null, usage: {}, hasUsage: false };
  }
  const message = payload as {
    id?: unknown;
    model?: unknown;
    stop_reason?: unknown;
    usage?: AnthropicUsage;
  };

  return {
    generationId: typeof message.id === "string" ? message.id : null,
    model: typeof message.model === "string" ? message.model : null,
    usage: message.usage ? toGatewayUsage(message.usage) : {},
    finishReason: typeof message.stop_reason === "string" ? message.stop_reason : undefined,
    hasUsage: Boolean(message.usage),
  };
}

/**
 * Accumulates usage from an Anthropic SSE stream while the bytes flow past
 * untouched.
 *
 * Anthropic splits usage across the stream: `message_start` carries the input
 * side (including cache reads/writes) and `message_delta` carries the running
 * output count. Only the final `message_delta` output value is meaningful.
 */
export class AnthropicStreamUsageCollector {
  private buffer = "";
  private generationId: string | null = null;
  private model: string | null = null;
  private startUsage: AnthropicUsage | null = null;
  private deltaUsage: AnthropicUsage | null = null;
  private finishReason: string | undefined;

  push(text: string): void {
    this.buffer += text;

    // SSE frames are separated by a blank line; keep the trailing partial frame.
    const frames = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = frames.pop() ?? "";
    for (const frame of frames) this.consumeFrame(frame);
  }

  private consumeFrame(frame: string): void {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        // A malformed frame is not fatal for the client; it just means we may
        // end up with no usage, which is handled as "unknown".
        continue;
      }
      this.consumeEvent(event);
    }
  }

  private consumeEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const typed = event as {
      type?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: AnthropicUsage };
      delta?: { stop_reason?: unknown };
      usage?: AnthropicUsage;
    };

    if (typed.type === "message_start" && typed.message) {
      if (typeof typed.message.id === "string") this.generationId = typed.message.id;
      if (typeof typed.message.model === "string") this.model = typed.message.model;
      if (typed.message.usage) this.startUsage = typed.message.usage;
      return;
    }

    if (typed.type === "message_delta") {
      if (typed.usage) this.deltaUsage = { ...this.deltaUsage, ...typed.usage };
      if (typeof typed.delta?.stop_reason === "string") this.finishReason = typed.delta.stop_reason;
    }
  }

  result(): ExtractedUsage {
    if (!this.startUsage && !this.deltaUsage) {
      return {
        generationId: this.generationId,
        model: this.model,
        usage: {},
        finishReason: this.finishReason,
        hasUsage: false,
      };
    }

    const merged: AnthropicUsage = {
      ...this.startUsage,
      // The final message_delta wins for output tokens.
      output_tokens: this.deltaUsage?.output_tokens ?? this.startUsage?.output_tokens,
    };

    return {
      generationId: this.generationId,
      model: this.model,
      usage: toGatewayUsage(merged),
      finishReason: this.finishReason,
      hasUsage: true,
    };
  }
}

/**
 * Gateway metadata that may ride on response headers. Read from a fixed
 * allowlist -- we never scrape arbitrary headers into the database.
 */
const GENERATION_ID_HEADERS = [
  "x-vercel-ai-gateway-generation-id",
  "x-ai-gateway-generation-id",
  "x-generation-id",
];
const COST_HEADERS = ["x-vercel-ai-gateway-cost", "x-ai-gateway-cost"];

export function readGatewayHeaders(headers: Headers): {
  generationId: string | null;
  generationIdSource: string | null;
  cost: string | null;
} {
  for (const name of GENERATION_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return { generationId: value, generationIdSource: name, cost: readCost(headers) };
  }
  return { generationId: null, generationIdSource: null, cost: readCost(headers) };
}

function readCost(headers: Headers): string | null {
  for (const name of COST_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

export interface BuildObservationInput {
  /** Which compute gateway executed this. Set by the gateway itself. */
  gatewayId?: string;
  extracted: ExtractedUsage;
  headerMetadata: ReturnType<typeof readGatewayHeaders>;
  requestedModel: string | null;
  environment: GatewayObservation["environment"];
  clientType: string;
  occurredAt: Date;
  latencyMs: number;
}

/**
 * Assemble the observation. Returns null when the response carried no usable
 * evidence -- no identity or no token counts means no usage event, ever.
 */
export function buildGatewayObservation(input: BuildObservationInput): GatewayObservation | null {
  const generationId = input.headerMetadata.generationId ?? input.extracted.generationId;
  if (!generationId || !input.extracted.hasUsage) return null;

  const model = input.extracted.model ?? input.requestedModel;
  if (!model) return null;

  return {
    environment: input.environment,
    generationId,
    generationIdSource: input.headerMetadata.generationIdSource ?? "anthropic_message_id",
    model,
    gatewayId: input.gatewayId,
    clientType: input.clientType,
    servedByProvider: model.includes("/") ? model.split("/")[0] : undefined,
    occurredAt: input.occurredAt.toISOString(),
    usage: input.extracted.usage,
    cost: input.headerMetadata.cost
      ? { value: input.headerMetadata.cost, currency: "USD" }
      : null,
    finishReason: input.extracted.finishReason,
    latencyMs: input.latencyMs,
  };
}
