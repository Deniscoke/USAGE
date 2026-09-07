import { describe, expect, it } from "vitest";
import { usageEventKey } from "@/lib/domain/normalize";
import { listIntegrations } from "@/lib/providers/registry";
import { collectUsage } from "./collect";

const WINDOW = {
  since: new Date("2026-03-01T00:00:00.000Z"),
  until: new Date("2026-03-08T00:00:00.000Z"),
};

const CONNECTIONS = listIntegrations().map((integration) => ({
  provider: integration.provider,
  context: { connectionId: `test-${integration.provider}`, secrets: {}, config: {} },
}));

describe("collectUsage", () => {
  it("normalizes every registered demo provider into one shape", async () => {
    const result = await collectUsage(CONNECTIONS, WINDOW);

    expect(result.records.length).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    expect(new Set(result.records.map((r) => r.provider))).toEqual(
      new Set(["demo-provider", "demo-gateway", "demo-cli"]),
    );
    expect(new Set(result.records.map((r) => r.verificationType))).toEqual(
      new Set(["verified", "routed", "reported"]),
    );
  });

  it("is deterministic across runs", async () => {
    const a = await collectUsage(CONNECTIONS, WINDOW);
    const b = await collectUsage(CONNECTIONS, WINDOW);
    expect(b.records).toEqual(a.records);
  });

  it("stays inside the requested window", async () => {
    const { records } = await collectUsage(CONNECTIONS, WINDOW);
    for (const record of records) {
      const at = new Date(record.occurredAt).getTime();
      expect(at).toBeGreaterThanOrEqual(WINDOW.since.getTime());
      expect(at).toBeLessThan(WINDOW.until.getTime());
    }
  });

  it("re-importing the same window creates no duplicate usage", async () => {
    const first = await collectUsage(CONNECTIONS, WINDOW);
    const seen = new Set(first.records.map(usageEventKey));

    const second = await collectUsage(CONNECTIONS, WINDOW, seen);
    expect(second.records).toHaveLength(0);
    expect(second.duplicates).toBe(first.records.length);
  });

  it("isolates a failing connection instead of failing the sync", async () => {
    const result = await collectUsage(
      [...CONNECTIONS, { provider: "not-a-provider", context: { connectionId: "x", secrets: {}, config: {} } }],
      WINDOW,
    );
    expect(result.failures).toEqual([{ provider: "not-a-provider", error: "no adapter registered" }]);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it("prices reported usage from the estimate table, not a provider bill", async () => {
    const { records } = await collectUsage(CONNECTIONS, WINDOW);
    const reported = records.filter((r) => r.verificationType === "reported");
    expect(reported.length).toBeGreaterThan(0);
    for (const record of reported) {
      expect(record.reportedCostMicros).toBeNull();
      expect(record.normalizedCostMicros).toBeGreaterThan(0);
      expect(record.rawMetadata.cost_basis).toBe("estimated");
    }
  });

  it("never carries prompt or completion content into the domain model", async () => {
    const { records } = await collectUsage(CONNECTIONS, WINDOW);
    const forbidden = ["prompt", "completion", "content", "message", "text"];
    for (const record of records) {
      for (const key of Object.keys(record.rawMetadata)) {
        expect(forbidden.some((f) => key.toLowerCase().includes(f))).toBe(false);
      }
    }
  });
});
