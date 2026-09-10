import { describe, expect, it } from "vitest";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { SCORING_VERSION_V2_DRAFT, scoreRecordsPico, scoreRecords } from "@/lib/domain/scoring";
import { usageRecordToInsert } from "./rows";

/**
 * M16A — the pico ingestion path. Server-derived exact economics for units
 * priced under a pico_exact version; nothing a client sends can set them.
 */

const KEY = generateSigningKeyPair("m16a-pico");
const ISSUANCE = { issuer: "usage://issuer/production", keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 };

function observation(over: Partial<GatewayObservation> = {}): GatewayObservation {
  return {
    environment: "live",
    generationId: `gen-${Math.random().toString(36).slice(2)}`,
    model: "openai/gpt-5.4",
    clientType: "usage-miner",
    servedByProvider: "Azure",
    gatewayId: "connection:22222222-2222-4222-8222-222222222222",
    endpointTrusted: true,
    funding: { class: "paid_account", basis: "fixture:SIMULATED paid_account" },
    occurredAt: "2026-09-12T10:00:00.000Z",
    usage: { inputTokens: 1400, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 400 } },
    cost: { value: "0.004", currency: "USD" },
    finishReason: "stop",
    ...over,
  };
}

describe("pico economics under usage-pricing-v3", () => {
  const norm = (over: Partial<GatewayObservation> = {}) => normalizeGatewayObservation(observation(over), { pricingVersion: "usage-pricing-v3", issuance: ISSUANCE, userId: "u" });

  it("derives exact pico server-side: input 1000×2,500,000 + cache read 400×250,000 + output 100×15,000,000", () => {
    const { record } = norm();
    expect(record.protocolPricingVersion).toBe("usage-pricing-v3");
    expect(record.protocolComputePico).toBe((1000n * 2_500_000n + 400n * 250_000n + 100n * 15_000_000n).toString());
    expect(record.eligibleComputePico).toBe(record.protocolComputePico);
    expect(record.pricingComponentsPending).toEqual([]);
    // The micro column is the once-rounded display of the same value.
    expect(record.protocolComputeMicros).toBe(Number((BigInt(record.protocolComputePico!) + 500_000n) / 1_000_000n));
  });

  it("eligible pico never exceeds protocol pico, and a held unit has eligible 0 with protocol intact", () => {
    const { record } = norm({ funding: { class: "free_tier_account", basis: "fixture:SIMULATED free" } });
    expect(record.rewardStatus).not.toBe("eligible");
    expect(record.eligibleComputePico).toBe("0");
    expect(BigInt(record.protocolComputePico!)).toBeGreaterThan(0n);
  });

  it("a unit that used an unpriced cache-write class is pending as a whole: no protocol value, no pico, component named", () => {
    const { record } = norm({ usage: { inputTokens: 1050, outputTokens: 100, inputTokenDetails: { cacheWriteTokens: 50 } } });
    expect(record.protocolComputeMicros).toBeUndefined();
    expect(record.protocolPricingVersion).toBeNull();
    expect(record.protocolComputePico).toBeNull();
    expect(record.eligibleComputePico).toBeNull();
    expect(record.pricingComponentsPending).toEqual(["cacheWrite"]);
    expect(record.economicStatus).toBe("pending_pricing");
    const row = usageRecordToInsert("u", record, null);
    expect(row.pricing_status).toBe("pending_pricing");
    expect(row.eligible_compute_pico).toBeNull();
  });

  it("a model v3 does not price (nemotron) is pending; under v2 the same request is priced at the v2 rate", () => {
    const v3 = norm({ model: "nvidia/nemotron-3-nano-30b-a3b" }).record;
    expect(v3.protocolComputePico).toBeNull();
    expect(v3.economicStatus).toBe("pending_pricing");
    const v2 = normalizeGatewayObservation(observation({ model: "nvidia/nemotron-3-nano-30b-a3b" }), { pricingVersion: "usage-pricing-v2", issuance: ISSUANCE, userId: "u" }).record;
    expect(v2.protocolComputeMicros).toBeGreaterThan(0);
    expect(v2.protocolComputePico).toBeNull(); // v2 is micro-rounded, no pico
  });

  it("the default pricing version follows the occurrence epoch's protocol: v2 while mining-dev-v1 governs", () => {
    const { record } = normalizeGatewayObservation(observation({ occurredAt: "2026-09-12T10:00:00.000Z" }), { issuance: ISSUANCE, userId: "u" });
    expect(record.protocolPricingVersion).toBe("usage-pricing-v2");
    expect(record.protocolComputePico).toBeNull();
  });

  it("request splitting is exact in pico: 10 requests of 100 tokens equal 1 request of 1000", () => {
    const one = BigInt(norm({ usage: { inputTokens: 1000, outputTokens: 0 } }).record.protocolComputePico!);
    let many = 0n;
    for (let i = 0; i < 10; i += 1) many += BigInt(norm({ usage: { inputTokens: 100, outputTokens: 0 } }).record.protocolComputePico!);
    expect(many).toBe(one);
  });

  it("usage_score_v2 sums exact pico with BigInt and reports units it cannot score", () => {
    const eligible = norm().record;
    const held = norm({ funding: { class: "free_tier_account", basis: "fixture" } }).record;
    const legacy = normalizeGatewayObservation(observation(), { pricingVersion: "usage-pricing-v2", issuance: ISSUANCE, userId: "u" }).record;
    const exact = scoreRecordsPico([eligible, eligible, held, legacy]);
    expect(exact.weightedComputePico).toBe(2n * BigInt(eligible.protocolComputePico!));
    expect(exact.eligibleWithoutPico).toBe(1); // the v2-priced legacy unit
    // The legacy v1 path is unchanged for the same records.
    expect(scoreRecords([legacy], "usage_score_v1").points).toBeGreaterThan(0);
    expect(scoreRecords([eligible], SCORING_VERSION_V2_DRAFT).points).toBe(eligible.eligibleComputeMicros);
  });
});
