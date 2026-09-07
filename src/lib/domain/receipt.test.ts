import { describe, expect, it } from "vitest";
import { canonicalReceipt, receiptHash, RECEIPT_VERSION, verifyReceiptHash, type ProofReceipt } from "./receipt";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

function receipt(overrides: Partial<ProofReceipt> = {}): ProofReceipt {
  return {
    receiptVersion: RECEIPT_VERSION,
    userId: "user-1",
    source: "vercel_ai_gateway",
    clientType: "claude-code",
    provider: "anthropic",
    model: "anthropic/claude-haiku-4.5",
    generationId: "gen_abc",
    generationIdSource: "gateway_generation_id",
    trustEnvironment: "production",
    inputTokens: 100,
    cachedReadTokens: 20,
    cachedWriteTokens: 0,
    outputTokens: 40,
    reasoningTokens: null,
    requests: 1,
    costMicroUsd: 12_345,
    costBasis: "gateway_reported",
    currency: "USD",
    occurredAt: "2026-04-20T10:00:00.000Z",
    observedAt: "2026-04-20T10:00:01.000Z",
    verificationType: "routed",
    verificationStatus: "confirmed",
    adapterVersion: "vercel-gateway@1",
    ...overrides,
  };
}

describe("receipt hashing", () => {
  it("is deterministic for identical receipts", () => {
    expect(receiptHash(receipt())).toBe(receiptHash(receipt()));
    expect(receiptHash(receipt())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not depend on property insertion order", () => {
    const a = receipt();
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as ProofReceipt;
    expect(receiptHash(reordered)).toBe(receiptHash(a));
  });

  it("normalizes the occurrence timestamp so equivalent times hash alike", () => {
    expect(receiptHash(receipt({ occurredAt: "2026-04-20T12:00:00.000+02:00" }))).toBe(
      receiptHash(receipt({ occurredAt: "2026-04-20T10:00:00.000Z" })),
    );
  });

  it("excludes observation time: re-ingesting the same generation hashes the same", () => {
    expect(receiptHash(receipt({ observedAt: "2027-01-01T00:00:00.000Z" }))).toBe(
      receiptHash(receipt()),
    );
  });

  it("changes when any economically meaningful field changes", () => {
    const base = receiptHash(receipt());
    const mutations: Partial<ProofReceipt>[] = [
      { userId: "user-2" },
      { generationId: "gen_other" },
      { model: "anthropic/claude-opus-5" },
      { inputTokens: 101 },
      { outputTokens: 41 },
      { costMicroUsd: 12_346 },
      { costBasis: "unavailable" },
      { trustEnvironment: "development" },
      { verificationType: "reported" },
      { verificationStatus: "pending" },
      { adapterVersion: "vercel-gateway@2" },
    ];
    for (const mutation of mutations) {
      expect(receiptHash(receipt(mutation))).not.toBe(base);
    }
  });

  it("distinguishes unknown from zero", () => {
    expect(receiptHash(receipt({ costMicroUsd: null }))).not.toBe(
      receiptHash(receipt({ costMicroUsd: 0 })),
    );
    expect(canonicalReceipt(receipt({ costMicroUsd: null }))).toContain("costMicroUsd=null");
  });

  it("verifies a stored hash and detects tampering", () => {
    const original = receipt();
    const hash = receiptHash(original);
    expect(verifyReceiptHash(original, hash)).toBe(true);
    // Someone inflating the recorded spend after the fact.
    expect(verifyReceiptHash(receipt({ costMicroUsd: 9_999_999 }), hash)).toBe(false);
  });

  it("covers no prompt, response or credential material", () => {
    const canonical = canonicalReceipt(receipt());
    const covered = canonical.split("\n").map((entry) => entry.split("=")[0]);
    // Note: *TokenS* fields are counts, not credentials — the words that must
    // never appear are content and credential words.
    for (const forbidden of ["prompt", "message", "content", "apikey", "authorization", "secret"]) {
      expect(covered.some((field) => field.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});

describe("receipts produced by the gateway adapter", () => {
  const observation: GatewayObservation = {
    environment: "live",
    generationId: "gen_live_1",
    model: "anthropic/claude-haiku-4.5",
    clientType: "claude-code",
    servedByProvider: "anthropic",
    occurredAt: "2026-04-20T10:00:00.000Z",
    usage: {
      inputTokens: 120,
      outputTokens: 40,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5 },
    },
    cost: { value: "0.012345", currency: "USD" },
  };

  it("hashes the same observation identically across ingests", () => {
    const first = normalizeGatewayObservation(observation, {
      userId: "user-1",
      observedAt: "2026-04-20T10:00:01.000Z",
    });
    const second = normalizeGatewayObservation(observation, {
      userId: "user-1",
      observedAt: "2026-04-21T23:59:59.000Z",
    });
    expect(second.proof.proofHash).toBe(first.proof.proofHash);
  });

  it("binds the receipt to a user", () => {
    const a = normalizeGatewayObservation(observation, { userId: "user-1" });
    const b = normalizeGatewayObservation(observation, { userId: "user-2" });
    expect(a.proof.proofHash).not.toBe(b.proof.proofHash);
  });

  it("records the trust environment that produced it", () => {
    expect(normalizeGatewayObservation(observation).receipt.trustEnvironment).toBe("production");
    expect(
      normalizeGatewayObservation({ ...observation, environment: "development" }).receipt
        .trustEnvironment,
    ).toBe("development");
  });
});
