import { describe, expect, it } from "vitest";
import { MICROS_PER_USD, formatUsd, microsPerMillionTokens, sumMicros, usdStringToMicros } from "./money";

describe("usdStringToMicros", () => {
  it("parses whole and fractional dollars exactly", () => {
    expect(usdStringToMicros("1")).toBe(MICROS_PER_USD);
    expect(usdStringToMicros("0.01")).toBe(10_000);
    expect(usdStringToMicros("0.000123")).toBe(123);
    expect(usdStringToMicros("-4.5")).toBe(-4_500_000);
  });

  it("truncates beyond micro precision rather than rounding into float land", () => {
    expect(usdStringToMicros("0.0000009")).toBe(0);
    expect(usdStringToMicros("1.2345678")).toBe(1_234_567);
  });

  it("rejects malformed input", () => {
    expect(() => usdStringToMicros("1,00")).toThrow();
    expect(() => usdStringToMicros("abc")).toThrow();
    expect(() => usdStringToMicros("")).toThrow();
  });

  it("sums without floating point drift", () => {
    const values = Array.from({ length: 3 }, () => usdStringToMicros("0.1"));
    expect(sumMicros(values)).toBe(300_000);
    // The trap this design exists to avoid:
    expect(0.1 + 0.1 + 0.1).not.toBe(0.3);
  });
});

describe("microsPerMillionTokens", () => {
  it("prices token counts against a per-million rate", () => {
    expect(microsPerMillionTokens(3_000_000, 1_000_000)).toBe(3_000_000);
    expect(microsPerMillionTokens(3_000_000, 1_500)).toBe(4_500);
    expect(microsPerMillionTokens(250_000, 1)).toBe(0);
  });
});

describe("formatUsd", () => {
  it("formats micro amounts as dollars", () => {
    expect(formatUsd(14_280_000)).toBe("$14.28");
    expect(formatUsd(123, { maximumFractionDigits: 6 })).toBe("$0.000123");
  });
});
