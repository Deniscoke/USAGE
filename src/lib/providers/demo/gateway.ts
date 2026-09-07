import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { ConnectionContext, RawUsagePayload, UsageProviderAdapter, UsageWindow } from "../adapter";
import { generateDemoBuckets, type DemoProfile } from "./generator";

/**
 * Demo adapter standing in for a future USAGE-operated AI gateway: traffic that
 * physically transits infrastructure we control, so it is observed rather than
 * self-reported. That is what "routed" means.
 */

interface GatewayRecord {
  ts: number;
  request_id: string;
  route: { model: string };
  tokens: { in: number; cached: number; out: number };
  count: number;
  cost_usd_micros: number;
}

const PROFILE: DemoProfile = {
  provider: "demo-gateway",
  models: [
    { model: "demo-medium", share: 0.6 },
    { model: "demo-small", share: 0.3 },
    { model: "demo-large", share: 0.1 },
  ],
  bucketsPerDay: [4, 9],
  requestsPerBucket: [34, 155],
  inputTokensPerRequest: [1_200, 9_000],
  cacheHitRatio: 0.55,
  outputTokensPerRequest: [200, 1_100],
  costMultiplier: 1.05,
};

export const demoGatewayAdapter: UsageProviderAdapter<GatewayRecord> = {
  provider: "demo-gateway",
  label: "Demo Gateway (routed traffic)",
  capability: {
    requiredAccountType: "Any, traffic proxied through USAGE",
    authMethod: "USAGE gateway key",
    costDataAvailable: true,
    perUserDataAvailable: true,
    dataFreshness: "real time",
    verification: "routed",
    limitations: ["Only covers traffic actually sent through the gateway."],
  },

  async validateConnection(context: ConnectionContext) {
    return { ok: true as const, accountLabel: `gateway/${context.connectionId}` };
  },

  async fetchUsage(_context: ConnectionContext, window: UsageWindow) {
    const rows = generateDemoBuckets(PROFILE, window).map<GatewayRecord>((bucket) => ({
      ts: new Date(bucket.occurredAt).getTime(),
      request_id: `gw_${new Date(bucket.occurredAt).getTime()}_${bucket.model}`,
      route: { model: bucket.model },
      tokens: { in: bucket.inputTokens, cached: bucket.cachedInputTokens, out: bucket.outputTokens },
      count: bucket.requests,
      cost_usd_micros: bucket.costMicros,
    }));
    return { provider: this.provider, window, rows };
  },

  normalize(payload: RawUsagePayload<GatewayRecord>): NormalizedUsageRecord[] {
    return payload.rows.map((row) => ({
      provider: payload.provider,
      source: "gateway",
      externalReference: row.request_id,
      model: row.route.model,
      occurredAt: new Date(row.ts).toISOString(),
      inputTokens: row.tokens.in,
      cachedInputTokens: row.tokens.cached,
      outputTokens: row.tokens.out,
      requests: row.count,
      reportedCostMicros: row.cost_usd_micros,
      normalizedCostMicros: row.cost_usd_micros,
      verificationType: "routed",
      verificationStatus: "confirmed",
      rawMetadata: { observed: true },
    }));
  },

  getVerificationType() {
    return "routed" as const;
  },
};
