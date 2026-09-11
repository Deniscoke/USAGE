/**
 * Conversation history, kept in the browser and nowhere else.
 *
 * USAGE's third rule: prompts, responses and conversations are never stored
 * by USAGE. A chat needs history to be usable, so the history lives in the
 * reader's own browser storage under their own account key, and this module
 * is the whole shape of it -- what is kept, how much, and how it is trimmed.
 *
 * Nothing here talks to storage directly; the component does that inside a
 * try/catch, because browser storage can be absent, full or refused. These
 * functions are pure so the trimming and versioning rules are testable.
 */

export interface MessageReceipt {
  /** What USAGE persisted for the request that produced this reply. */
  status: "pending" | "verified" | "held" | "ineligible" | "unrecorded";
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  epochId: string | null;
  reason: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  model?: string;
  generationId?: string | null;
  receipt?: MessageReceipt;
}

export interface Conversation {
  id: string;
  title: string;
  startedAt: string;
  messages: ChatMessage[];
}

export interface ChatHistory {
  version: 1;
  conversations: Conversation[];
}

export const HISTORY_VERSION = 1 as const;
/** Enough for real use; small enough that storage never fills with chat. */
export const MAX_CONVERSATIONS = 30;
export const MAX_MESSAGES_PER_CONVERSATION = 200;
export const MAX_HISTORY_BYTES = 400_000;

export function storageKey(userId: string): string {
  return `usage.chat.v${HISTORY_VERSION}.${userId}`;
}

export function emptyHistory(): ChatHistory {
  return { version: HISTORY_VERSION, conversations: [] };
}

/** A title from the first user message: the first line, trimmed to a glance. */
export function titleFor(firstUserMessage: string): string {
  const line = firstUserMessage.trim().split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || "New conversation";
}

/** Keep the newest conversations and the newest messages, within the byte budget. */
export function trimHistory(history: ChatHistory): ChatHistory {
  let conversations = history.conversations
    .slice()
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, MAX_CONVERSATIONS)
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
    }));

  // Drop the oldest whole conversations until the serialised size fits.
  while (conversations.length > 0 && byteLength({ version: HISTORY_VERSION, conversations }) > MAX_HISTORY_BYTES) {
    conversations = conversations.slice(0, -1);
  }
  return { version: HISTORY_VERSION, conversations };
}

export function serializeHistory(history: ChatHistory): string {
  return JSON.stringify(trimHistory(history));
}

/** Anything unreadable becomes an empty history, never a crash. */
export function deserializeHistory(raw: string | null | undefined): ChatHistory {
  if (!raw) return emptyHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<ChatHistory>;
    if (parsed.version !== HISTORY_VERSION || !Array.isArray(parsed.conversations)) return emptyHistory();
    const conversations = parsed.conversations.filter(isConversation);
    return trimHistory({ version: HISTORY_VERSION, conversations });
  } catch {
    return emptyHistory();
  }
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const c = value as Conversation;
  return typeof c.id === "string" && typeof c.title === "string" && typeof c.startedAt === "string" && Array.isArray(c.messages);
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** The messages a request sends: role and text only, never receipts or ids. */
export function toWireMessages(messages: readonly ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  return messages.filter((m) => m.content.trim().length > 0).map((m) => ({ role: m.role, content: m.content }));
}
