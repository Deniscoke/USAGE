import { dedupeUsageRecords } from "@/lib/domain/normalize";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { ConnectionContext, UsageWindow } from "@/lib/providers/adapter";
import { listIntegrations } from "@/lib/providers/registry";

/**
 * Ingestion pipeline: fetch -> normalize -> dedupe.
 *
 * This is the seam a real provider plugs into. Swapping demo adapters for real
 * ones changes nothing here, and re-running the same window is idempotent
 * because dedupe uses the same natural key as the DB unique index.
 */

export interface CollectResult {
  records: NormalizedUsageRecord[];
  duplicates: number;
  failures: { provider: string; error: string }[];
}

export interface ConnectionInput {
  provider: string;
  context: ConnectionContext;
}

export async function collectUsage(
  connections: readonly ConnectionInput[],
  window: UsageWindow,
  alreadySeen: ReadonlySet<string> = new Set(),
): Promise<CollectResult> {
  const integrations = new Map(listIntegrations().map((i) => [i.provider, i]));
  const collected: NormalizedUsageRecord[] = [];
  const failures: CollectResult["failures"] = [];

  for (const connection of connections) {
    const integration = integrations.get(connection.provider);
    if (!integration) {
      failures.push({ provider: connection.provider, error: "no adapter registered" });
      continue;
    }
    try {
      collected.push(...(await integration.collect(connection.context, window)));
    } catch (error) {
      // Provider responses are untrusted: one bad connection must not take down
      // the whole sync.
      failures.push({
        provider: connection.provider,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  collected.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const { accepted, duplicates } = dedupeUsageRecords(collected, alreadySeen);
  return { records: accepted, duplicates, failures };
}
