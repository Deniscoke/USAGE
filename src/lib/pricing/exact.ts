/**
 * Exact protocol compute value — the precision design from M15B.
 *
 * THE PROBLEM. `protocolComputeValue` rounds every token class of every
 * request half-up to a whole micro-USD. Ten 10-token requests of a model
 * priced at 50,000 micro-USD per million tokens are worth 10 micro; one
 * 100-token request is worth 5. The leak is bounded (0.5 micro per class per
 * request) but it is a property of the representation, not of the economics.
 *
 * THE FIX. Prices are integers in micro-USD per MILLION tokens. Therefore the
 * value of ONE token is exactly `price` PICO-USD (10^-12 USD):
 *
 *     price micro/1e6 tokens = price × 10^-6 micro per token
 *                            = price × 10^-12 USD per token
 *                            = price pico-USD per token
 *
 * So `value_pico = price × tokens` with no division and no rounding at all.
 * Any integer price, any integer token count, exact. The sum over a day is a
 * BigInt (a $100,000 day is 10^17 pico, past 2^53, hence BigInt, not Number).
 * Rounding to micro-USD, if a display or a legacy column needs it, happens
 * ONCE on the aggregate, never per request. Splitting a request into any
 * number of pieces then yields exactly the same pico total, by construction.
 *
 * Why not nano-USD: nano = price × tokens / 1000, exact only when the product
 * divides by 1000. Every price in usage-pricing-v1/v2 happens to be a multiple
 * of 1000, so nano would work today and break on the first $0.0000015/token
 * model. Pico needs no such luck. Rationals would be exact too, but pico IS
 * the rational with a fixed denominator, and one integer column beats two.
 *
 * NOTHING HERE IS ACTIVE. `protocolComputeValue` (micro, per-request rounding)
 * remains what production writes. Settled v1 history is not re-priced.
 */
import { findModelPrice, getPricingSnapshot } from "./compute";
import type { ProtocolModelPrice } from "./types";

export type UnknownCachePolicy =
  /** v1/v2 behaviour: an absent cache price falls back to the input rate. */
  | "input_rate"
  /** M15B recommendation: an absent cache price makes that component PENDING. */
  | "pending";

export interface ExactComputeTokens {
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
}

export type ComputeComponent = "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning";

export interface ExactProtocolComputeValue {
  /** Exact value in pico-USD. */
  pico: bigint;
  /** `pico` rounded half-up to micro-USD ONCE. For display and legacy columns. */
  microsRoundedOnce: number;
  pricingVersion: string;
  components: Record<ComputeComponent, bigint>;
  /**
   * Components whose price the snapshot does not state and the policy refuses
   * to guess. Non-empty means the value is a LOWER BOUND and the event's
   * pricing status should be `pending`, not `priced`.
   */
  pendingComponents: ComputeComponent[];
}

const PICO_PER_MICRO = 1_000_000n;

function assertCount(tokens: number, label: string): void {
  if (!Number.isInteger(tokens) || tokens < 0) throw new Error(`Invalid ${label}: ${tokens}`);
}

/** Exact pico-USD for `tokens` at `microsPerMillion`. No rounding exists to do. */
export function priceTokensPico(microsPerMillion: number, tokens: number): bigint {
  if (!Number.isInteger(microsPerMillion) || microsPerMillion < 0) throw new Error(`Invalid price: ${microsPerMillion}`);
  assertCount(tokens, "token count");
  return BigInt(microsPerMillion) * BigInt(tokens);
}

/** Half-up, once. */
export function picoToMicrosRounded(pico: bigint): number {
  const value = (pico + PICO_PER_MICRO / 2n) / PICO_PER_MICRO;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Protocol compute value exceeds exact integer range");
  return Number(value);
}

export function exactProtocolComputeValue(
  price: ProtocolModelPrice,
  version: string,
  tokens: ExactComputeTokens,
  policy: UnknownCachePolicy,
): ExactProtocolComputeValue {
  const pending: ComputeComponent[] = [];
  const rate = (component: "cacheRead" | "cacheWrite", stated: number | null, count: number): number => {
    if (stated !== null) return stated;
    if (policy === "input_rate") return price.inputMicrosPerMillion;
    if (count > 0) pending.push(component);
    return 0;
  };
  const components = {
    input: priceTokensPico(price.inputMicrosPerMillion, tokens.inputTokens),
    cacheRead: priceTokensPico(rate("cacheRead", price.cacheReadMicrosPerMillion, tokens.cachedReadTokens), tokens.cachedReadTokens),
    cacheWrite: priceTokensPico(rate("cacheWrite", price.cacheWriteMicrosPerMillion, tokens.cachedWriteTokens), tokens.cachedWriteTokens),
    output: priceTokensPico(price.outputMicrosPerMillion, tokens.outputTokens),
    reasoning: priceTokensPico(price.reasoningMicrosPerMillion ?? 0, tokens.reasoningTokens ?? 0),
  };
  const pico = components.input + components.cacheRead + components.cacheWrite + components.output + components.reasoning;
  return { pico, microsRoundedOnce: picoToMicrosRounded(pico), pricingVersion: version, components, pendingComponents: pending };
}

/** Convenience over a registered snapshot version. Null when the model is unpriced. */
export function exactProtocolComputeValueFor(
  version: string,
  model: string,
  tokens: ExactComputeTokens,
  policy: UnknownCachePolicy = getPricingSnapshot(version)?.unknownCachePolicy ?? "input_rate",
): ExactProtocolComputeValue | null {
  const price = findModelPrice(version, model);
  return price ? exactProtocolComputeValue(price, version, tokens, policy) : null;
}

/** True when the snapshot values compute exactly in pico-USD (v3+). */
export function isPicoExactVersion(version: string): boolean {
  return getPricingSnapshot(version)?.valuation === "pico_exact";
}

/**
 * Audit: which prices in a snapshot would change behaviour under the
 * `pending` policy — i.e. have cache traffic valued at the input rate today.
 */
export function auditUnknownCachePrices(prices: readonly ProtocolModelPrice[]): { model: string; missing: ("cacheRead" | "cacheWrite")[]; zeroPriced: boolean }[] {
  return prices
    .map((p) => ({
      model: p.model,
      missing: [...(p.cacheReadMicrosPerMillion === null ? (["cacheRead"] as const) : []), ...(p.cacheWriteMicrosPerMillion === null ? (["cacheWrite"] as const) : [])],
      zeroPriced: p.inputMicrosPerMillion === 0 && p.outputMicrosPerMillion === 0,
    }))
    .filter((row) => row.missing.length > 0);
}
