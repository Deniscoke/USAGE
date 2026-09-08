import { utcDay } from "@/lib/domain/normalize";
import { issueImportProof } from "@/lib/imports/issue";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { ProofIssuance } from "@/lib/providers/vercel-gateway/adapter";
import { ingestRecords, type IngestStore, type IngestSummary } from "./ingest";
import { applyReconciliation, routedFootprint } from "./reconciliation";

/**
 * Ingesting verified provider imports.
 *
 * Runs the same pipeline as routed observations -- same dedupe on the natural
 * key, same day recomputation, same scoring -- with two additions that only
 * imports need:
 *
 *   1. proofs are issued here rather than by a gateway adapter, because no
 *      gateway executed anything;
 *   2. records are reconciled against routed usage USAGE already holds, so the
 *      same compute is never rewarded twice.
 *
 * A client cannot reach this path. It requires an admin credential the server
 * holds and a signing key that exists only on trusted infrastructure, and
 * `verification_type` comes from the adapter, never from input.
 */

export interface ImportIngestOptions {
  /**
   * Production issuance credentials. Present only on trusted hosted
   * infrastructure; supplying them is what turns an import into a CONFIRMED,
   * signed proof.
   */
  issuance?: ProofIssuance | null;
  connectionId?: string | null;
  observedAt?: string;
}

export interface ImportIngestSummary extends IngestSummary {
  /** Records whose reward is withheld pending reconciliation. */
  held: number;
}

export async function ingestImportedUsage(
  store: IngestStore,
  userId: string,
  records: readonly NormalizedUsageRecord[],
  options: ImportIngestOptions = {},
): Promise<ImportIngestSummary> {
  if (records.length === 0) {
    return { fetched: 0, inserted: 0, duplicates: 0, daysRecomputed: 0, failures: [], held: 0 };
  }

  // Reconciliation needs to know what USAGE already counted for these days.
  // Loading only the affected days keeps this cheap and, more importantly,
  // deterministic: the same window always sees the same neighbours.
  const days = [...new Set(records.map((record) => utcDay(record.occurredAt)))].sort();
  const existing = await store.loadEventsForDays(userId, days);
  const { records: reconciled, held } = applyReconciliation(records, routedFootprint(existing));

  const issued = reconciled.map((record) =>
    issueImportProof(record, {
      userId,
      issuance: options.issuance ?? null,
      connectionId: options.connectionId ?? null,
      observedAt: options.observedAt,
    }),
  );

  const proofOverrides = new Map(
    issued.map((entry) => [entry.record.externalReference, entry.proof]),
  );

  const connectionIds = new Map(
    options.connectionId
      ? records.map((record) => [record.provider, options.connectionId ?? null])
      : [],
  );

  const result = await ingestRecords(
    store,
    userId,
    issued.map((entry) => entry.record),
    connectionIds,
    proofOverrides,
  );

  return { fetched: records.length, ...result, failures: [], held };
}
