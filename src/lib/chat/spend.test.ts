import { describe, expect, it } from "vitest";
import { DEFAULT_FUNDED_DAILY_REQUESTS, fundedDailyRequestLimit, utcDayStart } from "./spend";

/**
 * The money ceiling moved to the wallet; what is tested here is the day
 * boundary and the message count, which no balance can influence.
 */

describe("utcDayStart", () => {
  it("is midnight UTC of the day the instant falls in", () => {
    expect(utcDayStart(new Date("2026-09-12T23:59:59.999Z"))).toBe("2026-09-12T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-09-12T00:00:00.000Z"))).toBe("2026-09-12T00:00:00.000Z");
  });

  it("does not follow the server's local timezone", () => {
    // 01:30 in Bratislava on the 13th is still the 12th in UTC.
    expect(utcDayStart(new Date("2026-09-12T23:30:00.000Z"))).toBe("2026-09-12T00:00:00.000Z");
  });
});

describe("fundedDailyRequestLimit", () => {
  it("takes a configured limit", () => {
    expect(fundedDailyRequestLimit("10")).toBe(10);
    expect(fundedDailyRequestLimit("0")).toBe(0);
  });

  it("falls back rather than trusting nonsense", () => {
    expect(fundedDailyRequestLimit(undefined)).toBe(DEFAULT_FUNDED_DAILY_REQUESTS);
    expect(fundedDailyRequestLimit("lots")).toBe(DEFAULT_FUNDED_DAILY_REQUESTS);
    expect(fundedDailyRequestLimit("-5")).toBe(DEFAULT_FUNDED_DAILY_REQUESTS);
  });
});
