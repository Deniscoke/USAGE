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
