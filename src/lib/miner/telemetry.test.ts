import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalObservation,
  correlate,
  initialLevel,
  providerIdentityHash,
  validateIncoming,
  verifyDeviceSignature,
  type IncomingObservation,
} from "./telemetry";
import { LOCAL_TOOLS, VERIFICATION_RANK, meteringMethodFor } from "./tools";
import { summarizeUsage } from "./usage-summary";
import type { LocalUsageObservationRow, UsageEventRow } from "@/lib/supabase/database.types";

/**
 * The server side of the invariant: a device may describe what it saw, and it
 * may not describe what it is worth. These are the decisions a route makes
 * before anything touches a table.
 */

const good: IncomingObservation = {
  schema: "local-usage-observation-v1",
  adapter: "claude-otel-adapter-v1",
  tool: "claude-code",
  toolVersion: "2.1.261",
  sourceType: "native_otel",
  provider: "anthropic",
  model: "claude-sonnet-5",
  upstreamRequestId: "req_011CV",
  inputTokens: 1500,
  outputTokens: 240,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
  reasoningTokens: null,
  toolTokens: null,
  estimatedCostMicros: 12300,
  occurredAt: "2026-09-09T10:00:00.000Z",
  localSessionId: "sess",
  localEventId: "abc123",
};

describe("validateIncoming", () => {
  it("accepts a well-formed Claude observation", () => {
    const r = validateIncoming({ observation: good, signature: null });
    expect(r.ok).toBe(true);
  });

  it("rejects any field a client could use to declare trust or money", () => {
    for (const key of ["proof_status", "verification_type", "economic_status", "reward_status", "eligible_compute_micros", "protocol_compute_micros", "points", "pricing"]) {
      const r = validateIncoming({ observation: { ...good, [key]: "eligible" }, signature: null });
      expect(r.ok, key).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/forbidden_field/);
    }
  });

  it("rejects unknown fields rather than ignoring them", () => {
    const r = validateIncoming({ observation: { ...good, prompt_hash: "x" }, signature: null });
    expect(r.ok).toBe(false);
  });

  it("rejects content-shaped fields outright", () => {
    for (const key of ["prompt", "response", "messages", "body"]) {
      expect(validateIncoming({ observation: { ...good, [key]: "hello" }, signature: null }).ok).toBe(false);
    }
  });

  it("refuses a request id from a tool whose telemetry cannot carry one", () => {
    const codex = { ...good, tool: "codex", adapter: "codex-otel-adapter-v1", provider: "openai", model: null, upstreamRequestId: "resp_fake" };
    const r = validateIncoming({ observation: codex, signature: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("identity_not_expected");
    // Without the fabricated id it is a fine analytics observation.
    expect(validateIncoming({ observation: { ...codex, upstreamRequestId: null }, signature: null }).ok).toBe(true);
  });

  it("refuses an adapter version the server does not know", () => {
    const r = validateIncoming({ observation: { ...good, adapter: "claude-otel-adapter-v9" }, signature: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported_adapter");
  });

  it("refuses a provider that does not match the tool", () => {
    expect(validateIncoming({ observation: { ...good, provider: "openai" }, signature: null }).ok).toBe(false);
  });

  it("refuses absurd or negative token counts and an observation with no usage", () => {
    expect(validateIncoming({ observation: { ...good, inputTokens: -1 }, signature: null }).ok).toBe(false);
    expect(validateIncoming({ observation: { ...good, inputTokens: 10 ** 12 }, signature: null }).ok).toBe(false);
    expect(validateIncoming({ observation: { ...good, inputTokens: 1.5 }, signature: null }).ok).toBe(false);
    expect(validateIncoming({ observation: { ...good, inputTokens: null, outputTokens: null }, signature: null }).ok).toBe(false);
  });

  it("refuses an unsupported schema cleanly", () => {
    const r = validateIncoming({ observation: { ...good, schema: "local-usage-observation-v2" }, signature: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported_schema");
  });
});

describe("device signature", () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signOf = (o: IncomingObservation) => sign(null, Buffer.from(canonicalObservation(o)), pair.privateKey).toString("base64");

  it("verifies what the device signed and nothing else", () => {
    const signature = signOf(good);
    expect(verifyDeviceSignature(publicKey, good, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKey, { ...good, inputTokens: 999_999 }, signature)).toBe(false);
    expect(verifyDeviceSignature("bm90IGEga2V5", good, signature)).toBe(false);
  });

  it("proves origin only: a verified signature reaches device_attested and no higher", () => {
    expect(initialLevel(true)).toBe("device_attested");
    expect(initialLevel(false)).toBe("local_observed");
    expect(VERIFICATION_RANK.device_attested).toBeLessThan(VERIFICATION_RANK.provider_correlated);
  });
});

describe("correlation is exact or nothing", () => {
  it("leaves an observation without identity at its base level, uncorrelated", () => {
    const d = correlate({ upstreamRequestId: null, signatureVerified: true }, null);
    expect(d.observation).toEqual({ correlationStatus: "none", level: "device_attested", correlatedEventId: null });
    expect(d.event).toBeNull();
  });

  it("marks an unmatched id as unmatched, not as verified", () => {
    const d = correlate({ upstreamRequestId: "req_x", signatureVerified: false }, null);
    expect(d.observation.correlationStatus).toBe("unmatched");
    expect(d.observation.level).toBe("local_observed");
  });

  it("upgrades provenance on a match and touches nothing economic", () => {
    const d = correlate(
      { upstreamRequestId: "req_x", signatureVerified: false },
      { eventId: "ev-1", verificationLevel: "routed_confirmed", provenanceSources: ["usage_gateway"] },
    );
    expect(d.observation.level).toBe("provider_correlated");
    expect(d.observation.correlatedEventId).toBe("ev-1");
    expect(d.event).toEqual({ eventId: "ev-1", provenanceSources: ["local_telemetry", "usage_gateway"], correlationStatus: "matched" });
    // The update the server will apply has exactly these keys. No reward,
    // no compute, no status, no price can be expressed through it.
    expect(Object.keys(d.event!).sort()).toEqual(["correlationStatus", "eventId", "provenanceSources"]);
  });

  it("does not duplicate a provenance source on repeated correlation", () => {
    const d = correlate(
      { upstreamRequestId: "req_x", signatureVerified: true },
      { eventId: "ev-1", verificationLevel: "routed_confirmed", provenanceSources: ["local_telemetry", "usage_gateway"] },
    );
    expect(d.event!.provenanceSources).toEqual(["local_telemetry", "usage_gateway"]);
  });

  it("hashes provider identity without revealing it, and only when there is one", () => {
    expect(providerIdentityHash("anthropic", null)).toBeNull();
    const h = providerIdentityHash("anthropic", "req_x");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).not.toContain("req_x");
    expect(providerIdentityHash("openai", "req_x")).not.toBe(h);
  });
});

describe("tool registry truthfulness", () => {
  it("only Claude Code can reach provider_correlated on its own", () => {
    expect(LOCAL_TOOLS["claude-code"].verificationCapability).toBe("provider_correlated");
    expect(LOCAL_TOOLS["gemini-cli"].verificationCapability).toBe("device_attested");
    expect(LOCAL_TOOLS.codex.verificationCapability).toBe("device_attested");
    expect(LOCAL_TOOLS.codex.experimental).toBe(true);
    expect(LOCAL_TOOLS.cursor.meteringMethods).toEqual(["unsupported"]);
    expect(meteringMethodFor(LOCAL_TOOLS.cursor)).toBe("unsupported");
  });

  it("no tool's ceiling reaches a routed or imported rung from telemetry alone", () => {
    for (const tool of Object.values(LOCAL_TOOLS)) {
      expect(VERIFICATION_RANK[tool.verificationCapability]).toBeLessThan(VERIFICATION_RANK.routed_confirmed);
    }
  });
});

describe("tracked / verified / eligible stay separate", () => {
  const day = "2026-09-09";
  const obs = (over: Partial<LocalUsageObservationRow>): LocalUsageObservationRow => ({
    id: "o", user_id: "u", device_id: "d", mapping_id: null, schema_version: "local-usage-observation-v1",
    adapter: "claude-otel-adapter-v1", tool_id: "claude-code", tool_version: null, source_type: "native_otel",
    provider: "anthropic", model: "claude-sonnet-5", upstream_request_id: null,
    input_tokens: 1000, output_tokens: 200, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, tool_tokens: null,
    estimated_cost_micros: null, occurred_at: `${day}T10:00:00Z`, local_session_id: "s", local_event_id: "e",
    device_signature: null, signature_verified: false, verification_level: "local_observed", correlation_status: "none",
    correlated_event_id: null, provider_identity_hash: null, received_at: `${day}T10:00:01Z`, ...over,
  });
  const event = (over: Partial<UsageEventRow>): UsageEventRow => ({
    id: "e1", user_id: "u", connection_id: null, provider: "anthropic", source: "gateway", external_reference: "live:x",
    model: "anthropic/claude-sonnet-5", occurred_at: `${day}T11:00:00Z`, input_tokens: 500, cached_input_tokens: 0, output_tokens: 100,
    requests: 1, actual_cost_micros: 3000, actual_cost_basis: "gateway_reported", normalized_cost_micros: 3000,
    verification_type: "routed", verification_status: "confirmed", economic_status: "eligible",
    protocol_compute_micros: 2500, pricing_status: "priced", protocol_pricing_version: "usage-pricing-v2", protocol_pricing_basis: "protocol_pricing",
    epoch_id: "epoch-2026-09-09", carried_forward: false, gateway_id: "connection:c", economic_source_class: "metered_paid",
    eligible_compute_micros: 2500, reward_status: "eligible", reward_reason: "metered_paid", reward_policy_version: "usage-reward-policy-v1",
    reconciliation_status: "clear", fraud_status: "none", reward_hold: false, raw_metadata: { client_type: "claude-code" },
    provenance_sources: ["usage_gateway"], verification_level: "routed_confirmed", correlation_status: "none",
    identity_trust_level: "account", provider_identity_hash: null, created_at: `${day}T11:00:01Z`, ...over,
  });

  it("counts local-only usage as tracked, never as verified or eligible", () => {
    const s = summarizeUsage({ day, observations: [obs({ input_tokens: 5_000_000, output_tokens: 1_000_000 })], events: [] });
    expect(s.trackedTokens).toBe(6_000_000);
    expect(s.verifiedTokens).toBe(0);
    expect(s.eligibleComputeMicros).toBe(0);
    expect(s.recent[0].status).toBe("tracked");
  });

  it("counts a matched observation and its event once", () => {
    const s = summarizeUsage({
      day,
      observations: [obs({ correlation_status: "matched", verification_level: "provider_correlated", correlated_event_id: "e1" })],
      events: [event({})],
    });
    expect(s.trackedTokens).toBe(600);
    expect(s.verifiedTokens).toBe(600);
    expect(s.eligibleComputeMicros).toBe(2500);
  });

  it("free confirmed compute is verified but not eligible", () => {
    const s = summarizeUsage({
      day,
      observations: [],
      events: [event({ economic_source_class: "free", reward_status: "ineligible", eligible_compute_micros: 0, protocol_compute_micros: null, pricing_status: "pending_pricing" })],
    });
    expect(s.verifiedTokens).toBe(600);
    expect(s.eligibleComputeMicros).toBe(0);
  });
});
