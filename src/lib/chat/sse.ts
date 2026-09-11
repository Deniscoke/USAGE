/**
 * Reading an OpenAI-compatible completion stream in the browser.
 *
 * The gateway passes the provider's bytes through untouched, so what arrives
 * is server-sent events: `data: {json}` lines, a blank line between events,
 * and `data: [DONE]` at the end. Each JSON event carries a `choices[0].delta`
 * with a fragment of text, and the final event -- when the request asked for
 * usage -- carries the provider's own token counts and, on OpenRouter, the cost.
 *
 * This parser is pure so it can be tested without a network: feed it chunks
 * in whatever sizes the transport chose to split them, and it yields the same
 * deltas either way. Chunk boundaries fall mid-line constantly in practice.
 */

export interface StreamUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** In USD, exactly as the provider stated it. Null when it stated nothing. */
  cost: number | null;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: StreamUsage; model: string | null; generationId: string | null }
  | { type: "done" }
  | { type: "error"; message: string };

interface CompletionChunk {
  id?: unknown;
  model?: unknown;
  error?: { message?: unknown };
  choices?: { delta?: { content?: unknown; reasoning?: unknown } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

export class SseParser {
  private buffer = "";

  /** Feed one transport chunk; get back every complete event it finished. */
  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const events: StreamEvent[] = [];

    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const event = parseLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** The stream ended; anything left without a newline is one last line. */
  flush(): StreamEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const event = rest.trim() ? parseLine(rest) : null;
    return event ? [event] : [];
  }
}

function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice("data:".length).trim();
  if (!data) return null;
  if (data === "[DONE]") return { type: "done" };

  let chunk: CompletionChunk;
  try {
    chunk = JSON.parse(data) as CompletionChunk;
  } catch {
    // A malformed event is skipped, not fatal: the provider's terminal usage
    // still arrives on its own line and the gateway observed the real bytes.
    return null;
  }

  if (chunk.error && typeof chunk.error === "object") {
    const message = typeof chunk.error.message === "string" ? chunk.error.message : "The provider returned an error.";
    return { type: "error", message };
  }

  if (chunk.usage) {
    const usage = chunk.usage;
    return {
      type: "usage",
      model: typeof chunk.model === "string" ? chunk.model : null,
      generationId: typeof chunk.id === "string" ? chunk.id : null,
      usage: {
        inputTokens: numberOrNull(usage.prompt_tokens),
        outputTokens: numberOrNull(usage.completion_tokens),
        cacheReadTokens: numberOrNull(usage.prompt_tokens_details?.cached_tokens),
        cacheWriteTokens: numberOrNull(usage.prompt_tokens_details?.cache_write_tokens),
        cost: numberOrNull(usage.cost),
      },
    };
  }

  const delta = chunk.choices?.[0]?.delta;
  if (delta && typeof delta.content === "string" && delta.content.length > 0) {
    return { type: "delta", text: delta.content };
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
