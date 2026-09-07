import { describe, expect, it } from "vitest";
import { rowToUsageRecord, toSafeInteger, usageRecordToInsert } from "./rows";
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
    reported_cost_micros: 4_500,
    normalized_cost_micros: 4_500,
    verification_type: "verified",
    verification_status: "confirmed",
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
    const record = rowToUsageRecord({ ...row, reported_cost_micros: null });
    expect(record.reportedCostMicros).toBeNull();
    expect(usageRecordToInsert("u1", record, null).reported_cost_micros).toBeNull();
  });
});
