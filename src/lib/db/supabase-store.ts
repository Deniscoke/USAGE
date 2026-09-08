import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, UsageEventRow } from "@/lib/supabase/database.types";
import type { EpochState } from "@/lib/domain/epoch";
import type { DailyAggregate, NormalizedUsageRecord } from "@/lib/domain/types";
import { dailyAggregateToRow, rowToUsageRecord, type StoredDailyScore } from "./rows";
import type { IngestStore, InsertedEventRef, ProofDraft } from "./ingest";

/**
 * IngestStore over the Supabase service-role client.
 *
 * Thin by design: all ordering and recomputation logic lives in ingest.ts,
 * which is covered by integration tests against a real Postgres.
 */
export function createSupabaseIngestStore(admin: SupabaseClient<Database>): IngestStore {
  function fail(context: string, error: { message: string } | null): void {
    if (error) throw new Error(`${context}: ${error.message}`);
  }

  return {
    async ensureConnection(userId, provider, accountLabel, secretRef = null) {
      const { data, error } = await admin
        .from("provider_connections")
        .upsert(
          {
            user_id: userId,
            provider,
            account_label: accountLabel,
            status: "active",
            // A reference to where the credential lives, never the credential.
            ...(secretRef ? { secret_ref: secretRef } : {}),
          },
          { onConflict: "user_id,provider,account_label" },
        )
        .select("id")
        .single();
      fail("ensureConnection", error);
      return data?.id ?? null;
    },

    async insertEvents(rows): Promise<InsertedEventRef[]> {
      if (rows.length === 0) return [];
      // The unique natural key makes this idempotent: an event already stored is
      // ignored rather than duplicated or overwritten.
      const { data, error } = await admin
        .from("usage_events")
        .upsert(rows, {
          onConflict: "user_id,provider,source,external_reference",
          ignoreDuplicates: true,
        })
        .select("id, provider, source, external_reference");
      fail("insertEvents", error);
      return (data ?? []).map((row) => ({
        id: row.id,
        provider: row.provider,
        source: row.source,
        externalReference: row.external_reference,
      }));
    },

    async insertProofs(userId: string, proofs: readonly ProofDraft[]) {
      if (proofs.length === 0) return;
      const { error } = await admin.from("proof_records").upsert(
        proofs.map((proof) => ({
          user_id: userId,
          usage_event_id: proof.usageEventId,
          verification_type: proof.verificationType,
          proof_kind: proof.proofKind,
          proof_source: proof.proofSource,
          external_reference: proof.externalReference,
          observed_at: proof.observedAt,
          adapter_version: proof.adapterVersion,
          proof_hash: proof.proofHash,
          trust_environment: proof.trustEnvironment,
          proof_status: proof.proofStatus as "observed" | "confirmed" | "rejected",
          receipt_id: proof.receiptId,
          receipt_version: proof.receiptVersion,
          issuer: proof.issuer,
          issuer_key_id: proof.issuerKeyId,
          signature: proof.signature,
          signed_at: proof.signedAt,
          proof_metadata: proof.metadata,
        })),
        { onConflict: "usage_event_id,proof_kind", ignoreDuplicates: true },
      );
      fail("insertProofs", error);
    },

    async loadEventsForDays(userId, days) {
      if (days.length === 0) return [];
      const sorted = [...days].sort();
      const from = `${sorted[0]}T00:00:00.000Z`;
      const to = new Date(
        new Date(`${sorted[sorted.length - 1]}T00:00:00.000Z`).getTime() + 86_400_000,
      ).toISOString();

      const records: NormalizedUsageRecord[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin
          .from("usage_events")
          .select("*")
          .eq("user_id", userId)
          .gte("occurred_at", from)
          .lt("occurred_at", to)
          .order("occurred_at", { ascending: true })
          .range(offset, offset + pageSize - 1);
        fail("loadEventsForDays", error);
        const rows = (data ?? []) as UsageEventRow[];
        records.push(...rows.map(rowToUsageRecord));
        if (rows.length < pageSize) break;
      }
      return records;
    },

    async loadEventsForEpochs(userId, epochIds) {
      if (epochIds.length === 0) return [];
      const records: NormalizedUsageRecord[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin
          .from("usage_events")
          .select("*")
          .eq("user_id", userId)
          .in("epoch_id", [...epochIds])
          .order("occurred_at", { ascending: true })
          .range(offset, offset + pageSize - 1);
        fail("loadEventsForEpochs", error);
        const rows = (data ?? []) as UsageEventRow[];
        records.push(...rows.map(rowToUsageRecord));
        if (rows.length < pageSize) break;
      }
      return records;
    },

    async loadClosedEpochs() {
      const { data, error } = await admin
        .from("reward_epochs")
        .select("id, state")
        .neq("state", "open");
      fail("loadClosedEpochs", error);
      return new Map((data ?? []).map((row) => [row.id, row.state as EpochState]));
    },

    async replaceDailyAggregates(userId, days) {
      if (days.length === 0) return;
      const { error } = await admin
        .from("usage_daily_aggregates")
        .delete()
        .eq("user_id", userId)
        .in("day", [...days]);
      fail("replaceDailyAggregates", error);
    },

    async upsertDailyAggregates(userId: string, aggregates: readonly DailyAggregate[]) {
      if (aggregates.length === 0) return;
      const { error } = await admin
        .from("usage_daily_aggregates")
        .upsert(
          aggregates.map((aggregate) => dailyAggregateToRow(userId, aggregate)),
          { onConflict: "user_id,day,provider,model,verification_type" },
        );
      fail("upsertDailyAggregates", error);
    },

    async upsertScores(userId: string, scores: readonly StoredDailyScore[]) {
      if (scores.length === 0) return;
      const { error } = await admin.from("score_records").upsert(
        scores.map((score) => ({
          user_id: userId,
          day: score.day,
          algorithm_version: score.algorithmVersion,
          weighted_cost_micros: score.weightedCostMicros,
          excluded_cost_micros: score.excludedCostMicros,
          pending_cost_micros: score.pendingCostMicros,
          points: score.points,
        })),
        { onConflict: "user_id,day,algorithm_version" },
      );
      fail("upsertScores", error);
    },

    async markConnectionSynced(connectionId) {
      const { error } = await admin
        .from("provider_connections")
        .update({ last_synced_at: new Date().toISOString(), last_error: null })
        .eq("id", connectionId);
      fail("markConnectionSynced", error);
    },
  };
}
