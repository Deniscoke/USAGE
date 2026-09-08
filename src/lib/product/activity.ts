import { providerForModel } from "@/lib/providers/catalog";
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
  proofStatus: ProofStatus | null;
  economicStatus: EconomicStatus | null;
  protocolComputeMicros: number | null;
  /** True when this usage carries economic weight right now. */
  contributesToMining: boolean;
}

export interface ActivityInput {
  events: readonly (NormalizedUsageRecord & { id?: string })[];
  /** proof_status by usage event id. Absent means no proof record was found. */
  proofStatusById?: ReadonlyMap<string, ProofStatus>;
}

const TOOL_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  probe: "USAGE probe",
  fixture: "Fixture",
};

export function buildActivityFeed({ events, proofStatusById }: ActivityInput): ActivityItem[] {
  return events.map((event) => {
    const id = event.id ?? event.externalReference;
    const clientType = event.rawMetadata.client_type;
    const provider = providerForModel(event.model);

    return {
      id,
      occurredAt: event.occurredAt,
      provider: provider?.name ?? event.provider,
      model: event.model,
      modelLabel: event.model.includes("/") ? event.model.split("/").slice(1).join("/") : event.model,
      tool:
        typeof clientType === "string" ? (TOOL_LABELS[clientType] ?? clientType) : null,
      tokens: event.inputTokens + event.cachedInputTokens + event.outputTokens,
      verificationType: event.verificationType,
      proofStatus: proofStatusById?.get(id) ?? null,
      economicStatus: event.economicStatus ?? null,
      protocolComputeMicros: event.protocolPricingVersion ? (event.protocolComputeMicros ?? 0) : null,
      // Settled usage counted; it is not counting again. Both are "it worked",
      // which is what the feed is telling you.
      contributesToMining:
        event.economicStatus === "eligible" || event.economicStatus === "settled",
    };
  });
}
