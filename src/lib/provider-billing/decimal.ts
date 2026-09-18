/**
 * Exact decimals for provider billing numbers.
 *
 * GitHub's billing API returns amounts and quantities as JSON numbers
 * (`"pricePerUnit": 0.01`, `"grossQuantity": 12.5`). `JSON.parse` would turn
 * those into IEEE-754 floats, and a float is not an authority on money: 0.1 is
 * already not 0.1. So the response is parsed with a reviver that captures the
 * number's SOURCE TEXT (the "JSON.parse source text access" feature, present
 * in Node 21+ / V8 11.4+), and every figure is kept as that exact text plus an
 * integer scaled from the text alone. A float never touches the value.
 *
 * If the runtime cannot hand back source text, parsing refuses rather than
 * silently falling back to floats.
 */

/** A JSON number, exactly as the provider wrote it. */
export interface DecimalLiteral {
  readonly kind: "decimal";
  /** The literal from the response body, e.g. "0.01" or "1e-2". */
  readonly source: string;
}

export class ExactJsonUnsupportedError extends Error {
  constructor() {
    super("This runtime cannot expose JSON number source text; refusing to parse billing numbers as floats.");
    this.name = "ExactJsonUnsupportedError";
  }
}

export function isDecimalLiteral(value: unknown): value is DecimalLiteral {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "decimal" &&
    typeof (value as { source?: unknown }).source === "string"
  );
}

type SourceReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

/**
 * Parse JSON text, replacing every number with a {@link DecimalLiteral}.
 * Throws SyntaxError on invalid JSON and ExactJsonUnsupportedError when the
 * runtime gives no source text.
 */
export function parseExactJson(text: string): unknown {
  const reviver: SourceReviver = (_key, value, context) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    if (typeof source !== "string") throw new ExactJsonUnsupportedError();
    return { kind: "decimal", source } satisfies DecimalLiteral;
  };
  return JSON.parse(text, reviver as (this: unknown, key: string, value: unknown) => unknown);
}

const LITERAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * A JSON number literal as a plain decimal string: no exponent, no redundant
 * leading zeros, no trailing fractional zeros, "0" for any zero.
 * "1e-2" -> "0.01", "12.50" -> "12.5", "-0.0" -> "0".
 */
export function canonicalDecimal(literal: string): string {
  const match = LITERAL.exec(literal.trim());
  if (!match) throw new Error(`Not a decimal literal: ${JSON.stringify(literal)}`);
  const [, sign, whole, frac = "", exp = "0"] = match;
  const exponent = Number(exp);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new Error(`Decimal exponent out of range: ${JSON.stringify(literal)}`);
  }
  const digits = whole + frac;
  let point = whole.length + exponent;
  let padded = digits;
  if (point < 0) {
    padded = "0".repeat(-point) + padded;
    point = 0;
  }
  if (point > padded.length) padded = padded + "0".repeat(point - padded.length);

  const intPart = padded.slice(0, point).replace(/^0+/, "") || "0";
  const fracPart = padded.slice(point).replace(/0+$/, "");
  const magnitude = fracPart ? `${intPart}.${fracPart}` : intPart;
  return magnitude === "0" || sign !== "-" ? magnitude : `-${magnitude}`;
}

export interface ScaledDecimal {
  /** The value times 10^scale, rounded half away from zero. A safe integer. */
  value: number;
  /** True when the literal carried more precision than the scale holds. */
  rounded: boolean;
}

/**
 * Scale a decimal literal to an integer at `scale` fractional digits, from the
 * string alone. Used for micro-USD (scale 6) and micro-units of quantity.
 * Refuses a result outside the exact integer range instead of losing precision.
 */
export function scaleDecimal(literal: string, scale = 6): ScaledDecimal {
  const plain = canonicalDecimal(literal);
  const negative = plain.startsWith("-");
  const [whole, frac = ""] = (negative ? plain.slice(1) : plain).split(".");
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  const remainder = frac.slice(scale);

  let magnitude = BigInt(whole) * BigInt(10) ** BigInt(scale) + BigInt(kept);
  if (remainder.length > 0 && Number(remainder[0]) >= 5) magnitude += BigInt(1);

  const signed = negative ? -magnitude : magnitude;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Decimal out of exact integer range at scale ${scale}: ${JSON.stringify(literal)}`);
  }
  return { value: Number(signed), rounded: remainder.length > 0 };
}

/** An integer-valued literal as a number, or null if it is not a safe integer. */
export function decimalToSafeInteger(literal: string): number | null {
  const plain = canonicalDecimal(literal);
  if (!/^-?\d+$/.test(plain)) return null;
  const value = Number(plain);
  return Number.isSafeInteger(value) ? value : null;
}

/** Format a micro-scaled integer back to a plain decimal string. Display only. */
export function formatMicroUnits(value: number, maxFractionDigits = 6): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
  const wholeText = new Intl.NumberFormat("en-US").format(whole);
  return `${negative ? "-" : ""}${wholeText}${frac ? `.${frac}` : ""}`;
}
