import type { NormalizedUsageRecord } from "@/lib/domain/types";
import { economicKeyOf } from "@/lib/protocol/economic-unit";
import type { KeyedEventRef } from "./ingest";

/**
 * Cross-source dedupe on the economic key.
 *
 * The natural key `(user, provider, source, external_reference)` already makes
 * an exact replay a no-op. What it cannot see is the same request arriving
 * from a DIFFERENT source -- USAGE's routed proof, then a provider import of
 * the same day, both naming Anthropic's `req_...`. Those are two rows with two
 * natural keys and one economic key, and the economic key is what must earn
 * at most once.
 *
 * The rule: the first event to carry a key is the unit. Every later record
 * with the same key and a different natural key is stored -- it is genuine
 * evidence, and an auditor wants it -- with its reward HELD, its eligible
 * compute zeroed, and a pointer to the unit it is evidence for. Nothing about
 * the first event changes. Holding is idempotent, so re-running ingestion
 * converges, and it is one-directional, so nothing here can ever raise a
 * reward.
 *
 * Structural enforcement (a unique index on the key for primary units) is in
 * migration 0018, prepared and not applied. Until it lands, this function is
 * the enforcement, and the PGlite tests hold it to the invariant.
 */
export interface DedupeStore {
  loadEventsByEconomicKey(keys: readonly string[]): Promise<KeyedEventRef[]>;
}

/**
 * The natural key is per user (user_id is part of the constraint). Two users
 * presenting the same generation are two rows under it -- which is exactly
 * why the economic key, which carries no user id, has to be checked here.
 */
function naturalKey(record: { userId: string; provider: string; source: string; externalReference: string }): string {
  return `${record.userId}|${record.provider}|${record.source}|${record.externalReference}`;
}

export function markDuplicate<T extends NormalizedUsageRecord>(record: T, primaryEventId: string | null): T {
  return {
    ...record,
    rewardHold: true,
    reconciliationStatus: "held",
    eligibleComputeMicros: 0,
    rewardStatus: "held",
    rewardReason: "duplicate_evidence",
    rawMetadata: {
      ...record.rawMetadata,
      dedupe_status: "duplicate",
      economic_duplicate_of: primaryEventId,
      economic_verification_status: "held",
      economic_verification_reason: "duplicate_unit",
      reconciliation_reason: "Another record already carries this economic identity; reward held.",
    },
  };
}

export async function applyEconomicDedupe<T extends NormalizedUsageRecord>(
  store: DedupeStore,
  userId: string,
  records: readonly T[],
): Promise<T[]> {
  const keys = [...new Set(records.map((record) => economicKeyOf(record.rawMetadata)).filter((k): k is string => k !== null))];
  if (keys.length === 0) return [...records];

  const existing = await store.loadEventsByEconomicKey(keys);
  const primaryByKey = new Map<string, KeyedEventRef>();
  for (const event of existing) {
    // The earliest stored event is the unit. Stores return them in insertion
    // order; the first one seen for a key wins and later ones do not replace it.
    if (!primaryByKey.has(event.economicEventKey)) primaryByKey.set(event.economicEventKey, event);
  }

  const seenInBatch = new Map<string, string>();
  return records.map((record) => {
    const key = economicKeyOf(record.rawMetadata);
    if (!key) return record;
    const own = naturalKey({ userId, ...record });

    const prior = primaryByKey.get(key);
    if (prior) {
      // The same natural key is an exact replay: the insert will be ignored
      // by the unique constraint, so there is nothing to mark. A different
      // natural key is another source's -- or another USER's -- view of the
      // unit, and the unit already has an owner.
      return naturalKey(prior) === own ? record : markDuplicate(record, prior.id);
    }
    const first = seenInBatch.get(key);
    if (first !== undefined && first !== own) return markDuplicate(record, null);
    if (first === undefined) seenInBatch.set(key, own);
    return record;
  });
}
