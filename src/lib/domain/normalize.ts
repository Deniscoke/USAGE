import type { DailyAggregate, NormalizedUsageRecord, UsageTotals, VerificationType } from "./types";

/**
 * Idempotency key for a usage record.
 *
 * Mirrors the DB unique index on
 *   (user_id, provider, source, external_reference)
 * so that re-fetching an overlapping provider window is a no-op both in memory
 * and on insert. Adapters are responsible for making `externalReference`
 * deterministic for a given underlying event.
 */
export function usageEventKey(record: NormalizedUsageRecord): string {
  return `${record.provider}\u0000${record.source}\u0000${record.externalReference}`;
}

/** Drop records already seen. First occurrence wins; later ones are ignored. */
export function dedupeUsageRecords(
  records: readonly NormalizedUsageRecord[],
  alreadySeen: ReadonlySet<string> = new Set(),
): { accepted: NormalizedUsageRecord[]; duplicates: number } {
  const seen = new Set(alreadySeen);
  const accepted: NormalizedUsageRecord[] = [];
  let duplicates = 0;

  for (const record of records) {
    const key = usageEventKey(record);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    accepted.push(record);
  }
  return { accepted, duplicates };
}

export function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};

export function addToTotals(totals: UsageTotals, record: NormalizedUsageRecord): UsageTotals {
  return {
    requests: totals.requests + record.requests,
    inputTokens: totals.inputTokens + record.inputTokens,
    cachedInputTokens: totals.cachedInputTokens + record.cachedInputTokens,
    outputTokens: totals.outputTokens + record.outputTokens,
    costMicros: totals.costMicros + record.normalizedCostMicros,
  };
}

export function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.cachedInputTokens + totals.outputTokens;
}

/** Collapse events into (day, provider, model, verificationType) buckets. */
export function aggregateDaily(records: readonly NormalizedUsageRecord[]): DailyAggregate[] {
  const buckets = new Map<string, DailyAggregate>();

  for (const record of records) {
    const day = utcDay(record.occurredAt);
    const key = `${day}|${record.provider}|${record.model}|${record.verificationType}`;
    const existing = buckets.get(key);
    const base: UsageTotals = existing ?? EMPTY_TOTALS;
    buckets.set(key, {
      day,
      provider: record.provider,
      model: record.model,
      verificationType: record.verificationType,
      ...addToTotals(base, record),
    });
  }

  return [...buckets.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export function totalsBy<K extends string>(
  records: readonly NormalizedUsageRecord[],
  keyOf: (record: NormalizedUsageRecord) => K,
): Map<K, UsageTotals> {
  const out = new Map<K, UsageTotals>();
  for (const record of records) {
    const key = keyOf(record);
    out.set(key, addToTotals(out.get(key) ?? EMPTY_TOTALS, record));
  }
  return out;
}

export function totalsByVerification(
  records: readonly NormalizedUsageRecord[],
): Record<VerificationType, UsageTotals> {
  const map = totalsBy(records, (r) => r.verificationType);
  return {
    verified: map.get("verified") ?? EMPTY_TOTALS,
    routed: map.get("routed") ?? EMPTY_TOTALS,
    reported: map.get("reported") ?? EMPTY_TOTALS,
  };
}
