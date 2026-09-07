import type { CostBasis } from "./receipt";

/**
 * Cost reconciliation seam.
 *
 * Proof and money are separate layers. A confirmed proof records what compute
 * happened; what it cost may arrive later, from a different source, or never.
 * Resolvers are how that gap closes without touching the proof itself.
 *
 * Deliberately minimal: one resolver exists today (the gateway's own figure).
 * The others are named so the shape is obvious, not implemented on speculation.
 */

export interface CostQuery {
  provider: string;
  model: string;
  generationId: string;
  inputTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  outputTokens: number | null;
  /** Whatever the observation itself carried, if anything. */
  reportedCostMicros: number | null;
}

export interface ResolvedCost {
  costMicroUsd: number | null;
  costBasis: CostBasis;
  /** Which price list or source produced this, for auditability. */
  pricingSource: string | null;
  pricingVersion: string | null;
}

export interface CostResolver {
  readonly name: string;
  /** Returns null when this resolver has nothing authoritative to say. */
  resolve(query: CostQuery): Promise<ResolvedCost | null>;
}

/**
 * The only resolver in use: the gateway told us the cost at request time.
 * Authoritative, because it comes from the party doing the billing.
 */
export const gatewayReportedCostResolver: CostResolver = {
  name: "gateway_reported",
  async resolve(query) {
    if (query.reportedCostMicros === null) return null;
    return {
      costMicroUsd: query.reportedCostMicros,
      costBasis: "gateway_reported",
      pricingSource: "vercel-ai-gateway",
      pricingVersion: null,
    };
  },
};

/**
 * Resolve a cost from the first resolver that has an answer.
 *
 * When none does, the result is explicitly unknown — never zero, and never a
 * price we made up. Unknown cost keeps a proof economically pending; it does not
 * make the proof less true.
 */
export async function resolveCost(
  query: CostQuery,
  resolvers: readonly CostResolver[] = [gatewayReportedCostResolver],
): Promise<ResolvedCost> {
  for (const resolver of resolvers) {
    const resolved = await resolver.resolve(query);
    if (resolved) return resolved;
  }
  return {
    costMicroUsd: null,
    costBasis: "unavailable",
    pricingSource: null,
    pricingVersion: null,
  };
}

/**
 * Planned, NOT implemented:
 *
 *   vercel_reporting   — Custom Reporting reconciliation. Plan-gated, so core
 *                        Proof of Usage must never depend on it.
 *   provider_billing   — importing an invoice from the provider directly.
 *   price_table        — computing from a versioned model price snapshot.
 *
 * A price-table figure is an ESTIMATE and is recorded as such
 * (`costBasis: "estimated"` with pricingSource/pricingVersion). It may inform a
 * UI. It must not make usage economically eligible: an estimate is not an
 * invoice, and paying rewards against one would be paying against a guess.
 * `deriveEconomicStatus` therefore treats "estimated" as pending_cost.
 */
export const UNIMPLEMENTED_RESOLVERS = [
  "vercel_reporting",
  "provider_billing",
  "price_table",
] as const;
