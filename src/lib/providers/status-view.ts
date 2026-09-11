import { fundingEvidenceForConnection } from "@/lib/protocol/funding";
import { classifyEconomicSource, type FundingClass } from "@/lib/protocol/economic-unit";
import { decideReward, type EconomicSourceClass } from "@/lib/protocol/reward-policy";
import type { MiningEligibility, ProtocolCapabilities } from "@/lib/protocols/protocol";
import type { ConnectionStatusDetailRow } from "@/lib/supabase/database.types";
import { OPENROUTER_PRIVACY_COPY } from "./openrouter-privacy";

/**
 * The one server-derived status of a provider connection, in six separate
 * facts that are never merged into one word.
 *
 *   CONNECTION      did the credential probe succeed?
 *   ROUTING         can USAGE carry requests through it?
 *   USAGE EVIDENCE  would a routed request yield a provable usage record?
 *   PRICING         is there an approved protocol price for its models?
 *   FUNDING         what does the provider say paid for it? (policy input)
 *   MINING          what the CURRENT reward policy would decide for a
 *                   confirmed, priced, positive-cost request on this route
 *
 * `mining_eligibility = eligible_route` is ROUTE CAPABILITY: routable, usage
 * and identity documented, at least one priced model. It is not economic
 * eligibility, and nothing here treats it as such. The name is kept in the
 * schema and API to avoid churn; this view is what every surface reads.
 */

export type MiningOutcome = "eligible" | "held" | "ineligible" | "unavailable";

export interface ProviderStatusView {
  connection: { state: ConnectionStatusDetailRow; label: string };
  credential: "valid" | "rejected" | "unverified";
  models: { discovered: number; priced: number };
  routing: "available" | "unsupported";
  usageEvidence: "routed_proof" | "analytics_only" | "none";
  pricing: "available" | "pending" | "none";
  funding: { class: FundingClass | "usage_credit_never" | "unknown"; label: string; basis: string | null };
  economicSource: EconomicSourceClass;
  mining: { outcome: MiningOutcome; label: string; reason: string };
  /** Server-enforced privacy baseline, when the provider has one. */
  privacy: { lines: readonly string[]; detail: string } | null;
}

export interface ProviderStatusInput {
  provider: string;
  authMethod: "api_key" | "oauth";
  connectionStatus: ConnectionStatusDetailRow;
  miningEligibility: MiningEligibility;
  capabilities: ProtocolCapabilities;
  modelCount: number;
  pricedModelCount: number;
  accountContext: Record<string, unknown> | null;
  validatedAt: string | null;
  /** The endpoint is a provider USAGE recognises, not a URL the user typed. */
  endpointTrusted: boolean;
  revoked: boolean;
}

const CONNECTION_LABEL: Record<ConnectionStatusDetailRow, string> = {
  validating: "Saved — validation incomplete",
  active: "Connected",
  limited: "Connected",
  invalid_credentials: "Invalid credentials",
  unsupported_usage: "Connected — no usage data",
  pending_pricing: "Connected",
  error: "Error",
  revoked: "Disconnected",
};

const FUNDING_LABEL: Record<string, string> = {
  paid_account: "Paid-account metered (provider states the account has purchased credit)",
  free_tier_account: "Free tier (provider states the account has never purchased credit)",
  byok_upstream: "BYOK upstream — funding of the upstream account unknown",
  subscription: "Subscription",
  usage_credit: "USAGE's own credit",
  unknown: "Unknown — the provider has not stated how this account is funded",
};

/**
 * The one sentence a person reads first.
 *
 * The seven status rows are all true and all necessary, but thirteen uppercase
 * codes before a single sentence is a wall, and the question everybody
 * actually arrives with is smaller than that: can I use this, and does it
 * earn? This answers exactly that, and the rows stay underneath for whoever
 * wants to see the working.
 *
 * It never merges the facts it summarises: "connected" and "earning" remain
 * separate words, because a connection that routes perfectly and earns nothing
 * is a normal, correct state and must not read as a fault.
 */
export interface ConnectionHeadline {
  tone: "earning" | "working" | "blocked" | "disconnected";
  title: string;
  detail: string;
}

export function connectionHeadline(view: ProviderStatusView): ConnectionHeadline {
  if (view.connection.state === "revoked") {
    return {
      tone: "disconnected",
      title: "Disconnected",
      detail:
        "You disconnected this. Reconnect it with a new key to use it again — its history stays attached.",
    };
  }
  if (view.credential === "rejected") {
    return {
      tone: "blocked",
      title: "The key was refused",
      detail: "The provider rejected this credential. Reconnect with a new key.",
    };
  }
  if (view.connection.state === "validating") {
    return {
      tone: "blocked",
      title: "Never finished connecting",
      detail: "This was saved but never validated, so there is nothing to route through yet.",
    };
  }
  if (view.routing === "unsupported") {
    return {
      tone: "blocked",
      title: "Cannot carry requests",
      detail: "USAGE cannot route requests through this connection, so nothing can be measured.",
    };
  }
  if (view.mining.outcome === "eligible") {
    return {
      tone: "earning",
      title: "Working, and it earns",
      detail: "Requests routed through this connection are measured, priced and reward eligible.",
    };
  }
  if (view.mining.outcome === "ineligible") {
    return { tone: "blocked", title: "Working, but it never earns", detail: view.mining.reason };
  }
  return {
    // The state the owner kept asking about: everything green except the one
    // thing that decides a reward.
    tone: "working",
    title: "Working. It does not earn yet",
    detail: view.mining.reason,
  };
}

export function deriveProviderStatusView(input: ProviderStatusInput): ProviderStatusView {
  const connectionState: ConnectionStatusDetailRow = input.revoked ? "revoked" : input.connectionStatus;
  const credential: ProviderStatusView["credential"] =
    connectionState === "invalid_credentials" ? "rejected" : input.capabilities.authenticated ? "valid" : "unverified";
  const routing: ProviderStatusView["routing"] =
    input.miningEligibility === "unsupported" || connectionState === "revoked" || connectionState === "invalid_credentials"
      ? "unsupported"
      : "available";
  const usageEvidence: ProviderStatusView["usageEvidence"] =
    routing !== "available" ? "none" : input.capabilities.usage && input.capabilities.requestIdentity ? "routed_proof" : "analytics_only";
  const pricing: ProviderStatusView["pricing"] =
    routing !== "available" ? "none" : input.pricedModelCount > 0 ? "available" : "pending";

  // Funding, exactly as the economic policy reads it: from what the provider
  // stated about the account when it was connected. Nothing the user typed.
  const evidence = fundingEvidenceForConnection({
    provider: input.provider,
    auth_method: input.authMethod,
    account_context: input.accountContext,
    validated_at: input.validatedAt,
  });
  const fundingClass = evidence?.class ?? "unknown";

  // What economic-verification-v1 would classify a real, positive-cost,
  // confirmed request on this route as. The cost is hypothetical here; the
  // classification is not, because it does not depend on the amount.
  const economicSource = classifyEconomicSource({
    gatewayId: "connection:preview",
    actualCostMicros: 1,
    actualCostAuthority: "gateway_reported",
    usageFunded: false,
    endpointControlledByUser: !input.endpointTrusted,
    funding: evidence,
  });

  let mining: ProviderStatusView["mining"];
  if (routing !== "available" || usageEvidence !== "routed_proof") {
    mining = {
      outcome: "unavailable",
      label: "Not measurable",
      reason:
        routing !== "available"
          ? "USAGE cannot route requests through this connection."
          : "This provider does not report enough (usage and a request id) for a routed proof, so its usage is shown and never earns.",
    };
  } else if (pricing !== "available") {
    mining = {
      outcome: "held",
      label: "Held — pending pricing",
      reason: "USAGE can prove compute through this connection but has no approved price for its models yet.",
    };
  } else {
    const reward = decideReward({ proofStatus: "confirmed", verificationType: "routed", economicSource, protocolComputeMicros: 1 });
    mining = {
      outcome: reward.status,
      label: reward.status === "eligible" ? "Eligible" : reward.status === "held" ? "Held" : "Ineligible",
      reason: miningReason(economicSource, fundingClass, input.endpointTrusted),
    };
  }

  return {
    connection: { state: connectionState, label: CONNECTION_LABEL[connectionState] },
    credential,
    models: { discovered: input.modelCount, priced: input.pricedModelCount },
    routing,
    usageEvidence,
    pricing,
    funding: { class: fundingClass, label: FUNDING_LABEL[fundingClass] ?? FUNDING_LABEL.unknown, basis: evidence?.basis ?? null },
    economicSource,
    mining,
    privacy: input.provider === "openrouter" ? { lines: OPENROUTER_PRIVACY_COPY.lines, detail: OPENROUTER_PRIVACY_COPY.detail } : null,
  };
}

function miningReason(source: EconomicSourceClass, funding: string, trusted: boolean): string {
  switch (source) {
    case "metered_paid":
      return "The provider states this account has purchased credit and reports a positive charge per request, so verified requests through this route earn under the beta policy.";
    case "free":
      return "Free inference never earns.";
    case "promotional":
      return funding === "free_tier_account"
        ? "The provider states this account has never purchased credit, so its requests run on free or promotional credit. Not reward eligible."
        : "Promotional credit is not reward eligible.";
    case "byok":
      return trusted
        ? "Requests run on your own upstream key; USAGE cannot establish that the upstream account is paid."
        : "This is an endpoint you control, so what it reports is a claim rather than evidence.";
    case "subscription":
      return "Flat-rate plans have no per-request cost; held pending policy.";
    default:
      return "USAGE cannot yet authoritatively establish the economic funding source for this API-key connection. The connection works and routed requests are proven; rewards are held.";
  }
}
