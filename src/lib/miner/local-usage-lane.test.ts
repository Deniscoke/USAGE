import { describe, expect, it } from "vitest";
import { LOCAL_USAGE_LANE } from "./local-usage-lane";
import { validateIncoming } from "./telemetry";

describe("the local usage lane", () => {
  it("has no economic authority and cannot be claimed", () => {
    expect(LOCAL_USAGE_LANE).toMatchObject({
      source: "local_telemetry",
      verification: "local_only",
      economicAuthority: "none",
      reward: 0,
      claimable: false,
    });
    expect(`${LOCAL_USAGE_LANE.label} ${LOCAL_USAGE_LANE.title}`).not.toMatch(/verified|mining/i);
  });

  it("refuses a device that tries to promote itself out of the lane", () => {
    const base = {
      schema: "local-usage-observation-v1",
      adapter: "claude-code-otel-v1",
      tool: "claude-code",
      toolVersion: "2.1.0",
      sourceType: "otel",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      upstreamRequestId: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      toolTokens: null,
      estimatedCostMicros: null,
      occurredAt: "2026-09-17T10:00:00.000Z",
      localSessionId: "s1",
      localEventId: "e1",
    };
    for (const [key, value] of [
      ["verified", true],
      ["verification", "verified"],
      ["verificationLevel", "provider_verified"],
      ["claimable", true],
      ["economicAuthority", "provider"],
      ["trusted", true],
    ] as const) {
      const verdict = validateIncoming({ observation: { ...base, [key]: value } as never, signature: null });
      expect(verdict.ok, key).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe(`forbidden_field:${key}`);
    }
  });
});
