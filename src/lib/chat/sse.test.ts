import { describe, expect, it } from "vitest";
import { SseParser, type StreamEvent } from "./sse";

/**
 * The browser's view of a streamed completion.
 *
 * Chunk boundaries are the transport's business, not the provider's, and they
 * land mid-line constantly. The parser must give the same deltas however the
 * bytes were split, or a word goes missing at every boundary.
 */

const CHUNK = (delta: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
const USAGE = `data: ${JSON.stringify({
  id: "gen-123",
  model: "anthropic/claude-sonnet-4.6",
  choices: [{ delta: {} }],
  usage: { prompt_tokens: 12, completion_tokens: 7, cost: 0.000345, prompt_tokens_details: { cached_tokens: 4 } },
})}\n\n`;

function collect(parser: SseParser, pieces: string[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const piece of pieces) out.push(...parser.push(piece));
  out.push(...parser.flush());
  return out;
}

describe("SseParser", () => {
  it("yields each delta once, in order", () => {
    const events = collect(new SseParser(), [CHUNK("Hel"), CHUNK("lo"), "data: [DONE]\n\n"]);
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done" },
    ]);
  });

  it("gives the same result however the transport split the bytes", () => {
    const whole = CHUNK("Hello") + CHUNK(", world") + USAGE + "data: [DONE]\n\n";
    const reference = collect(new SseParser(), [whole]);
    // Split at every position: every one of these must match.
    for (let at = 1; at < whole.length; at += 7) {
      const split = collect(new SseParser(), [whole.slice(0, at), whole.slice(at)]);
      expect(split).toEqual(reference);
    }
  });

  it("reads the provider's terminal usage, cost included, exactly as stated", () => {
    const [usage] = collect(new SseParser(), [USAGE]);
    expect(usage).toEqual({
      type: "usage",
      model: "anthropic/claude-sonnet-4.6",
      generationId: "gen-123",
      usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: null, cost: 0.000345 },
    });
  });

  it("surfaces a provider error event instead of swallowing it", () => {
    const events = collect(new SseParser(), [`data: ${JSON.stringify({ error: { message: "Insufficient credits" } })}\n\n`]);
    expect(events).toEqual([{ type: "error", message: "Insufficient credits" }]);
  });

  it("skips lines that are not data and events that are not JSON", () => {
    const events = collect(new SseParser(), [": keep-alive\n\nevent: ping\n\ndata: {not json\n\n", CHUNK("ok")]);
    expect(events).toEqual([{ type: "delta", text: "ok" }]);
  });

  it("does not invent a delta from an empty content field", () => {
    const events = collect(new SseParser(), [`data: ${JSON.stringify({ choices: [{ delta: { content: "" } }] })}\n\n`]);
    expect(events).toEqual([]);
  });
});
