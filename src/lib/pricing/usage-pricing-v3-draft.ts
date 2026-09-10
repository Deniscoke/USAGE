import { USAGE_PRICING_V2 } from "./usage-pricing-v2";
import type { ProtocolPricingSnapshot } from "./types";
import type { UnknownCachePolicy } from "./exact";

/**
 * PROSPECTIVE PRICING SNAPSHOT — usage-pricing-v3 (DRAFT, NOT REGISTERED)
 *
 * Same prices as v2. Two behavioural changes, both from M15B:
 *
 *   1. valuation is exact in pico-USD, rounded once per (account, epoch),
 *      never per request (see ./exact.ts);
 *   2. an absent cache price does NOT fall back to the input rate. The cache
 *      component of such a request is PENDING until a pricing version states
 *      the rate. Unknown ≠ equal.
 *
 * This file is deliberately absent from `SNAPSHOTS` in ./compute.ts: nothing
 * can price an event with it. Activation is an owner decision and a separate
 * change. v1 and v2 are frozen and untouched.
 */
export interface ProspectivePricingSnapshot extends ProtocolPricingSnapshot {
  status: "draft";
  unknownCachePolicy: UnknownCachePolicy;
  valuation: "pico_exact";
}

export const USAGE_PRICING_V3_DRAFT: ProspectivePricingSnapshot = {
  ...USAGE_PRICING_V2,
  version: "usage-pricing-v3",
  source: `${USAGE_PRICING_V2.source} (prices carried from usage-pricing-v2)`,
  effectiveFrom: "TBD-on-activation",
  status: "draft",
  unknownCachePolicy: "pending",
  valuation: "pico_exact",
};
