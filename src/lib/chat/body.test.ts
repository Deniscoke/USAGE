import { describe, expect, it } from "vitest";
import { MAX_MESSAGES, MAX_MESSAGE_CHARS, sanitizeChatBody } from "./body";

/**
 * A browser tab is not a miner. The body it sends is rebuilt from an
 * allowlist, never forwarded.
 */

const options = { allowedModels: null, maxOutputTokens: 1024, includeCost: false };
const ask = (over: Record<string, unknown> = {}) => ({
  model: "anthropic/claude-sonnet-4.6",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

describe("sanitizeChatBody", () => {
  it("keeps only the allowed fields and always streams with usage", () => {
    const result = sanitizeChatBody(ask({ tools: [{ evil: true }], provider: { order: ["x"] }, n: 5 }), options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      model: "anthropic/claude-sonnet-4.6",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1024,
    });
  });

  it("refuses a model outside the route's list", () => {
    const result = sanitizeChatBody(ask(), { ...options, allowedModels: new Set(["openai/gpt-5-nano"]) });
    expect(result).toEqual({ ok: false, message: "That model is not available on this route." });
  });

  it("caps output tokens at what the caller allows, never above", () => {
    const result = sanitizeChatBody(ask({ max_tokens: 999_999 }), options);
    expect(result.ok && result.body.max_tokens).toBe(1024);
    const small = sanitizeChatBody(ask({ max_tokens: 50.9 }), options);
    expect(small.ok && small.body.max_tokens).toBe(50);
  });

  it("bounds the conversation in length and in size", () => {
    const tooMany = ask({ messages: Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: "user", content: "x" })) });
    expect(sanitizeChatBody(tooMany, options).ok).toBe(false);
    const tooLong = ask({ messages: [{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 1) }] });
    expect(sanitizeChatBody(tooLong, options).ok).toBe(false);
  });

  it("rejects roles and content that are not what a chat sends", () => {
    expect(sanitizeChatBody(ask({ messages: [{ role: "tool", content: "x" }] }), options).ok).toBe(false);
    expect(sanitizeChatBody(ask({ messages: [{ role: "user", content: [{ type: "image" }] }] }), options).ok).toBe(false);
    expect(sanitizeChatBody(ask({ messages: [{ role: "assistant", content: "only me" }] }), options).ok).toBe(false);
  });

  it("asks OpenRouter for the cost when told to, and nobody else", () => {
    const yes = sanitizeChatBody(ask(), { ...options, includeCost: true });
    expect(yes.ok && yes.body.usage).toEqual({ include: true });
    const no = sanitizeChatBody(ask(), options);
    expect(no.ok && "usage" in no.body).toBe(false);
  });

  it("clamps temperature into the range providers accept", () => {
    const hot = sanitizeChatBody(ask({ temperature: 9 }), options);
    expect(hot.ok && hot.body.temperature).toBe(2);
    const nan = sanitizeChatBody(ask({ temperature: "warm" }), options);
    expect(nan.ok && nan.body.temperature).toBeUndefined();
  });

  it("refuses anything that is not an object", () => {
    expect(sanitizeChatBody("hi", options).ok).toBe(false);
    expect(sanitizeChatBody(null, options).ok).toBe(false);
    expect(sanitizeChatBody([], options).ok).toBe(false);
  });
});
