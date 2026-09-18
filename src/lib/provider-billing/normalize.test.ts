import { describe, expect, it } from "vitest";
import { parseGithubUsageResponse } from "./github";
import { DuplicateIdentityError, normalizeGithubUsage, planUsageUpsert, type StoredBillingRow } from "./normalize";
import { planSyncRequests } from "./sync";
import { billingHeadline, summarizeBillingDays, summarizeBillingMonth, type BillingUsageRowView } from "./view";

const body = (net: string, model = "gpt-5.1") => `{"timePeriod":{"year":2026,"month":9},"user":"octo","usageItems":[
  {"product":"Copilot","sku":"Copilot AI Credits","model":"${model}","unitType":"credits","pricePerUnit":0.01,
   "grossQuantity":100,"grossAmount":1,"discountQuantity":40,"discountAmount":0.4,"netQuantity":60,"netAmount":${net}}]}`;

const rowsFor = (text: string, period = { year: 2026, month: 9 }) =>
  normalizeGithubUsage({ response: parseGithubUsageResponse(text), principalId: "583231", period });

function stored(text: string, revision = 1): StoredBillingRow[] {
  return rowsFor(text).map((row, i) => ({ ...row, id: `row-${i}`, revision, withdrawn: false, currentSnapshotId: "snap-1" }));
}

describe("normalization", () => {
  it("builds an identity without the fetch time", () => {
    const [row] = rowsFor(body("0.6"));
    expect(row.periodKind).toBe("month");
    expect(row.periodStart).toBe("2026-09-01");
    expect(JSON.parse(row.identityKey)).toEqual(["github", "583231", "personal", "month", "2026-09-01", "Copilot", "Copilot AI Credits", "gpt-5.1", "credits"]);
    const [day] = rowsFor(body("0.6"), { year: 2026, month: 9, day: 7 } as never);
    expect(day.periodKind).toBe("day");
    expect(day.periodStart).toBe("2026-09-07");
  });

  it("the same content changes nothing, not even the revision", () => {
    const plan = planUsageUpsert(stored(body("0.6")), rowsFor(body("0.60")));
    expect(plan).toEqual({ inserts: [], updates: [], withdrawals: [], unchanged: 1 });
  });

  it("a corrected value is an update of the same identity with revision + 1", () => {
    const plan = planUsageUpsert(stored(body("0.6"), 3), rowsFor(body("0.7")));
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].revision).toBe(4);
    expect(plan.updates[0].row.netAmountMicros).toBe(700_000);
    expect(plan.inserts).toHaveLength(0);
  });

  it("an item the provider no longer lists is withdrawn, never deleted", () => {
    const plan = planUsageUpsert(stored(body("0.6")), rowsFor(body("0.6", "other-model")));
    expect(plan.inserts).toHaveLength(1);
    expect(plan.withdrawals).toEqual([{ id: "row-0", revision: 2 }]);
  });

  it("refuses a response listing one identity twice", () => {
    const twice = `{"timePeriod":{"year":2026},"usageItems":[${[1, 2]
      .map(() => '{"product":"p","sku":"s","model":"m","unitType":"u","pricePerUnit":1,"grossQuantity":1,"grossAmount":1,"discountQuantity":0,"discountAmount":0,"netQuantity":1,"netAmount":1}')
      .join(",")}]}`;
    expect(() => rowsFor(twice)).toThrow(DuplicateIdentityError);
  });
});

describe("request planning", () => {
  it("on connect asks for the month and every day so far", () => {
    const plan = planSyncRequests("connect", new Date("2026-09-05T12:00:00Z"));
    expect(plan.months).toEqual([{ year: 2026, month: 9 }]);
    expect(plan.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5]);
  });

  it("scheduled early in a month also re-reads last month for corrections", () => {
    const plan = planSyncRequests("scheduled", new Date("2026-10-02T01:40:00Z"));
    expect(plan.months).toEqual([{ year: 2026, month: 10 }, { year: 2026, month: 9 }]);
    expect(plan.days).toEqual([
      { year: 2026, month: 9, day: 30 },
      { year: 2026, month: 10, day: 1 },
      { year: 2026, month: 10, day: 2 },
    ]);
  });

  it("manual refresh is today and yesterday only", () => {
    const plan = planSyncRequests("manual", new Date("2026-09-18T12:00:00Z"));
    expect(plan.months).toEqual([{ year: 2026, month: 9 }]);
    expect(plan.days.map((d) => d.day)).toEqual([17, 18]);
  });
});

describe("view", () => {
  const row = (over: Partial<BillingUsageRowView>): BillingUsageRowView => ({
    provider: "github",
    periodKind: "month",
    periodStart: "2026-09-01",
    product: "Copilot",
    sku: "Copilot AI Credits",
    model: "gpt-5.1",
    unitType: "credits",
    grossQuantityMicroUnits: 100_000_000,
    discountQuantityMicroUnits: 40_000_000,
    netQuantityMicroUnits: 60_000_000,
    grossAmountMicros: 1_000_000,
    discountAmountMicros: 400_000,
    netAmountMicros: 600_000,
    withdrawn: false,
    ...over,
  });

  it("sums month rows only, never day rows, and skips withdrawn items", () => {
    const [summary] = summarizeBillingMonth(
      [
        row({}),
        row({ model: "claude-sonnet-4.5", netAmountMicros: 50_000, grossAmountMicros: 50_000, discountAmountMicros: 0 }),
        row({ periodKind: "day", periodStart: "2026-09-03" }),
        row({ model: "gone", withdrawn: true }),
      ],
      "2026-09",
    );
    expect(summary.netAmountMicros).toBe(650_000);
    expect(summary.models).toEqual(["claude-sonnet-4.5", "gpt-5.1"]);
    expect(summary.units[0].unitType).toBe("credits");
    const days = summarizeBillingDays([row({ periodKind: "day", periodStart: "2026-09-03" })], "2026-09");
    expect(days.map((d) => d.day)).toEqual(["2026-09-03"]);
  });

  it("labels an empty personal response as not applicable, never as zero", () => {
    const headline = billingHeadline({
      provider: "github",
      login: "octo",
      status: "connected",
      billingScope: "no_data_or_managed",
      permissionState: "plan:read",
      lastSyncAt: null,
      lastSuccessAt: null,
      lastErrorClass: null,
    });
    expect(headline.availability).toBe("NOT APPLICABLE");
    expect(JSON.stringify(headline)).not.toMatch(/zero|0 credits/i);
  });
});
