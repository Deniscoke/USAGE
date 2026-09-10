import { describe, expect, it } from "vitest";
import { allTokens, freshTokens, summarizeUsage } from "./usage-summary";
import type { LocalUsageObservationRow, UsageEventRow } from "@/lib/supabase/database.types";

/**
 * Usage is a breakdown, never one number. The real M13C request -- 2 in,
 * 18 out, 28,726 cache-read, 33,033 cache-write -- must be reported as
 * exactly that, and never as "20 tokens" with no sign of the cache.
 */

const day = "2026-09-10";

function obs(over: Partial<LocalUsageObservationRow> = {}): LocalUsageObservationRow {
  return {
    id: "o", user_id: "u", device_id: "d", mapping_id: null, schema_version: "local-usage-observation-v1",
    adapter: "claude-otel-adapter-v1", tool_id: "claude-code", tool_version: "2.1.261", source_type: "native_otel",
    provider: "anthropic", model: "claude-opus-5", upstream_request_id: "req_real",
    input_tokens: 2, output_tokens: 18, cache_read_tokens: 28_726, cache_write_tokens: 33_033, reasoning_tokens: null, tool_tokens: null,
    estimated_cost_micros: 345_153, occurred_at: `${day}T11:40:07Z`, local_session_id: "s", local_event_id: "e",
    device_signature: "sig", signature_verified: true, verification_level: "device_attested", correlation_status: "unmatched",
    correlated_event_id: null, provider_identity_hash: "sha256:x", received_at: `${day}T11:40:10Z`, ...over,
  };
}

function event(over: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    id: "e1", user_id: "u", connection_id: null, provider: "anthropic", source: "gateway", external_reference: "live:x",
    model: "anthropic/claude-opus-5", occurred_at: `${day}T11:40:07Z`, input_tokens: 2, cached_input_tokens: 28_726, output_tokens: 18,
    requests: 1, actual_cost_micros: null, actual_cost_basis: null, normalized_cost_micros: 0,
    verification_type: "routed", verification_status: "confirmed", economic_status: "eligible", protocol_compute_micros: 5_000,
    pricing_status: "priced", protocol_pricing_version: "usage-pricing-v2", protocol_pricing_basis: "protocol_pricing",
    epoch_id: day, carried_forward: false, gateway_id: "usage-gateway", economic_source_class: "promotional",
    eligible_compute_micros: 0, reward_status: "held", reward_reason: "promotional_credit", reward_policy_version: "usage-reward-policy-v1",
    reconciliation_status: "clear", fraud_status: "clear", reward_hold: false,
    raw_metadata: { client_type: "claude-code", upstream_request_id: "req_real", cache_write_tokens: 33_033, reasoning_tokens: 7 },
    provenance_sources: ["usage_gateway"], verification_level: "routed_confirmed", correlation_status: "none",
    identity_trust_level: "account", provider_identity_hash: "sha256:x", created_at: `${day}T11:40:08Z`, ...over,
  };
}

describe("the real M13C observation", () => {
  it("exposes every category, and is not 'just 20 tokens'", () => {
    const s = summarizeUsage({ day, observations: [obs()], events: [] });
    expect(s.tracked).toEqual({ inputTokens: 2, outputTokens: 18, cacheReadTokens: 28_726, cacheWriteTokens: 33_033, reasoningTokens: 0, requestCount: 1 });
    expect(s.trackedTokens).toBe(20);
    expect(allTokens(s.tracked)).toBe(61_779);
    expect(s.recent[0].breakdown.cacheReadTokens).toBe(28_726);
    // Analytics, not verification and not money.
    expect(s.verifiedTokens).toBe(0);
    expect(s.eligibleComputeMicros).toBe(0);
  });
});

describe("categories", () => {
  it("cache-only request", () => {
    const s = summarizeUsage({ day, observations: [obs({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 5_000, cache_write_tokens: null })], events: [] });
    expect(s.tracked.cacheReadTokens).toBe(5_000);
    expect(freshTokens(s.tracked)).toBe(0);
    expect(s.tracked.requestCount).toBe(1);
  });

  it("cache-write request", () => {
    const s = summarizeUsage({ day, observations: [obs({ cache_read_tokens: null, cache_write_tokens: 1_234 })], events: [] });
    expect(s.tracked.cacheWriteTokens).toBe(1_234);
    expect(s.tracked.cacheReadTokens).toBe(0);
  });

  it("normal request with reasoning", () => {
    const s = summarizeUsage({ day, observations: [obs({ cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: 40, output_tokens: 100 })], events: [] });
    expect(s.tracked).toMatchObject({ inputTokens: 2, outputTokens: 100, reasoningTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Reasoning is part of output; it is shown, not added on top.
    expect(freshTokens(s.tracked)).toBe(102);
  });

  it("null categories count as zero, never as missing data that breaks the sum", () => {
    const s = summarizeUsage({ day, observations: [obs({ input_tokens: null, output_tokens: 5, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null })], events: [] });
    expect(s.tracked).toEqual({ inputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requestCount: 1 });
  });

  it("multiple tools add up per category and per request", () => {
    const s = summarizeUsage({
      day,
      observations: [obs(), obs({ id: "o2", tool_id: "codex", provider: "openai", model: "gpt-6-astra", input_tokens: 22_058, output_tokens: 5, cache_read_tokens: 12_544, cache_write_tokens: 0, local_event_id: "e2" })],
      events: [],
    });
    expect(s.tracked.requestCount).toBe(2);
    expect(s.tracked.inputTokens).toBe(22_060);
    expect(s.tracked.cacheReadTokens).toBe(41_270);
    expect(s.recent.map((r) => r.tool).sort()).toEqual(["claude-code", "codex"]);
  });
});

describe("matched local + routed evidence is one request", () => {
  it("does not double any category, and the trusted event's categories are the ones shown", () => {
    const s = summarizeUsage({ day, observations: [obs({ correlation_status: "matched", correlated_event_id: "e1" })], events: [event()] });
    expect(s.tracked.requestCount).toBe(1);
    expect(s.tracked).toEqual({ inputTokens: 2, outputTokens: 18, cacheReadTokens: 28_726, cacheWriteTokens: 33_033, reasoningTokens: 7, requestCount: 1 });
    expect(s.verified).toEqual(s.tracked);
    expect(s.recent).toHaveLength(1);
    expect(s.recent[0].status).toBe("routed");
  });

  it("an unmatched observation next to an unrelated event is two requests", () => {
    const s = summarizeUsage({ day, observations: [obs()], events: [event({ external_reference: "live:other", raw_metadata: { client_type: "probe" } })] });
    expect(s.tracked.requestCount).toBe(2);
    expect(s.tracked.cacheWriteTokens).toBe(33_033);
  });
});

describe("economics are untouched by the breakdown", () => {
  it("eligible compute comes only from eligible_compute_micros, whatever the tokens say", () => {
    const s = summarizeUsage({
      day,
      observations: [obs({ input_tokens: 100_000_000, cache_read_tokens: 100_000_000 })],
      events: [event({ eligible_compute_micros: 1_234, reward_status: "eligible" })],
    });
    expect(s.eligibleComputeMicros).toBe(1_234);
    expect(s.verified.inputTokens).toBe(2);
  });
});
