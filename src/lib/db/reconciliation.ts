import { utcDay } from "@/lib/domain/normalize";
import { providerForModel } from "@/lib/providers/catalog";
import type { NormalizedUsageRecord, ReconciliationStatus } from "@/lib/domain/types";

/**
 * Cross-source reconciliation.
 *
 * The same compute can reach USAGE twice: once as a routed proof when we
 * executed it, and later inside a provider's own billing export covering the
 * same period. Both are genuine evidence of the same work, and rewarding both
 * would pay twice for it.
 *
 * PERFECT MATCHING IS IMPOSSIBLE and pretending otherwise would be worse than
 * admitting it. Organization usage arrives aggregated into time buckets with no
 * request ids, so there is no key to join on. What is possible is to notice the
 * ambiguity and refuse to pay into it.
 *
 * The V1 rule, in order:
 *
 *   1. identical external identity        -> the natural key already deduped it
 *   2. aggregate import over a period     -> HELD, reward withheld
 *      where routed usage already exists
 *      for the same provider and day
 *   3. anything else                      -> clear
 *
 * A held record keeps its proof. Withholding a reward is not the same as
 * doubting the evidence, and discarding valid compute would be a worse error
 * than paying it late.
 */

export interface ReconciliationDecision {
  status: ReconciliationStatus;
  rewardHold: boolean;
  reason: string | null;
}

export const CLEAR: ReconciliationDecision = {
  status: "clear",
  rewardHold: false,
  reason: null,
};

/** A routed record USAGE already holds, reduced to what matching needs. */
export interface KnownRoutedUsage {
  /** UTC day the compute occurred on. */
  day: string;
  /** Registry provider slug, e.g. "anthropic". */
  providerSlug: string;
}

export function routedFootprint(
  records: readonly NormalizedUsageRecord[],
): KnownRoutedUsage[] {
  return records
    .filter((record) => record.verificationType === "routed")
    .map((record) => ({
      day: utcDay(record.occurredAt),
      providerSlug: providerForModel(record.model)?.slug ?? record.provider,
    }));
}

/**
 * Decide how an incoming record relates to compute USAGE already counted.
 *
 * Only aggregate imports can collide: a routed proof is a single request USAGE
 * watched, and two of those cannot be the same request unless they share an
 * identity, which the natural key already prevents.
 */
export function reconcile(
  record: NormalizedUsageRecord,
  known: readonly KnownRoutedUsage[],
): ReconciliationDecision {
  const granularity = record.rawMetadata.granularity;
  if (granularity !== "provider_aggregate") return CLEAR;

  const day = utcDay(record.occurredAt);
  const providerSlug = providerForModel(record.model)?.slug ?? record.provider;
  const overlaps = known.some(
    (entry) => entry.day === day && entry.providerSlug === providerSlug,
  );

  if (!overlaps) return CLEAR;

  // The bucket certainly includes the routed requests, and there is no way to
  // subtract them: the provider did not itemise, so any split would be a guess
  // dressed as arithmetic.
  return {
    status: "held",
    rewardHold: true,
    reason: `Aggregate import overlaps routed ${providerSlug} usage on ${day}; reward held pending reconciliation.`,
  };
}

/** Apply reconciliation to a batch, returning records ready to store. */
export function applyReconciliation(
  records: readonly NormalizedUsageRecord[],
  known: readonly KnownRoutedUsage[],
): { records: NormalizedUsageRecord[]; held: number } {
  let held = 0;
  const out = records.map((record) => {
    const decision = reconcile(record, known);
    if (decision.rewardHold) held += 1;
    return {
      ...record,
      reconciliationStatus: decision.status,
      rewardHold: decision.rewardHold,
      rawMetadata: decision.reason
        ? { ...record.rawMetadata, reconciliation_reason: decision.reason }
        : record.rawMetadata,
    };
  });
  return { records: out, held };
}
