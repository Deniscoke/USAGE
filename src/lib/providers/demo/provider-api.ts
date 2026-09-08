import { usdStringToMicros } from "@/lib/domain/money";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { ConnectionContext, RawUsagePayload, UsageProviderAdapter, UsageWindow } from "../adapter";
import { generateDemoBuckets, type DemoProfile } from "./generator";

/**
 * Demo adapter standing in for an authoritative provider Usage + Cost API.
 * The wire shape is intentionally provider-ish (snake_case, money as a decimal
 * string) to prove that nothing outside `normalize()` depends on it.
 */

interface DemoProviderRow {
  bucket_start: string;
  model: string;
  n_requests: number;
  input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  amount: { value: string; currency: string };
}

const PROFILE: DemoProfile = {
  provider: "demo-provider",
  models: [
    { model: "demo-large", share: 0.55 },
    { model: "demo-medium", share: 0.35 },
    { model: "demo-small", share: 0.1 },
  ],
  bucketsPerDay: [5, 10],
  requestsPerBucket: [26, 92],
  inputTokensPerRequest: [4_000, 26_000],
  cacheHitRatio: 0.72,
  outputTokensPerRequest: [350, 2_400],
  costMultiplier: 1,
};

export const demoProviderAdapter: UsageProviderAdapter<DemoProviderRow> = {
  provider: "demo-provider",
  label: "Demo Provider (Usage API)",
  capability: {
    requiredAccountType: "Organization / admin key",
    authMethod: "Admin API key, server-side only",
    costDataAvailable: true,
    perUserDataAvailable: true,
    dataFreshness: "~5 minutes",
    verification: "verified",
    limitations: ["Synthetic data. Replace with a real provider adapter before launch."],
  },

  async validateConnection(context: ConnectionContext) {
    return { ok: true as const, accountLabel: `demo-org (${context.connectionId})` };
  },

  async fetchUsage(_context: ConnectionContext, window: UsageWindow) {
    const rows = generateDemoBuckets(PROFILE, window).map<DemoProviderRow>((bucket) => ({
      bucket_start: bucket.occurredAt,
      model: bucket.model,
      n_requests: bucket.requests,
      input_tokens: bucket.inputTokens,
      cache_read_input_tokens: bucket.cachedInputTokens,
      output_tokens: bucket.outputTokens,
      amount: { value: (bucket.costMicros / 1_000_000).toFixed(6), currency: "USD" },
    }));
    return { provider: this.provider, window, rows };
  },

  normalize(payload: RawUsagePayload<DemoProviderRow>): NormalizedUsageRecord[] {
    return payload.rows.map((row) => {
      const actualCostMicros =
        row.amount?.currency === "USD" ? usdStringToMicros(row.amount.value) : 0;
      return {
        provider: payload.provider,
        source: "provider_usage_api",
        externalReference: `${row.bucket_start}:${row.model}`,
        model: row.model,
        occurredAt: new Date(row.bucket_start).toISOString(),
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cache_read_input_tokens,
        outputTokens: row.output_tokens,
        requests: row.n_requests,
        actualCostMicros,
        normalizedCostMicros: actualCostMicros,
        verificationType: "verified",
        verificationStatus: "confirmed",
        rawMetadata: { bucket: "hour", currency: row.amount?.currency ?? "USD" },
      };
    });
  },

  getVerificationType() {
    return "verified" as const;
  },
};
