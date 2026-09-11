import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUNDED_DAILY_CAP_MICROS,
  DEFAULT_FUNDED_DAILY_REQUESTS,
  fundedDailyCapMicros,
  fundedDailyRequestLimit,
  fundedSpendDecision,
  utcDayStart,
  withinRequestBudget,
} from "./spend";

/**
 * The shared route spends USAGE's money, so the ceiling is the whole point.
 */

describe("fundedSpendDecision", () => {
  it("allows while strictly under the cap and refuses at it", () => {
    expect(fundedSpendDecision({ spentMicros: 0, capMicros: 250_000 }).allowed).toBe(true);
    expect(fundedSpendDecision({ spentMicros: 249_999, capMicros: 250_000 }).allowed).toBe(true);
    expect(fundedSpendDecision({ spentMicros: 250_000, capMicros: 250_000 }).allowed).toBe(false);
    expect(fundedSpendDecision({ spentMicros: 900_000, capMicros: 250_000 }).allowed).toBe(false);
  });

  it("reports what is left, never a negative", () => {
    expect(fundedSpendDecision({ spentMicros: 100_000, capMicros: 250_000 }).remainingMicros).toBe(150_000);
    expect(fundedSpendDecision({ spentMicros: 900_000, capMicros: 250_000 }).remainingMicros).toBe(0);
  });

  it("treats a zero cap as the shared route being closed", () => {
    expect(fundedSpendDecision({ spentMicros: 0, capMicros: 0 }).allowed).toBe(false);
  });

  it("does not let a negative or fractional spend open the door", () => {
    expect(fundedSpendDecision({ spentMicros: -5, capMicros: 0 }).allowed).toBe(false);
    expect(fundedSpendDecision({ spentMicros: 249_999.9, capMicros: 250_000 }).spentMicros).toBe(249_999);
  });
});

describe("fundedDailyCapMicros", () => {
  it("reads a configured cap and falls back to the default otherwise", () => {
    expect(fundedDailyCapMicros("1000000")).toBe(1_000_000);
    expect(fundedDailyCapMicros("0")).toBe(0);
    expect(fundedDailyCapMicros(undefined)).toBe(DEFAULT_FUNDED_DAILY_CAP_MICROS);
    expect(fundedDailyCapMicros("lots")).toBe(DEFAULT_FUNDED_DAILY_CAP_MICROS);
    expect(fundedDailyCapMicros("-1")).toBe(DEFAULT_FUNDED_DAILY_CAP_MICROS);
  });
});

describe("utcDayStart", () => {
  it("is midnight UTC of the given instant, regardless of the machine's zone", () => {
    expect(utcDayStart(new Date("2026-09-12T23:59:59.000Z"))).toBe("2026-09-12T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-09-12T00:00:00.000Z"))).toBe("2026-09-12T00:00:00.000Z");
  });
});

describe("request budget", () => {
  it("closes at the limit, so a cost-blind provider cannot run unbounded", () => {
    expect(withinRequestBudget(0, 60)).toBe(true);
    expect(withinRequestBudget(59, 60)).toBe(true);
    expect(withinRequestBudget(60, 60)).toBe(false);
    expect(withinRequestBudget(0, 0)).toBe(false);
  });

  it("reads a configured limit and falls back otherwise", () => {
    expect(fundedDailyRequestLimit("10")).toBe(10);
    expect(fundedDailyRequestLimit(undefined)).toBe(DEFAULT_FUNDED_DAILY_REQUESTS);
    expect(fundedDailyRequestLimit("many")).toBe(DEFAULT_FUNDED_DAILY_REQUESTS);
  });
});
