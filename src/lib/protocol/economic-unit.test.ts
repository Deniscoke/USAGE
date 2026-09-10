import { describe, expect, it } from "vitest";
import {
  AUTHORITY_RANK,
  classifyEconomicSource,
  compareEvidence,
  ECONOMIC_VERIFICATION_POLICY_V1,
  economicEventKey,
  economicKeyOf,
  FIELD_AUTHORITY,
  getEconomicVerificationPolicy,
  modelFamily,
  preferByAuthority,
  selectAuthoritativeIdentity,
  verifyEconomically,
  type EconomicUsageEvidence,
} from "./economic-unit";
import { decideReward, deriveEconomicSource } from "./reward-policy";
import { snapshotExclusions } from "./snapshot";
import type { UsageEventRow } from "@/lib/supabase/database.types";

/**
 * The economic unit, as pure decisions. Nothing here touches a database; the
 * PGlite suite (src/lib/db/economic-unit.test.ts) proves the same rules hold
 * once rows exist.
 */

function evidence(overrides: Partial<EconomicUsageEvidence> = {}): EconomicUsageEvidence {
  return {
    source: "gateway",
    sourceAuthority: "usage_gateway",
    evidenceTrust: "trusted_server",
    provider: "anthropic",
    model: "anthropic/claude-sonnet-5",
    authoritativeRequestId: "req_011CV",
    gatewayGenerationId: "msg_01",
    inputTokens: 1_500,
    outputTokens: 240,
    cacheReadTokens: 800,
    cacheWriteTokens: null,
    reasoningTokens: null,
    actualCostMicros: 12_300,
    actualCostAuthority: "gateway_reported",
    fundingClass: "paid_account",
    occurredAt: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("economic identity is derived only from authoritative ids", () => {
  it("is the same key whoever observed the provider's request id", () => {
    const viaGateway = economicEventKey("anthropic", {
      kind: "provider_request_id", value: "req_ABC", authority: "usage_gateway", namespace: "anthropic",
    });
    const viaImport = economicEventKey("Anthropic", {
      kind: "provider_request_id", value: "req_ABC", authority: "provider_admin_import", namespace: "anthropic",
    });
    expect(viaGateway).toMatch(/^ecu1:[0-9a-f]{64}$/);
    expect(viaImport).toBe(viaGateway);
  });

  it("never mints a key from a device, however well-formed the id", () => {
    expect(economicEventKey("anthropic", {
      kind: "provider_request_id", value: "req_ABC", authority: "device", namespace: "anthropic",
    })).toBeNull();
    expect(selectAuthoritativeIdentity({
      sourceAuthority: "device", authoritativeRequestId: "req_ABC", gatewayGenerationId: "gen_1", provider: "anthropic",
    })).toBeNull();
  });

  it("is null without an identity, and never built from time, tokens or local ids", () => {
    expect(economicEventKey("anthropic", null)).toBeNull();
    expect(selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: null, gatewayGenerationId: null, provider: "anthropic",
    })).toBeNull();
    // Two requests that differ only in the things that must not matter share
    // nothing: without an id there is no key at all, so they cannot collide.
    const a = economicEventKey("anthropic", { kind: "gateway_generation_id", value: "gen_1", authority: "usage_gateway", namespace: "openrouter" });
    const b = economicEventKey("anthropic", { kind: "gateway_generation_id", value: "gen_2", authority: "usage_gateway", namespace: "openrouter" });
    expect(a).not.toBe(b);
  });

  it("prefers the provider's request id over the gateway's generation id", () => {
    const id = selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: "req_1", gatewayGenerationId: "gen_1", gatewayId: "openrouter", provider: "anthropic",
    });
    expect(id?.kind).toBe("provider_request_id");
    const fallback = selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: null, gatewayGenerationId: "gen_1", gatewayId: "openrouter", provider: "anthropic",
    });
    expect(fallback).toEqual({ kind: "gateway_generation_id", value: "gen_1", authority: "usage_gateway", namespace: "anthropic" });
  });

  it("uses a provider request id only where the provider documents one as unique", () => {
    // OpenRouter documents no request-id header; whatever `x-request-id` it
    // sent is a proxy's, so the documented generation id anchors the unit.
    const viaOpenRouter = selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: "cf-ray-like", gatewayGenerationId: "gen-abc", gatewayId: "connection:c1", provider: "openrouter",
    });
    expect(viaOpenRouter).toEqual({ kind: "gateway_generation_id", value: "gen-abc", authority: "usage_gateway", namespace: "openrouter" });
  });

  it("scopes a user-controlled endpoint's ids to its connection, and never to a label", () => {
    const a = selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: "req_X", gatewayGenerationId: "chatcmpl-1", gatewayId: "connection:aaaa", provider: "anthropic", endpointControlledByUser: true,
    });
    const b = selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: "req_X", gatewayGenerationId: "chatcmpl-1", gatewayId: "connection:bbbb", provider: "anthropic", endpointControlledByUser: true,
    });
    expect(a?.namespace).toBe("connection:aaaa");
    expect(b?.namespace).toBe("connection:bbbb");
    expect(economicEventKey("anthropic", a)).not.toBe(economicEventKey("anthropic", b));
    // Without a server-issued connection scope a user-controlled id is nothing.
    expect(selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: "req_X", gatewayGenerationId: null, gatewayId: null, provider: "anthropic", endpointControlledByUser: true,
    })).toBeNull();
  });

  it("gives a trusted provider's global id the same key whichever connection or user saw it", () => {
    const seenByA = selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: "req_GLOBAL", gatewayGenerationId: "msg_1", gatewayId: "connection:aaaa", provider: "anthropic",
    });
    const seenByB = selectAuthoritativeIdentity({
      sourceAuthority: "usage_gateway", authoritativeRequestId: "req_GLOBAL", gatewayGenerationId: "msg_2", gatewayId: "connection:bbbb", provider: "anthropic",
    });
    expect(economicEventKey("anthropic", seenByA)).toBe(economicEventKey("anthropic", seenByB));
    // And the key contains no USAGE user at all: there is no such input.
    expect(String(economicEventKey("anthropic", seenByA))).not.toContain("aaaa");
  });

  it("does not accept a client-shaped key from metadata unless it is one of ours", () => {
    expect(economicKeyOf({ economic_event_key: "sha256:deadbeef" })).toBeNull();
    expect(economicKeyOf({ economic_event_key: 42 })).toBeNull();
    expect(economicKeyOf({ economic_event_key: "ecu1:" + "a".repeat(64) })).toBe("ecu1:" + "a".repeat(64));
  });
});

describe("classification: cost > 0 is not payment", () => {
  const base = {
    gatewayId: "connection:1", actualCostMicros: 12_300, actualCostAuthority: "gateway_reported",
    usageFunded: false, endpointControlledByUser: false, funding: null,
  };

  it("is metered_paid only with a provider-stated paying account", () => {
    expect(classifyEconomicSource({ ...base, funding: { class: "paid_account", basis: "t" } })).toBe("metered_paid");
    expect(classifyEconomicSource(base)).toBe("unknown");
  });

  it("calls a positive cost on a never-paid account promotional", () => {
    expect(classifyEconomicSource({ ...base, funding: { class: "free_tier_account", basis: "t" } })).toBe("promotional");
  });

  it("calls USAGE's own budget promotional, whatever the account says", () => {
    expect(classifyEconomicSource({ ...base, usageFunded: true, funding: { class: "paid_account", basis: "t" } })).toBe("promotional");
    expect(classifyEconomicSource({ ...base, gatewayId: "vercel-ai-gateway", funding: { class: "usage_credit", basis: "t" } })).toBe("promotional");
  });

  it("accepts a stated zero from anywhere, and calls a user-controlled cost a claim", () => {
    expect(classifyEconomicSource({ ...base, actualCostMicros: 0, endpointControlledByUser: true })).toBe("free");
    expect(classifyEconomicSource({ ...base, endpointControlledByUser: true, funding: { class: "paid_account", basis: "t" } })).toBe("byok");
  });

  it("calls the user's own upstream key byok, and a flat plan subscription", () => {
    expect(classifyEconomicSource({ ...base, funding: { class: "byok_upstream", basis: "t" } })).toBe("byok");
    expect(classifyEconomicSource({ ...base, subscription: true })).toBe("subscription");
  });

  it("is never looser than the M9 rule it replaces", () => {
    // Every input the old rule called free or promotional, the new one does too.
    for (const cost of [0, 12_300, null]) {
      for (const usageFunded of [true, false]) {
        const old = deriveEconomicSource({ gatewayId: "connection:1", actualCostMicros: cost, actualCostBasis: "gateway_reported", usageFunded });
        const now = classifyEconomicSource({ ...base, actualCostMicros: cost, usageFunded });
        if (old === "free" || old === "promotional") expect(now).toBe(old);
        if (now === "metered_paid") expect(old).toBe("metered_paid");
      }
    }
  });
});

describe("economic-verification-v1", () => {
  const verified = { evidence: evidence(), economicEventKey: "ecu1:x", dedupeStatus: "unique" as const, sourceClass: "metered_paid" as const };

  it("verifies metered paid compute with identity, usage and paid funding", () => {
    expect(verifyEconomically(verified)).toEqual({ status: "verified", reason: "metered_paid_verified", policyVersion: "economic-verification-v1" });
  });

  it("never verifies device-only evidence, signed or not", () => {
    const d = verifyEconomically({ ...verified, evidence: evidence({ sourceAuthority: "device", evidenceTrust: "device_reported" }) });
    expect(d).toMatchObject({ status: "not_verified", reason: "local_only" });
  });

  it("requires an authoritative identity and trusted evidence", () => {
    expect(verifyEconomically({ ...verified, economicEventKey: null })).toMatchObject({ status: "not_verified", reason: "no_authoritative_identity" });
    expect(verifyEconomically({ ...verified, evidence: evidence({ evidenceTrust: "unknown" }) })).toMatchObject({ status: "not_verified", reason: "evidence_not_trusted" });
    expect(verifyEconomically({ ...verified, evidence: evidence({ inputTokens: null, outputTokens: null }) })).toMatchObject({ status: "held", reason: "usage_not_authoritative" });
  });

  it("holds duplicates and conflicts before looking at money", () => {
    expect(verifyEconomically({ ...verified, dedupeStatus: "duplicate" })).toMatchObject({ status: "held", reason: "duplicate_unit" });
    expect(verifyEconomically({ ...verified, dedupeStatus: "conflict" })).toMatchObject({ status: "held", reason: "identity_conflict" });
  });

  it("holds metered_paid whose funding is not provider-stated, even at a positive cost", () => {
    expect(verifyEconomically({ ...verified, evidence: evidence({ fundingClass: null }) })).toMatchObject({ status: "held", reason: "funding_unknown" });
  });

  it("holds byok until the upstream account is proven paid", () => {
    expect(verifyEconomically({ ...verified, sourceClass: "byok", evidence: evidence({ fundingClass: "byok_upstream" }) })).toMatchObject({ status: "held", reason: "byok_funding_unproven" });
    expect(verifyEconomically({ ...verified, sourceClass: "byok" })).toMatchObject({ status: "verified", reason: "byok_paid_verified" });
    // A user-controlled endpoint cannot be proven paid by anything it says.
    expect(verifyEconomically({ ...verified, sourceClass: "byok", evidence: evidence({ endpointControlledByUser: true }) })).toMatchObject({ status: "held", reason: "byok_funding_unproven" });
  });

  it("free is ineligible; promotional, subscription and unknown are held", () => {
    expect(verifyEconomically({ ...verified, sourceClass: "free" })).toMatchObject({ status: "ineligible", reason: "free_inference" });
    expect(verifyEconomically({ ...verified, sourceClass: "promotional" })).toMatchObject({ status: "held", reason: "promotional_funding" });
    expect(verifyEconomically({ ...verified, sourceClass: "subscription" })).toMatchObject({ status: "held", reason: "subscription_pending_policy" });
    expect(verifyEconomically({ ...verified, sourceClass: "unknown" })).toMatchObject({ status: "held", reason: "funding_unknown" });
  });

  it("agrees with the reward policy on every class", () => {
    for (const sourceClass of ["metered_paid", "byok", "subscription", "free", "promotional", "unknown"] as const) {
      const verification = verifyEconomically({ ...verified, sourceClass, evidence: evidence({ fundingClass: sourceClass === "metered_paid" ? "paid_account" : "unknown" }) });
      const reward = decideReward({ proofStatus: "confirmed", verificationType: "routed", economicSource: sourceClass, protocolComputeMicros: 1000 });
      if (verification.status === "verified") expect(reward.status).toBe("eligible");
      if (verification.status === "ineligible") expect(reward.status).toBe("ineligible");
      if (verification.status === "held") expect(reward.status).not.toBe("eligible");
    }
  });

  it("is a published, resolvable, versioned policy", () => {
    expect(getEconomicVerificationPolicy("economic-verification-v1")).toBe(ECONOMIC_VERIFICATION_POLICY_V1);
    expect(getEconomicVerificationPolicy("economic-verification-v0")).toBeNull();
    expect(ECONOMIC_VERIFICATION_POLICY_V1.status).toBe("active");
  });
});

describe("conflicts and authority", () => {
  const trusted = { authority: "usage_gateway" as const, provider: "anthropic", model: "anthropic/claude-sonnet-5", inputTokens: 1_500, outputTokens: 240, actualCostMicros: 12_300 };

  it("tolerates rounding but not disagreement on token counts", () => {
    expect(compareEvidence({ ...trusted, authority: "device", inputTokens: 1_512, outputTokens: 241, actualCostMicros: null }, trusted)).toEqual([]);
    expect(compareEvidence({ ...trusted, authority: "device", outputTokens: 2_400, actualCostMicros: null }, trusted)).toEqual(["output_tokens"]);
  });

  it("treats a model family as one model, and a different family as a conflict", () => {
    expect(modelFamily("anthropic/claude-sonnet-5")).toBe(modelFamily("claude-sonnet-5-20260501"));
    expect(compareEvidence({ ...trusted, model: "claude-opus-5" }, trusted)).toEqual(["model"]);
  });

  it("treats a missing value as 'did not say', not as a disagreement", () => {
    expect(compareEvidence({ ...trusted, model: null, inputTokens: null, outputTokens: null, actualCostMicros: null }, trusted)).toEqual([]);
  });

  it("notes a provider or cost disagreement", () => {
    expect(compareEvidence({ ...trusted, provider: "openai" }, trusted)).toEqual(["provider"]);
    expect(compareEvidence({ ...trusted, actualCostMicros: 1 }, trusted)).toEqual(["actual_cost"]);
  });

  it("lets a higher authority win a field only where the documented order says so", () => {
    const tokens = [
      { authority: "device" as const, value: 999 },
      { authority: "usage_gateway" as const, value: 240 },
      { authority: "provider" as const, value: 241 },
    ];
    expect(preferByAuthority("token_usage", tokens)).toBe(241);
    expect(preferByAuthority("token_usage", tokens.filter((t) => t.authority !== "provider"))).toBe(240);
    // A device may never win a cost or a funding class, even alone.
    expect(preferByAuthority("actual_cost", [{ authority: "device", value: 5 }])).toBeNull();
    expect(preferByAuthority("funding_class", [{ authority: "device", value: "paid_account" }])).toBeNull();
    expect(FIELD_AUTHORITY.observed_by_device).toEqual(["device"]);
    expect(AUTHORITY_RANK.provider).toBeLessThan(AUTHORITY_RANK.device);
  });
});

describe("a future snapshot admits only the bottom of the ladder", () => {
  const settled: UsageEventRow = {
    id: "e", user_id: "u", connection_id: null, provider: "anthropic", source: "gateway", external_reference: "live:x",
    model: "anthropic/claude-sonnet-5", occurred_at: "2026-09-10T10:00:00Z", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1,
    requests: 1, actual_cost_micros: 100, actual_cost_basis: "gateway_reported", normalized_cost_micros: 100,
    verification_type: "routed", verification_status: "confirmed", economic_status: "settled", protocol_compute_micros: 90,
    pricing_status: "priced", protocol_pricing_version: "usage-pricing-v2", protocol_pricing_basis: "protocol_pricing",
    epoch_id: "2026-09-10", carried_forward: false, gateway_id: "connection:1", economic_source_class: "metered_paid",
    eligible_compute_micros: 90, reward_status: "eligible", reward_reason: "metered_paid", reward_policy_version: "usage-reward-policy-v1",
    reconciliation_status: "clear", fraud_status: "clear", reward_hold: false,
    raw_metadata: { dedupe_status: "unique", economic_verification_policy_version: "economic-verification-v1" },
    provenance_sources: ["usage_gateway"], verification_level: "routed_confirmed", correlation_status: "none",
    identity_trust_level: "account", provider_identity_hash: null, economic_event_key: null, dedupe_status: "unkeyed", economic_verification_status: null, economic_verification_policy_version: null, created_at: "2026-09-10T10:00:01Z",
  };

  it("admits a settled, unique, eligible, priced, confirmed paid unit", () => {
    expect(snapshotExclusions(settled)).toEqual([]);
  });

  it("refuses every rung it must refuse", () => {
    expect(snapshotExclusions({ ...settled, verification_status: "pending" })).toContain("not_confirmed");
    expect(snapshotExclusions({ ...settled, verification_type: "reported" })).toContain("reported_only");
    expect(snapshotExclusions({ ...settled, reward_status: "held" })).toContain("reward_not_eligible");
    expect(snapshotExclusions({ ...settled, reward_hold: true })).toContain("reward_held");
    expect(snapshotExclusions({ ...settled, pricing_status: "pending_pricing", protocol_pricing_version: null })).toContain("not_priced");
    expect(snapshotExclusions({ ...settled, economic_status: "eligible" })).toContain("not_settled");
    expect(snapshotExclusions({ ...settled, raw_metadata: { dedupe_status: "duplicate" } })).toContain("duplicate_or_conflict");
    expect(snapshotExclusions({ ...settled, raw_metadata: { dedupe_status: "conflict" } })).toContain("duplicate_or_conflict");
    expect(snapshotExclusions({ ...settled, economic_source_class: "free" })).toContain("free_or_promotional");
    expect(snapshotExclusions({ ...settled, economic_source_class: "promotional" })).toContain("free_or_promotional");
  });
});
