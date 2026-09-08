import type { IngestStore, InsertedEventRef, ProofDraft } from "@/lib/db/ingest";
import { rowToUsageRecord } from "@/lib/db/rows";
import type { UsageEventRow } from "@/lib/supabase/database.types";
import type { EpochState } from "@/lib/domain/epoch";
import type { DailyAggregate } from "@/lib/domain/types";
import type { StoredDailyScore } from "@/lib/db/rows";
import type { TestDb } from "./pg";

/**
 * IngestStore over raw SQL, used to exercise the ingestion pipeline against a
 * real Postgres. It writes as `service_role`, mirroring how the application's
 * Supabase store runs, and relies on the same natural key for idempotency.
 */
export function createSqlIngestStore(db: TestDb): IngestStore {
  return {
    async ensureConnection(userId, provider, accountLabel, secretRef = null) {
      const rows = await db.asServiceRole<{ id: string }>(
        `insert into provider_connections (user_id, provider, account_label, status, secret_ref)
         values ($1, $2, $3, 'active', $4)
         on conflict (user_id, provider, account_label) do update
           set status = 'active', secret_ref = coalesce(excluded.secret_ref, provider_connections.secret_ref)
         returning id`,
        [userId, provider, accountLabel, secretRef],
      );
      return rows[0]?.id ?? null;
    },

    async insertEvents(rows): Promise<InsertedEventRef[]> {
      if (rows.length === 0) return [];

      const columns = [
        "user_id",
        "connection_id",
        "provider",
        "source",
        "external_reference",
        "model",
        "occurred_at",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "requests",
        "actual_cost_micros",
        "actual_cost_basis",
        "normalized_cost_micros",
        "verification_type",
        "verification_status",
        "economic_status",
        "protocol_compute_micros",
        "pricing_status",
        "protocol_pricing_version",
        "protocol_pricing_basis",
        "epoch_id",
        "carried_forward",
        "gateway_id",
        "economic_source_class",
        "eligible_compute_micros",
        "reward_status",
        "reward_reason",
        "reward_policy_version",
        "reconciliation_status",
        "reward_hold",
        "raw_metadata",
      ] as const;

      const params: unknown[] = [];
      const tuples = rows.map((row) => {
        const placeholders = columns.map((column) => {
          const value = column === "raw_metadata" ? JSON.stringify(row[column]) : row[column];
          params.push(value);
          const index = params.length;
          return column === "raw_metadata"
            ? `$${index}::jsonb`
            : column === "source"
              ? `$${index}::usage_source`
              : column === "verification_type"
                ? `$${index}::verification_type`
                : column === "verification_status"
                  ? `$${index}::verification_status`
                  : `$${index}`;
        });
        return `(${placeholders.join(", ")})`;
      });

      const inserted = await db.asServiceRole<{
        id: string;
        provider: string;
        source: string;
        external_reference: string;
      }>(
        `insert into usage_events (${columns.join(", ")})
         values ${tuples.join(", ")}
         on conflict on constraint usage_events_natural_key do nothing
         returning id, provider, source, external_reference`,
        params,
      );
      return inserted.map((row) => ({
        id: row.id,
        provider: row.provider,
        source: row.source,
        externalReference: row.external_reference,
      }));
    },

    async insertProofs(userId: string, proofs: readonly ProofDraft[]) {
      for (const proof of proofs) {
        await db.asServiceRole(
          `insert into proof_records
             (user_id, usage_event_id, verification_type, proof_kind, proof_source,
              external_reference, observed_at, adapter_version, proof_hash,
              trust_environment, proof_status, receipt_id, receipt_version, issuer,
              issuer_key_id, signature, signed_at, proof_metadata)
           values ($1, $2, $3::verification_type, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12::uuid, $13, $14, $15, $16, $17, $18::jsonb)
           on conflict (usage_event_id, proof_kind) do nothing`,
          [
            userId,
            proof.usageEventId,
            proof.verificationType,
            proof.proofKind,
            proof.proofSource,
            proof.externalReference,
            proof.observedAt,
            proof.adapterVersion,
            proof.proofHash,
            proof.trustEnvironment,
            proof.proofStatus,
            proof.receiptId,
            proof.receiptVersion,
            proof.issuer,
            proof.issuerKeyId,
            proof.signature,
            proof.signedAt,
            JSON.stringify(proof.metadata),
          ],
        );
      }
    },

    async loadEventsForDays(userId, days) {
      if (days.length === 0) return [];
      const sorted = [...days].sort();
      const from = `${sorted[0]}T00:00:00.000Z`;
      const to = new Date(
        new Date(`${sorted[sorted.length - 1]}T00:00:00.000Z`).getTime() + 86_400_000,
      ).toISOString();

      const rows = await db.asServiceRole<UsageEventRow>(
        `select * from usage_events
         where user_id = $1 and occurred_at >= $2 and occurred_at < $3
         order by occurred_at asc`,
        [userId, from, to],
      );
      return rows.map(rowToUsageRecord);
    },

    async loadEventsForEpochs(userId, epochIds) {
      if (epochIds.length === 0) return [];
      const rows = await db.asServiceRole<UsageEventRow>(
        `select * from usage_events
         where user_id = $1 and epoch_id = any($2::text[])
         order by occurred_at asc`,
        [userId, epochIds],
      );
      return rows.map(rowToUsageRecord);
    },

    async loadClosedEpochs() {
      const rows = await db.asServiceRole<{ id: string; state: EpochState }>(
        `select id, state from reward_epochs where state <> 'open'`,
      );
      return new Map(rows.map((row) => [row.id, row.state]));
    },

    async replaceDailyAggregates(userId, days) {
      if (days.length === 0) return;
      await db.asServiceRole(
        `delete from usage_daily_aggregates where user_id = $1 and day = any($2::date[])`,
        [userId, days],
      );
    },

    async upsertDailyAggregates(userId: string, aggregates: readonly DailyAggregate[]) {
      for (const aggregate of aggregates) {
        await db.asServiceRole(
          `insert into usage_daily_aggregates
             (user_id, day, provider, model, verification_type, requests,
              input_tokens, cached_input_tokens, output_tokens, cost_micros)
           values ($1, $2, $3, $4, $5::verification_type, $6, $7, $8, $9, $10)
           on conflict (user_id, day, provider, model, verification_type) do update
             set requests = excluded.requests,
                 input_tokens = excluded.input_tokens,
                 cached_input_tokens = excluded.cached_input_tokens,
                 output_tokens = excluded.output_tokens,
                 cost_micros = excluded.cost_micros,
                 updated_at = now()`,
          [
            userId,
            aggregate.day,
            aggregate.provider,
            aggregate.model,
            aggregate.verificationType,
            aggregate.requests,
            aggregate.inputTokens,
            aggregate.cachedInputTokens,
            aggregate.outputTokens,
            aggregate.costMicros,
          ],
        );
      }
    },

    async upsertScores(userId: string, scores: readonly StoredDailyScore[]) {
      for (const score of scores) {
        await db.asServiceRole(
          `insert into score_records
             (user_id, day, algorithm_version, weighted_cost_micros, excluded_cost_micros,
              pending_cost_micros, points)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (user_id, day, algorithm_version) do update
             set weighted_cost_micros = excluded.weighted_cost_micros,
                 excluded_cost_micros = excluded.excluded_cost_micros,
                 pending_cost_micros = excluded.pending_cost_micros,
                 points = excluded.points`,
          [
            userId,
            score.day,
            score.algorithmVersion,
            score.weightedCostMicros,
            score.excludedCostMicros,
            score.pendingCostMicros,
            score.points,
          ],
        );
      }
    },

    async markConnectionSynced(connectionId) {
      await db.asServiceRole(
        `update provider_connections set last_synced_at = now(), last_error = null where id = $1`,
        [connectionId],
      );
    },
  };
}
