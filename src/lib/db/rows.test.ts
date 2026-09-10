import { describe, expect, it } from "vitest";
import { rowToUsageRecord, toSafeInteger, usageRecordToInsert } from "./rows";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { UsageEventRow } from "@/lib/supabase/database.types";

describe("toSafeInteger", () => {
  it("accepts exact integers from numbers and strings", () => {
    expect(toSafeInteger(123, "cost")).toBe(123);
    expect(toSafeInteger("123", "cost")).toBe(123);
    expect(toSafeInteger(null, "cost")).toBe(0);
  });

  it("refuses to silently lose precision", () => {
    expect(() => toSafeInteger(Number.MAX_SAFE_INTEGER + 2, "cost")).toThrow(/exact integer range/);
    expect(() => toSafeInteger(1.5, "cost")).toThrow(/integer/);
    expect(() => toSafeInteger("not-a-number", "cost")).toThrow(/integer/);
  });
});

describe("row mapping", () => {
  const row: UsageEventRow = {
    id: "e1",
    user_id: "u1",
    connection_id: "c1",
    provider: "demo-provider",
    source: "provider_usage_api",
    external_reference: "ref-1",
    model: "demo-large",
    occurred_at: "2026-03-15T10:00:00+00:00",
    input_tokens: 10,
    cached_input_tokens: 5,
    output_tokens: 2,
    requests: 1,
    actual_cost_micros: 4_500,
    actual_cost_basis: "gateway_reported",
    normalized_cost_micros: 4_500,
    verification_type: "verified",
    verification_status: "confirmed",
    economic_status: "eligible",
    protocol_compute_micros: 4_500,
    pricing_status: "priced",
    provenance_sources: ["provider_import"],
    verification_level: "provider_verified_import",
    correlation_status: "none",
    identity_trust_level: "account",
    provider_identity_hash: null, economic_event_key: null, dedupe_status: "unkeyed", economic_verification_status: null, economic_verification_policy_version: null,
    protocol_pricing_version: "usage-pricing-v1",
    protocol_pricing_basis: "protocol_pricing",
    epoch_id: "epoch-2026-03-15",
    carried_forward: false,
    gateway_id: "vercel-ai-gateway",
    economic_source_class: "metered_paid",
    eligible_compute_micros: 4_500,
    reward_status: "eligible",
    reward_reason: "metered_paid",
    reward_policy_version: "usage-reward-policy-v1",
    reconciliation_status: "clear",
    fraud_status: "none",
    reward_hold: false,
    raw_metadata: { bucket: "hour" },
    created_at: "2026-03-15T10:01:00+00:00",
  };

  it("round-trips a stored row back into the domain shape", () => {
    const record = rowToUsageRecord(row);
    expect(record).toMatchObject({
      provider: "demo-provider",
      externalReference: "ref-1",
      occurredAt: "2026-03-15T10:00:00.000Z",
      normalizedCostMicros: 4_500,
      verificationType: "verified",
    });

    const insert = usageRecordToInsert("u1", record, "c1");
    expect(insert.normalized_cost_micros).toBe(row.normalized_cost_micros);
    expect(insert.verification_type).toBe(row.verification_type);
    expect(insert.external_reference).toBe(row.external_reference);
  });

  it("preserves a null reported cost as an estimate marker", () => {
    const record = rowToUsageRecord({ ...row, actual_cost_micros: null });
    expect(record.actualCostMicros).toBeNull();
    expect(usageRecordToInsert("u1", record, null).actual_cost_micros).toBeNull();
  });
});

describe("unknown protocol compute is not zero", () => {
  // The distinction the whole of migration 0015 exists to preserve. Zero used
  // to mean both "priced at nothing" and "we have no price", which are
  // different economic facts -- and only one of them could ever earn.
  const STORED: UsageEventRow = {
    id: "e2",
    user_id: "u1",
    connection_id: null,
    provider: "openrouter",
    source: "gateway",
    external_reference: "live:gen-1",
    model: "vendor/model",
    occurred_at: "2026-04-10T12:00:00+00:00",
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 5,
    requests: 1,
    actual_cost_micros: 0,
    actual_cost_basis: "gateway_reported",
    normalized_cost_micros: 0,
    verification_type: "routed",
    verification_status: "confirmed",
    economic_status: "pending_pricing",
    protocol_compute_micros: null,
    pricing_status: "pending_pricing",
    protocol_pricing_version: null,
    protocol_pricing_basis: null,
    provenance_sources: ["usage_gateway"],
    verification_level: "routed_confirmed",
    correlation_status: "none",
    identity_trust_level: "account",
    provider_identity_hash: null, economic_event_key: null, dedupe_status: "unkeyed", economic_verification_status: null, economic_verification_policy_version: null,
    epoch_id: null,
    carried_forward: false,
    gateway_id: "connection:c1",
    economic_source_class: "free",
    eligible_compute_micros: 0,
    reward_status: "ineligible",
    reward_reason: "free_inference",
    reward_policy_version: "usage-reward-policy-v1",
    reconciliation_status: "clear",
    fraud_status: "none",
    reward_hold: false,
    raw_metadata: {},
    created_at: "2026-04-10T12:00:01+00:00",
  };

  const base: NormalizedUsageRecord = {
    provider: "openrouter",
    source: "gateway",
    externalReference: "live:gen-1",
    model: "vendor/model",
    occurredAt: "2026-04-10T12:00:00.000Z",
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    requests: 1,
    actualCostMicros: 0,
    normalizedCostMicros: 0,
    verificationType: "routed",
    verificationStatus: "confirmed",
    rawMetadata: {},
  };

  it("writes NULL and pending_pricing when no snapshot priced it", () => {
    const row = usageRecordToInsert("u1", { ...base, protocolPricingVersion: null }, null);
    expect(row.protocol_compute_micros).toBeNull();
    expect(row.pricing_status).toBe("pending_pricing");
  });

  it("keeps a genuine priced zero as zero", () => {
    const row = usageRecordToInsert(
      "u1",
      { ...base, protocolComputeMicros: 0, protocolPricingVersion: "usage-pricing-v1" },
      null,
    );
    expect(row.protocol_compute_micros).toBe(0);
    expect(row.pricing_status).toBe("priced");
  });

  it("never reports an unpriced record as worth zero when read back", () => {
    const unpriced = rowToUsageRecord({
      ...STORED,
      protocol_compute_micros: null,
      pricing_status: "pending_pricing",
      protocol_pricing_version: null,
    });
    // Undefined, not 0: a caller adding this up must not silently include it.
    expect(unpriced.protocolComputeMicros).toBeUndefined();

    const pricedZero = rowToUsageRecord({
      ...STORED,
      protocol_compute_micros: 0,
      pricing_status: "priced",
      protocol_pricing_version: "usage-pricing-v1",
    });
    expect(pricedZero.protocolComputeMicros).toBe(0);
  });

  it("refuses to believe a value with no pricing snapshot behind it", () => {
    // Belt and braces: even if a row somehow carries a number with no version,
    // the reader treats it as unknown rather than as economic weight.
    const suspicious = rowToUsageRecord({
      ...STORED,
      protocol_compute_micros: 999_999,
      pricing_status: "unknown_legacy",
      protocol_pricing_version: null,
    });
    expect(suspicious.protocolComputeMicros).toBeUndefined();
  });
});
