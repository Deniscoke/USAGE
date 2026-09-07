import { describe, expect, it } from "vitest";
import { aggregateDaily, dedupeUsageRecords, totalsByVerification, usageEventKey } from "./normalize";
import type { NormalizedUsageRecord } from "./types";

function record(overrides: Partial<NormalizedUsageRecord> = {}): NormalizedUsageRecord {
  return {
    provider: "demo-provider",
    source: "provider_usage_api",
    externalReference: "ref-1",
    model: "demo-large",
    occurredAt: "2026-03-01T10:00:00.000Z",
    inputTokens: 1_000,
    cachedInputTokens: 500,
    outputTokens: 200,
    requests: 3,
    reportedCostMicros: 12_000,
    normalizedCostMicros: 12_000,
    verificationType: "verified",
    verificationStatus: "confirmed",
    rawMetadata: {},
    ...overrides,
  };
}

describe("dedupeUsageRecords", () => {
  it("is idempotent: importing the same batch twice adds nothing", () => {
    const batch = [record(), record({ externalReference: "ref-2" })];

    const first = dedupeUsageRecords(batch);
    expect(first.accepted).toHaveLength(2);
    expect(first.duplicates).toBe(0);

    const seen = new Set(first.accepted.map(usageEventKey));
    const second = dedupeUsageRecords(batch, seen);
    expect(second.accepted).toHaveLength(0);
    expect(second.duplicates).toBe(2);
  });

  it("treats the same reference from a different source as distinct", () => {
    const { accepted } = dedupeUsageRecords([
      record(),
      record({ source: "gateway", provider: "demo-gateway" }),
    ]);
    expect(accepted).toHaveLength(2);
  });

  it("drops duplicates inside a single batch", () => {
    const { accepted, duplicates } = dedupeUsageRecords([record(), record(), record()]);
    expect(accepted).toHaveLength(1);
    expect(duplicates).toBe(2);
  });
});

describe("aggregateDaily", () => {
  it("buckets by day, provider, model and verification type", () => {
    const aggregates = aggregateDaily([
      record({ externalReference: "a" }),
      record({ externalReference: "b", occurredAt: "2026-03-01T22:00:00.000Z" }),
      record({ externalReference: "c", occurredAt: "2026-03-02T01:00:00.000Z" }),
      record({ externalReference: "d", verificationType: "reported" }),
    ]);

    expect(aggregates).toHaveLength(3);
    const firstDayVerified = aggregates.find(
      (a) => a.day === "2026-03-01" && a.verificationType === "verified",
    );
    expect(firstDayVerified?.requests).toBe(6);
    expect(firstDayVerified?.costMicros).toBe(24_000);
  });
});

describe("totalsByVerification", () => {
  it("always returns all three levels", () => {
    const totals = totalsByVerification([record()]);
    expect(totals.verified.costMicros).toBe(12_000);
    expect(totals.routed.costMicros).toBe(0);
    expect(totals.reported.costMicros).toBe(0);
  });
});
