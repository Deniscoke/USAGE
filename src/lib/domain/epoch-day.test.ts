import { describe, expect, it } from "vitest";
import { isDayComplete, lastCompleteDay } from "@/lib/domain/epoch-day";

/**
 * The scheduled settlement's refusals.
 *
 * Crediting the ledger is permanent, so the interesting behaviour of this job
 * is everything it declines to do. The settlement maths itself is covered by
 * settlement.test.ts; what matters here is that a job running unattended every
 * night can never credit a day twice, credit a day early, or credit a day it
 * does not govern.
 */

describe("which day a nightly job may settle", () => {
  const now = new Date("2026-09-12T00:20:00.000Z");

  it("settles yesterday, never today", () => {
    // Today is still accumulating usage. Settling it would credit a partial
    // day and then refuse the rest of it forever, because settled allocations
    // are immutable.
    expect(lastCompleteDay(now)).toBe("2026-09-11");
  });

  it("treats a day as complete only once it is fully over in UTC", () => {
    expect(isDayComplete("2026-09-11", new Date("2026-09-12T00:00:00.000Z"))).toBe(true);
    expect(isDayComplete("2026-09-11", new Date("2026-09-11T23:59:59.000Z"))).toBe(false);
    // The job runs at 00:20 UTC; a deployment in a westerly timezone must not
    // change which day that is.
    expect(isDayComplete("2026-09-11", now)).toBe(true);
    expect(isDayComplete("2026-09-12", now)).toBe(false);
  });

  it("rejects a day that is not a day", () => {
    expect(isDayComplete("not-a-day", now)).toBe(false);
  });

  it("crosses a month boundary without arithmetic of its own", () => {
    expect(lastCompleteDay(new Date("2026-10-01T00:20:00.000Z"))).toBe("2026-09-30");
    expect(lastCompleteDay(new Date("2027-01-01T00:20:00.000Z"))).toBe("2026-12-31");
    // A leap day is a day like any other.
    expect(lastCompleteDay(new Date("2028-03-01T00:20:00.000Z"))).toBe("2028-02-29");
  });
});
