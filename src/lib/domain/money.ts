/**
 * Integer money. USAGE stores every monetary value as micro-USD.
 *
 * Rationale: usage costs are frequently sub-cent (a single request can be
 * $0.000045). Cents lose that entirely and floats accumulate drift once you sum
 * millions of events, so we keep an integer with 6 decimal places of headroom.
 */

export const MICROS_PER_USD = 1_000_000;

/**
 * Parse a decimal USD string ("0.000123", "-4.5", "12") into micro-USD.
 * String-based on purpose: never route user/provider money through a float.
 */
export function usdStringToMicros(value: string): number {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid USD amount: ${JSON.stringify(value)}`);
  const [, sign, whole, frac = ""] = match;
  const micros = frac.slice(0, 6).padEnd(6, "0");
  const magnitude = Number(whole) * MICROS_PER_USD + Number(micros);
  return sign === "-" ? -magnitude : magnitude;
}

/** Micro-USD -> number of dollars. Only for display and score math, not storage. */
export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

export function sumMicros(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Multiply a micro amount by a token count expressed per one million tokens. */
export function microsPerMillionTokens(rateMicros: number, tokens: number): number {
  // Integer math throughout, rounding half-up at the very end.
  return Math.round((rateMicros * tokens) / 1_000_000);
}

export function formatUsd(micros: number, opts: { maximumFractionDigits?: number } = {}): string {
  const { maximumFractionDigits = 2 } = opts;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
  }).format(microsToUsd(micros));
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export interface ParsedCost {
  micros: number;
  /** True when the source carried more precision than micro-USD. */
  rounded: boolean;
}

/**
 * Parse an authoritative cost reported by a provider or gateway.
 *
 * Differs from `usdStringToMicros` in one deliberate way: providers quote costs
 * with more precision than micro-USD (a single cheap call can be
 * $0.0000004125), and silently truncating those to zero would under-report real
 * spend. This rounds half-up at the micro boundary and reports that it did so,
 * which keeps the rounding decision explicit and testable rather than implicit.
 *
 * Still string-based: a float never touches the value.
 */
export function usdCostToMicros(value: string | number): ParsedCost {
  // A JS number arriving from JSON is already a float; fix its decimal
  // representation once, with enough digits to preserve everything meaningful.
  const text = typeof value === "number" ? floatToDecimalString(value) : value.trim();

  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) throw new Error(`Invalid cost amount: ${JSON.stringify(value)}`);

  const [, sign, whole, frac = ""] = match;
  const micros = frac.slice(0, 6).padEnd(6, "0");
  const remainder = frac.slice(6);

  let magnitude = Number(whole) * MICROS_PER_USD + Number(micros);
  const roundUp = remainder.length > 0 && Number(remainder[0]) >= 5;
  if (roundUp) magnitude += 1;

  const rounded = remainder.replace(/0+$/, "").length > 0;
  return { micros: sign === "-" ? -magnitude : magnitude, rounded };
}

function floatToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid cost amount: ${value}`);
  // toFixed(12) is well past micro precision and avoids exponent notation for
  // the magnitudes any single AI request can produce.
  return value.toFixed(12);
}
