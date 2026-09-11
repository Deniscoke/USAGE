import { describe, expect, it } from "vitest";
import { DEFAULT_STARTING_CREDIT_MICROS, creditDecision, startingCreditMicros } from "./credit";

/**
 * A grant, not a balance: the same for everyone, never growing, derived from
 * persisted spend rather than kept as a counter of its own.
 */

describe("creditDecision", () => {
  it("starts everyone with the full grant", () => {
    const d = creditDecision({ grantMicros: 500_000, spentLifetimeMicros: 0 });
    expect(d).toEqual({ grantMicros: 500_000, spentMicros: 0, remainingMicros: 500_000, allowed: true });
  });

  it("counts down from lifetime spend and closes at zero", () => {
    expect(creditDecision({ grantMicros: 500_000, spentLifetimeMicros: 34_600 }).remainingMicros).toBe(465_400);
    expect(creditDecision({ grantMicros: 500_000, spentLifetimeMicros: 500_000 }).allowed).toBe(false);
    expect(creditDecision({ grantMicros: 500_000, spentLifetimeMicros: 900_000 }).remainingMicros).toBe(0);
  });

  it("never goes negative on screen and never lets bad input open the door", () => {
    expect(creditDecision({ grantMicros: 0, spentLifetimeMicros: 0 }).allowed).toBe(false);
    expect(creditDecision({ grantMicros: 500_000, spentLifetimeMicros: -1 }).spentMicros).toBe(0);
  });
});

describe("startingCreditMicros", () => {
  it("reads a configured grant and falls back otherwise", () => {
    expect(startingCreditMicros("1000000")).toBe(1_000_000);
    expect(startingCreditMicros("0")).toBe(0);
    expect(startingCreditMicros(undefined)).toBe(DEFAULT_STARTING_CREDIT_MICROS);
    expect(startingCreditMicros("free")).toBe(DEFAULT_STARTING_CREDIT_MICROS);
  });
});
