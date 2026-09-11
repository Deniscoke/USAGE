/**
 * What the browser may ask the gateway to send.
 *
 * The chat route hands the body to the same trust boundary the miner uses,
 * which forwards it to the provider. A miner is a program the user runs on
 * their own machine; a browser tab is a page anyone can open with a stolen
 * cookie or a bug. So the chat body is rebuilt here from a short allowlist
 * rather than forwarded as sent: a model, a bounded list of messages, and a
 * few generation knobs with ceilings. Everything else is dropped, and
 * streaming with usage is always requested because the receipt depends on it.
 */

export interface WireMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SanitizedChatBody {
  model: string;
  messages: WireMessage[];
  stream: true;
  stream_options: { include_usage: true };
  max_tokens: number;
  temperature?: number;
  /** OpenRouter states the request's cost in the terminal usage when asked. */
  usage?: { include: true };
}

export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 32_000;
export const MAX_MODEL_CHARS = 200;

export type SanitizeResult = { ok: true; body: SanitizedChatBody } | { ok: false; message: string };

export function sanitizeChatBody(
  input: unknown,
  options: {
    /** When set, only these model ids are accepted. */
    allowedModels: ReadonlySet<string> | null;
    /** Ceiling on output tokens; the caller decides how much money a reply may cost. */
    maxOutputTokens: number;
    /** Ask the provider to state cost in the stream (OpenRouter). */
    includeCost: boolean;
  },
): SanitizeResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "The request body must be a JSON object." };
  }
  const raw = input as Record<string, unknown>;

  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model || model.length > MAX_MODEL_CHARS) return { ok: false, message: "Choose a model." };
  if (options.allowedModels && !options.allowedModels.has(model)) {
    return { ok: false, message: "That model is not available on this route." };
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return { ok: false, message: "Send at least one message." };
  }
  if (raw.messages.length > MAX_MESSAGES) {
    return { ok: false, message: `A conversation sends at most ${MAX_MESSAGES} messages; start a new one.` };
  }

  const messages: WireMessage[] = [];
  for (const item of raw.messages) {
    if (typeof item !== "object" || item === null) return { ok: false, message: "Malformed message." };
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant" && role !== "system") {
      return { ok: false, message: "Malformed message role." };
    }
    if (typeof content !== "string") return { ok: false, message: "Messages must be text." };
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, message: `A message is at most ${MAX_MESSAGE_CHARS.toLocaleString()} characters.` };
    }
    messages.push({ role, content });
  }
  if (!messages.some((m) => m.role === "user")) return { ok: false, message: "Send at least one user message." };

  const body: SanitizedChatBody = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: clampInt(raw.max_tokens, 1, options.maxOutputTokens, options.maxOutputTokens),
  };

  if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) {
    body.temperature = Math.min(2, Math.max(0, raw.temperature));
  }
  if (options.includeCost) body.usage = { include: true };

  return { ok: true, body };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
