import { describe, expect, it } from "vitest";
import { recentCompleteDays, settlementRunStatus } from "./settlement-run";

describe("recentCompleteDays", () => {
  it("looks at the three finished days before today, oldest first", () => {
    const now = new Date("2026-09-15T00:20:00.000Z");
    expect(recentCompleteDays(3, now)).toEqual(["2026-09-12", "2026-09-13", "2026-09-14"]);
  });

  it("never includes the day that is still running", () => {
    const now = new Date("2026-09-14T23:59:59.000Z");
    expect(recentCompleteDays(3, now)).not.toContain("2026-09-14");
  });

  it("gives yesterday alone when asked for one day, as the job used to", () => {
    expect(recentCompleteDays(1, new Date("2026-09-14T00:20:00.000Z"))).toEqual(["2026-09-13"]);
  });
});

describe("settlementRunStatus", () => {
  it("is healthy when days settled or had nothing to do", () => {
    expect(settlementRunStatus(["skipped", "settled", "skipped"])).toBe(200);
  });

  it("fails the run when any day was refused, so the scheduler shows it", () => {
    expect(settlementRunStatus(["settled", "refused", "skipped"])).toBe(500);
  });
});
