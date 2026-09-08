import { estimateCostMicros } from "@/lib/domain/pricing";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { ConnectionContext, RawUsagePayload, UsageProviderAdapter, UsageWindow } from "../adapter";
import { generateDemoBuckets, type DemoProfile } from "./generator";

/**
 * Demo adapter standing in for local developer-tool telemetry (a CLI or IDE
 * extension). It ships token counts but no money, and USAGE cannot
 * independently confirm any of it, so it is "reported": visible in analytics,
 * zero economic weight, and its cost is an ESTIMATE from our own price table.
 */

interface CliSessionReport {
  started_at: string;
  model_id: string;
  sessions: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  client_version: string;
}

const PROFILE: DemoProfile = {
  provider: "demo-cli",
  models: [
    { model: "demo-medium", share: 0.5 },
    { model: "demo-large", share: 0.3 },
    { model: "demo-small", share: 0.2 },
  ],
  bucketsPerDay: [3, 7],
  requestsPerBucket: [12, 56],
  inputTokensPerRequest: [2_000, 14_000],
  cacheHitRatio: 0.6,
  outputTokensPerRequest: [300, 1_600],
  costMultiplier: 1,
};

export const demoLocalCliAdapter: UsageProviderAdapter<CliSessionReport> = {
  provider: "demo-cli",
  label: "Demo CLI (local telemetry)",
  capability: {
    requiredAccountType: "Any local install",
    authMethod: "Device token",
    costDataAvailable: false,
    perUserDataAvailable: true,
    dataFreshness: "on client flush",
    verification: "reported",
    limitations: [
      "Self-reported by software running on a user machine.",
      "Cost is estimated from the USAGE price table, not billed by a provider.",
    ],
  },

  async validateConnection(context: ConnectionContext) {
    return { ok: true as const, accountLabel: `device/${context.connectionId}` };
  },

  async fetchUsage(_context: ConnectionContext, window: UsageWindow) {
    const rows = generateDemoBuckets(PROFILE, window).map<CliSessionReport>((bucket) => ({
      started_at: bucket.occurredAt,
      model_id: bucket.model,
      sessions: bucket.requests,
      prompt_tokens: bucket.inputTokens,
      cached_tokens: bucket.cachedInputTokens,
      completion_tokens: bucket.outputTokens,
      client_version: "0.1.0",
    }));
    return { provider: this.provider, window, rows };
  },

  normalize(payload: RawUsagePayload<CliSessionReport>): NormalizedUsageRecord[] {
    return payload.rows.map((row) => {
      const normalizedCostMicros = estimateCostMicros({
        model: row.model_id,
        inputTokens: row.prompt_tokens,
        cachedInputTokens: row.cached_tokens,
        outputTokens: row.completion_tokens,
      });
      return {
        provider: payload.provider,
        source: "local_client",
        externalReference: `${row.started_at}:${row.model_id}`,
        model: row.model_id,
        occurredAt: new Date(row.started_at).toISOString(),
        inputTokens: row.prompt_tokens,
        cachedInputTokens: row.cached_tokens,
        outputTokens: row.completion_tokens,
        requests: row.sessions,
        actualCostMicros: null,
        normalizedCostMicros,
        verificationType: "reported",
        verificationStatus: "unverifiable",
        rawMetadata: { client_version: row.client_version, cost_basis: "estimated" },
      };
    });
  },

  getVerificationType() {
    return "reported" as const;
  },
};
