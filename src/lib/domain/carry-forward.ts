import type { NormalizedUsageRecord } from "./types";

/**
 * A late unit that crosses a pricing boundary is held, not settled.
 *
 * THE FAILURE THIS PREVENTS. A unit is priced under the version of the day it
 * happened. If it is ingested after that day's epoch has closed, ingestion
 * carries it forward to the next open epoch. When that next epoch is governed
 * by a different pricing version -- as epoch-2026-09-14 is, the first
 * mining-beta-v2 epoch -- the unit arrives priced under the old version and
 * with no exact pico value. The beta-v2 settlement function refuses the WHOLE
 * epoch if a single eligible unit is like that, so one late request would
 * have stopped every participant being paid for the day, every night, with the
 * cron reporting success.
 *
 * WHY HOLD AND NOT RE-PRICE. Re-pricing would put a number on this compute
 * that no snapshot produced at the time it happened, and "provider cost is
 * authoritative or unknown" applies to protocol prices too. Holding keeps the
 * evidence, keeps the proof valid, earns nothing, and never blocks anyone
 * else. It is only reachable at a protocol cutover, for a unit that was
 * already late, which is rare enough that honesty costs almost nothing.
 */

export const CARRIED_ACROSS_PRICING_REASON = "carried_across_pricing_boundary";

export function holdIfCarriedAcrossPricing<T extends NormalizedUsageRecord & { epochId: string; carriedForward: boolean }>(
  record: T,
  pricingForAssignedEpoch: string,
): T {
  if (!record.carriedForward) return record;
  // Already not earning: nothing to protect settlement from.
  if (record.rewardHold || (record.rewardStatus && record.rewardStatus !== "eligible")) return record;
  // Unpriced units are not eligible anyway, and an unknown version is not a
  // mismatch we can prove.
  if (!record.protocolPricingVersion) return record;
  if (record.protocolPricingVersion === pricingForAssignedEpoch) return record;

  return {
    ...record,
    rewardHold: true,
    eligibleComputeMicros: 0,
    rewardStatus: "held",
    rewardReason: CARRIED_ACROSS_PRICING_REASON,
    rawMetadata: {
      ...record.rawMetadata,
      economic_verification_status: "held",
      economic_verification_reason: CARRIED_ACROSS_PRICING_REASON,
      carried_from_pricing_version: record.protocolPricingVersion,
      carried_into_pricing_version: pricingForAssignedEpoch,
      reconciliation_reason:
        "Ingested after its epoch closed and carried into an epoch priced under a different version; reward held so the epoch can still settle.",
    },
  };
}
