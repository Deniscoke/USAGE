import { providerForModel } from "@/lib/providers/catalog";
import { REWARD_STATUS_COPY } from "@/lib/protocol/reward-policy";
import type { EconomicStatus, NormalizedUsageRecord, ProofStatus, VerificationType } from "@/lib/domain/types";

/**
 * The activity feed.
 *
 * What a person wants to know about a piece of their AI usage: which tool,
 * which model, how much, and whether it counted. Infrastructure detail
 * (receipts, issuers, generation ids) belongs on the proof page behind
 * "advanced", not in the feed.
 */

export interface ActivityItem {
  /** usage_events.id, so the row links straight to its proof page. */
  id: string;
  occurredAt: string;
  /** Display name of the provider, from the registry. */
  provider: string;
  model: string;
  /** Model without its provider prefix, which is what people actually read. */
  modelLabel: string;
  tool: string | null;
  tokens: number;
  verificationType: VerificationType;
  /** Where the evidence came from, e.g. "Routed via Vercel AI Gateway". */
  origin: string;
  proofStatus: ProofStatus | null;
  economicStatus: EconomicStatus | null;
  protocolComputeMicros: number | null;
  /** True when this usage carries economic weight right now. */
  contributesToMining: boolean;
  /** Why it does or does not earn, in one phrase. */
  rewardLabel: string;
}

export interface ActivityInput {
  events: readonly (NormalizedUsageRecord & { id?: string })[];
  /** proof_status by usage event id. Absent means no proof record was found. */
  proofStatusById?: ReadonlyMap<string, ProofStatus>;
}

const TOOL_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "openrouter-miner": "USAGE Miner",
  import: "Organization import",
  probe: "USAGE probe",
  fixture: "Fixture",
};

const GATEWAY_NAMES: Record<string, string> = {
  "vercel-ai-gateway": "Vercel AI Gateway",
  openrouter: "OpenRouter",
};

/**
 * Where this evidence came from, in one phrase.
 *
 * A routed proof names the gateway that executed it; a verified import names
 * the provider whose API stated it. The two are different kinds of evidence and
 * the feed says which is which rather than blurring them into "verified".
 */
function describeOrigin(
  verificationType: VerificationType,
  gatewayId: string | null | undefined,
  providerName: string,
): string {
  if (verificationType === "routed") {
    const gateway = gatewayId ? (GATEWAY_NAMES[gatewayId] ?? gatewayId) : "USAGE";
    return `Routed via ${gateway}`;
  }
  if (verificationType === "verified") return `Verified via ${providerName}`;
  return "Reported";
}

export function buildActivityFeed({ events, proofStatusById }: ActivityInput): ActivityItem[] {
  return events.map((event) => {
    const id = event.id ?? event.externalReference;
    const clientType = event.rawMetadata.client_type;
    const provider = providerForModel(event.model);

    const providerName = provider?.name ?? event.provider;

    return {
      id,
      occurredAt: event.occurredAt,
      provider: providerName,
      model: event.model,
      modelLabel: event.model.includes("/") ? event.model.split("/").slice(1).join("/") : event.model,
      tool:
        typeof clientType === "string" ? (TOOL_LABELS[clientType] ?? clientType) : null,
      tokens: event.inputTokens + event.cachedInputTokens + event.outputTokens,
      verificationType: event.verificationType,
      origin: describeOrigin(event.verificationType, event.gatewayId, providerName),
      proofStatus: proofStatusById?.get(id) ?? null,
      economicStatus: event.economicStatus ?? null,
      protocolComputeMicros: event.protocolPricingVersion ? (event.protocolComputeMicros ?? 0) : null,
      // Settled usage counted; it is not counting again. Both are "it worked",
      // which is what the feed is telling you. The reward policy has the final
      // say: a confirmed proof that did not earn says so here.
      contributesToMining:
        event.rewardStatus === "eligible" ||
        (event.rewardStatus === undefined &&
          (event.economicStatus === "eligible" || event.economicStatus === "settled")),
      rewardLabel: event.rewardStatus ? REWARD_STATUS_COPY[event.rewardStatus] : "Counted",
    };
  });
}
