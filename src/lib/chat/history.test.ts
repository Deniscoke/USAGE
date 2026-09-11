import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATIONS,
  MAX_HISTORY_BYTES,
  MAX_MESSAGES_PER_CONVERSATION,
  deserializeHistory,
  emptyHistory,
  serializeHistory,
  storageKey,
  titleFor,
  toWireMessages,
  trimHistory,
  type ChatHistory,
  type Conversation,
} from "./history";

/**
 * History lives in the browser because USAGE must never hold it. That makes
 * the browser's storage the only copy, so it has to survive being full,
 * absent, or from an older build.
 */

function conversation(id: string, startedAt: string, messages = 2): Conversation {
  return {
    id,
    title: id,
    startedAt,
    messages: Array.from({ length: messages }, (_, i) => ({
      id: `${id}-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      at: startedAt,
    })),
  };
}

describe("history", () => {
  it("keys storage by account, so two people on one machine never share a chat", () => {
    expect(storageKey("a")).not.toBe(storageKey("b"));
    expect(storageKey("a")).toContain("a");
  });

  it("round-trips through storage", () => {
    const history: ChatHistory = { version: 1, conversations: [conversation("c1", "2026-09-12T10:00:00Z")] };
    expect(deserializeHistory(serializeHistory(history))).toEqual(history);
  });

  it("treats garbage, an older version, or nothing as an empty history", () => {
    expect(deserializeHistory(null)).toEqual(emptyHistory());
    expect(deserializeHistory("{not json")).toEqual(emptyHistory());
    expect(deserializeHistory(JSON.stringify({ version: 0, conversations: [] }))).toEqual(emptyHistory());
    expect(deserializeHistory(JSON.stringify({ version: 1, conversations: [{ nope: true }] })).conversations).toEqual([]);
  });

  it("keeps the newest conversations, oldest dropped", () => {
    const many = Array.from({ length: MAX_CONVERSATIONS + 5 }, (_, i) =>
      conversation(`c${i}`, new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), 1),
    );
    const trimmed = trimHistory({ version: 1, conversations: many });
    expect(trimmed.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(trimmed.conversations[0]!.id).toBe(`c${MAX_CONVERSATIONS + 4}`);
    expect(trimmed.conversations.at(-1)!.id).toBe("c5");
  });

  it("keeps the newest messages of a long conversation, not the oldest", () => {
    const long = conversation("long", "2026-09-12T10:00:00Z", MAX_MESSAGES_PER_CONVERSATION + 10);
    const [trimmed] = trimHistory({ version: 1, conversations: [long] }).conversations;
    expect(trimmed!.messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(trimmed!.messages.at(-1)!.content).toBe(`message ${MAX_MESSAGES_PER_CONVERSATION + 9}`);
  });

  it("stays under the byte budget by dropping whole old conversations", () => {
    const big = Array.from({ length: 6 }, (_, i) => ({
      ...conversation(`c${i}`, new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), 1),
      messages: [{ id: `m${i}`, role: "user" as const, content: "x".repeat(150_000), at: "2026-09-12T10:00:00Z" }],
    }));
    const serialized = serializeHistory({ version: 1, conversations: big });
    expect(new TextEncoder().encode(serialized).length).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    const kept = deserializeHistory(serialized);
    expect(kept.conversations.length).toBeGreaterThan(0);
    expect(kept.conversations[0]!.id).toBe("c5");
  });

  it("titles a conversation from the first line of the first message", () => {
    expect(titleFor("Explain epochs\nin detail")).toBe("Explain epochs");
    expect(titleFor("   ")).toBe("New conversation");
    expect(titleFor("a".repeat(80))).toHaveLength(48);
  });

  it("sends the provider role and text only", () => {
    const wire = toWireMessages([
      { id: "1", role: "user", content: "hi", at: "t", receipt: { status: "verified", inputTokens: 1, outputTokens: 1, costMicros: 1, epochId: "e", reason: null } },
      { id: "2", role: "assistant", content: "  ", at: "t" },
    ]);
    expect(wire).toEqual([{ role: "user", content: "hi" }]);
  });
});
