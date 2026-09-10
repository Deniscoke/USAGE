import { createHash } from "node:crypto";
import type { EconomicSourceClass } from "./reward-policy";

/**
 * The economic compute unit.
 *
 * ONE EconomicComputeUnit is ONE unique AI inference that may earn at most ONE
 * reward. It is not a telemetry event, not a receipt, not a request log, not a
 * device event and not a provider import row: those are EVIDENCE about a unit.
 * Several pieces of evidence (Claude Code's own telemetry, USAGE's routed
 * observation, the gateway's record, a later provider import) must converge on
 * one unit, and the unit is rewarded once however many of them arrive.
 *
 * The canonical unit is a `usage_events` row. No second table: a duplicate
 * truth would eventually disagree with the first. What this module adds is the
 * IDENTITY that lets evidence converge, the EVIDENCE model that says who is
 * allowed to assert what, and the VERIFICATION policy that decides whether a
 * unit is economically established -- all of it server-side, none of it
 * settable by a client.
 *
 * Three questions, answered independently and never collapsed:
 *
 *   A. did compute happen?              verification_status / proof_status
 *   B. is it unique, not yet rewarded?  dedupe_status
 *   C. is its funding reward-eligible?  economic verification -> reward policy
 *
 * A unit affects mining only when all three say yes.
 */

// ------------------------------------------------------------------ authority

/**
 * Who produced a piece of evidence.
 *
 *   device                 a paired device's own telemetry (Claude Code OTel)
 *   usage_gateway          USAGE executed the request and watched the response
 *   provider               the provider's own per-request record (OpenRouter
 *                          /generation, Vercel /v1/generation, a response id)
 *   provider_admin_import  a verified import of the provider's billing export
 */
export type SourceAuthority = "device" | "usage_gateway" | "provider" | "provider_admin_import";

/**
 * How far the evidence can be trusted, as a whole.
 *
 *   trusted_server          produced by hosted USAGE code (a routed observation)
 *   provider_authoritative  produced by the provider about its own service
 *   device_reported         produced by software on a machine the user controls
 *   unknown                 provenance not established
 */
export type EvidenceTrust = "trusted_server" | "provider_authoritative" | "device_reported" | "unknown";

/**
 * Where the money came from. Established server-side from the account that
 * carried the request; never from a request body, a header, or telemetry.
 *
 *   usage_credit       USAGE's own gateway key and budget
 *   free_tier_account  the provider states the account has never purchased
 *                      credits (OpenRouter `is_free_tier: true`)
 *   paid_account       the provider states the account has purchased credits
 *                      (OpenRouter `is_free_tier: false`)
 *   byok_upstream      the provider says the request ran on the user's own
 *                      upstream key (OpenRouter/Vercel `is_byok: true`)
 *   subscription       a flat-rate plan (a verified import said so)
 *   unknown            nobody authoritative has said
 */
export type FundingClass =
  | "usage_credit"
  | "free_tier_account"
  | "paid_account"
  | "byok_upstream"
  | "subscription"
  | "unknown";

export interface FundingEvidence {
  class: FundingClass;
  /** What established it, e.g. "openrouter:/api/v1/key#is_free_tier". */
  basis: string;
  /** When the provider said so. Funding facts go stale; this says how stale. */
  observedAt?: string | null;
}

/**
 * Which authority may own which FIELD. Authority is field-specific: a device
 * is authoritative for exactly one fact, that it observed something; USAGE's
 * reward policy is authoritative for eligibility and nothing else.
 *
 * Researched against the surfaces USAGE actually uses (September 2026):
 *
 *   request identity   provider (response `request-id` / `x-request-id`,
 *                      generation `id`) > usage_gateway (read it off the wire)
 *                      > provider_admin_import (no per-request ids in the
 *                      Anthropic/OpenAI admin exports) > device (a claim)
 *   token usage        provider (OpenRouter/Vercel generation record, native
 *                      counts) > usage_gateway (response `usage`) >
 *                      provider_admin_import (aggregates) > device
 *   actual cost        provider (OpenRouter `usage.cost` / `total_cost`,
 *                      Vercel `total_cost`) > usage_gateway (only what it
 *                      relayed from the provider) > import > device (never;
 *                      Claude Code's `cost_usd` is the tool's own estimate)
 *   funding class      provider account surface (OpenRouter `/api/v1/key`,
 *                      Vercel `/v1/credits` + purchase state) > usage_gateway
 *                      (knows when USAGE's own key paid) > import > device (never)
 *   model              provider > usage_gateway > device
 *   "it was observed"  device is authoritative for its own observation only
 *   protocol value,    USAGE reward/pricing policy, exclusively
 *   eligibility,
 *   reward status
 */
export const FIELD_AUTHORITY: Readonly<Record<string, readonly SourceAuthority[]>> = {
  request_identity: ["provider", "usage_gateway", "provider_admin_import"],
  token_usage: ["provider", "usage_gateway", "provider_admin_import", "device"],
  actual_cost: ["provider", "usage_gateway", "provider_admin_import"],
  funding_class: ["provider", "usage_gateway", "provider_admin_import"],
  model: ["provider", "usage_gateway", "device"],
  observed_by_device: ["device"],
};

/** Rank for "prefer the higher authority": lower index wins. */
export const AUTHORITY_RANK: Readonly<Record<SourceAuthority, number>> = {
  provider: 0,
  usage_gateway: 1,
  provider_admin_import: 2,
  device: 3,
};

// ------------------------------------------------------------------ identity

/**
 * Which identities may anchor an economic unit, in the order they are tried.
 *
 *   provider_request_id       the provider's own request id, as it appeared in
 *                             the upstream response (`request-id` on Anthropic,
 *                             `x-request-id` on OpenAI-compatible surfaces).
 *                             The one identity a local tool can also see.
 *   gateway_generation_id     the gateway's generation id (`gen_...` Vercel,
 *                             `gen-...` OpenRouter, or the response `id` a
 *                             connection returned).
 *   provider_import_identity  the deterministic identity of a verified import
 *                             bucket. Unique per bucket, never per request.
 */
export type IdentityKind = "provider_request_id" | "gateway_generation_id" | "provider_import_identity";

export interface AuthoritativeIdentity {
  kind: IdentityKind;
  value: string;
  /** Who reported it. A device may REPORT an id; it never anchors one. */
  authority: SourceAuthority;
  /**
   * The namespace the id is unique within. For a provider request id that is
   * the provider; for a generation id it is the gateway that minted it.
   */
  namespace: string;
}

const KEY_VERSION = "usage-economic-key-v1";

/**
 * AUTHORITY SCOPE -- what makes an id unique, researched (September 2026):
 *
 *   Anthropic `request-id`     "Every API response includes a unique
 *                              request-id header" (req_...). Support locates
 *                              a request from the id alone: GLOBAL.
 *   OpenAI `x-request-id`      req_... "unique identifier" for reporting a
 *                              request to OpenAI from the id alone: GLOBAL.
 *   OpenRouter `gen-...`       `GET /api/v1/generation?id=` takes the id as
 *                              its only parameter: GLOBAL. OpenRouter documents
 *                              no per-response request-id header, so an
 *                              `x-request-id` seen from it is NOT an identity.
 *   Vercel `gen_<ulid>`        `GET /v1/generation?id=` takes the id alone;
 *                              ULIDs are globally unique: GLOBAL.
 *   OpenAI org import          bucket identity already carries the
 *                              organization id the admin API authenticated:
 *                              scoped to the TENANT by construction.
 *   user-controlled endpoint   a custom connection's server may return any
 *                              id it likes, so its ids are unique only within
 *                              that connection. Scoped to the CONNECTION --
 *                              a server-issued uuid, never a client label.
 *
 * Because every trusted identity is global (or tenant-scoped by
 * construction), the key deliberately contains NO USAGE user id: the same
 * compute claimed by two USAGE accounts must collide, and a second claim is a
 * duplicate, never a second unit. Migration 0018 enforces that with a global
 * unique index. The user who owns the reward is the user_id of the row that
 * IS the unit; nothing may reassign it (see 0018's user_id trigger).
 */
export const DOCUMENTED_REQUEST_ID_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai"]);

/**
 * The canonical identity of a compute unit, or null.
 *
 *   sha256( key version, namespace, canonical provider, identity kind, id )
 *
 * Only an authoritative identity produces a key: a device-reported id is a
 * claim about somebody else's system, so it may CORRELATE with a unit that has
 * a key but can never mint one. Nothing else is an ingredient -- not a
 * timestamp, not token counts, not a local session or event id, not a device
 * signature, not a client-chosen UUID -- because every one of those is either
 * guessable (so two different requests collide) or free to fabricate (so one
 * request becomes many). And a client-submitted hash is never accepted: the
 * key is recomputed here from ingredients the server obtained itself.
 *
 * The namespace is the system that issued the id, not the system that observed
 * it: USAGE's gateway and a provider import that both see Anthropic's
 * `req_...` must derive the SAME key, or the same compute is two units.
 */
export function economicEventKey(provider: string, identity: AuthoritativeIdentity | null): string | null {
  if (!identity) return null;
  if (identity.authority === "device") return null;
  const value = identity.value.trim();
  if (!value) return null;
  const canonicalProvider = provider.trim().toLowerCase();
  if (!canonicalProvider) return null;
  const digest = createHash("sha256")
    .update([KEY_VERSION, identity.namespace, canonicalProvider, identity.kind, value].join("\n"))
    .digest("hex");
  return `ecu1:${digest}`;
}

/**
 * Choose the identity that anchors a unit, from what the evidence carries.
 *
 * Provider request id first: it is the provider's own name for the request and
 * the only one that local telemetry can also see. Gateway generation id
 * second: unique per request, but only the gateway knows it. An import bucket
 * identity last. Device evidence yields nothing, by construction.
 */
export function selectAuthoritativeIdentity(evidence: {
  sourceAuthority: SourceAuthority;
  authoritativeRequestId: string | null;
  gatewayGenerationId: string | null;
  gatewayId?: string | null;
  importIdentity?: string | null;
  provider: string;
  /**
   * True for a custom connection whose server the user controls. Its ids are
   * scoped to that connection; a trusted provider's ids are global.
   */
  endpointControlledByUser?: boolean;
}): AuthoritativeIdentity | null {
  if (evidence.sourceAuthority === "device") return null;
  const provider = evidence.provider.toLowerCase();
  // A user-controlled server's ids are unique only within that connection.
  // The connection id is issued by the server (`connection:<uuid>`), so the
  // scope cannot be chosen by a client.
  const scope = evidence.endpointControlledByUser ? (evidence.gatewayId ?? null) : null;
  if (evidence.endpointControlledByUser && !scope) return null;

  // A provider request id anchors the unit only where the provider documents
  // it as a unique request identifier. Elsewhere the header may be a proxy's
  // or CDN's, and a proxy id is not an identity.
  if (evidence.authoritativeRequestId && (scope || DOCUMENTED_REQUEST_ID_PROVIDERS.has(provider))) {
    return {
      kind: "provider_request_id",
      value: evidence.authoritativeRequestId,
      authority: evidence.sourceAuthority,
      namespace: scope ?? provider,
    };
  }
  if (evidence.gatewayGenerationId) {
    return {
      kind: "gateway_generation_id",
      value: evidence.gatewayGenerationId,
      authority: evidence.sourceAuthority,
      // A trusted gateway's generation id is global within that gateway;
      // the connection that relayed it is not part of the identity.
      namespace: scope ?? provider,
    };
  }
  if (evidence.importIdentity) {
    return {
      kind: "provider_import_identity",
      value: evidence.importIdentity,
      authority: evidence.sourceAuthority,
      namespace: "provider_import",
    };
  }
  return null;
}

// ------------------------------------------------------------------ evidence

/**
 * One piece of evidence about a compute unit, normalized.
 *
 * Every field that could move money is nullable and is filled by the server
 * from a surface it trusts. A client submits none of: economic verification,
 * reward eligibility, protocol compute, mining score, points, funding class.
 * The telemetry allowlist rejects an upload that so much as names them.
 */
export interface EconomicUsageEvidence {
  source: string;
  sourceAuthority: SourceAuthority;
  evidenceTrust: EvidenceTrust;
  provider: string;
  model: string | null;
  authoritativeRequestId: string | null;
  gatewayGenerationId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  actualCostMicros: number | null;
  /** Who stated the cost. Only "gateway_reported"/"provider_reported" count. */
  actualCostAuthority: string | null;
  fundingClass: FundingClass | null;
  /**
   * True when the endpoint that produced the usage and cost is one the user
   * controls (a custom connection). Its figures are claims, and funding
   * evidence about it is meaningless, because "the account" is the user.
   */
  endpointControlledByUser?: boolean;
  occurredAt: string;
}

/** Usage counts that were established by someone other than the user's machine. */
export function usageIsAuthoritative(evidence: EconomicUsageEvidence): boolean {
  if (evidence.sourceAuthority === "device") return false;
  if (evidence.evidenceTrust !== "trusted_server" && evidence.evidenceTrust !== "provider_authoritative") return false;
  return evidence.inputTokens !== null || evidence.outputTokens !== null;
}

// ------------------------------------------------------------------ dedupe

/**
 *   unique     the first unit USAGE has seen with this key
 *   duplicate  another unit already carries this key; this row is evidence
 *              for it and earns nothing itself
 *   conflict   two sources claim the key and disagree on what happened
 *   unkeyed    no authoritative identity, so uniqueness cannot be established
 */
export type DedupeStatus = "unique" | "duplicate" | "conflict" | "unkeyed";

export interface ComparableEvidence {
  authority: SourceAuthority;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  actualCostMicros: number | null;
}

export type ConflictField = "provider" | "model" | "input_tokens" | "output_tokens" | "actual_cost";

/**
 * Do two pieces of evidence for the same identity describe the same compute?
 *
 * Exact on provider and model family. Token counts may differ by a rounding
 * margin between what a tool logged and what the provider billed (tokenizer
 * accounting, streaming cutoffs), so a small relative tolerance is allowed;
 * anything beyond it is a disagreement, and a disagreement is recorded as
 * such rather than resolved by picking a favourite. A null on either side is
 * "did not say", not a disagreement.
 */
export function compareEvidence(a: ComparableEvidence, b: ComparableEvidence): ConflictField[] {
  const conflicts: ConflictField[] = [];
  if (a.provider.toLowerCase() !== b.provider.toLowerCase()) conflicts.push("provider");
  if (a.model && b.model && modelFamily(a.model) !== modelFamily(b.model)) conflicts.push("model");
  if (!countsAgree(a.inputTokens, b.inputTokens)) conflicts.push("input_tokens");
  if (!countsAgree(a.outputTokens, b.outputTokens)) conflicts.push("output_tokens");
  if (a.actualCostMicros !== null && b.actualCostMicros !== null && a.actualCostMicros !== b.actualCostMicros) {
    conflicts.push("actual_cost");
  }
  return conflicts;
}

export const TOKEN_TOLERANCE = { relative: 0.01, absolute: 2 } as const;

function countsAgree(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  const allowed = Math.max(TOKEN_TOLERANCE.absolute, Math.ceil(Math.max(a, b) * TOKEN_TOLERANCE.relative));
  return Math.abs(a - b) <= allowed;
}

/** "anthropic/claude-sonnet-5" and "claude-sonnet-5-20260501" are one family. */
export function modelFamily(model: string): string {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return bare.toLowerCase().replace(/-\d{8}$/, "").replace(/:.*$/, "");
}

/**
 * Which side's value a field takes when they agree enough to be one unit.
 * Higher authority wins, per FIELD_AUTHORITY; a field the winner did not state
 * falls through to the next. Never used to paper over a conflict: callers
 * check compareEvidence first.
 */
export function preferByAuthority<T>(
  field: keyof typeof FIELD_AUTHORITY,
  candidates: readonly { authority: SourceAuthority; value: T | null }[],
): T | null {
  const order = FIELD_AUTHORITY[field] ?? [];
  for (const authority of order) {
    const hit = candidates.find((c) => c.authority === authority && c.value !== null);
    if (hit) return hit.value;
  }
  return null;
}

// ------------------------------------------------------------------ classification

/**
 * What a request was funded by, as a source class -- decided ONLY here.
 *
 * `economic-verification-v1` is deliberately stricter than the M9 rule it
 * sits in front of. M9 said "a positive cost from an endpoint the user does
 * not control is metered_paid". That is necessary but not sufficient: a
 * positive list-price cost is charged against promotional credit just as
 * readily as against purchased credit, and the response looks identical.
 * Cost > 0 is evidence that compute HAPPENED and what it was WORTH; it is not
 * evidence that anyone PAID. Payment is a fact about the account, and only
 * the provider's account surface can state it.
 */
export interface ClassificationInput {
  /** `connection:*` means the user's own connection; else USAGE's gateway. */
  gatewayId: string | null;
  actualCostMicros: number | null;
  actualCostAuthority: string | null;
  usageFunded: boolean;
  endpointControlledByUser: boolean;
  subscription?: boolean;
  funding: FundingEvidence | null;
}

const AUTHORITATIVE_COST = new Set(["gateway_reported", "provider_reported"]);

/**
 * WHAT `metered_paid` ASSERTS, exactly (M14B audit, September 2026):
 *
 *   OpenRouter `is_free_tier`  "whether the user has paid for credits before"
 *                              -- an ACCOUNT fact. `usage.cost` / `total_cost`
 *                              "the total amount charged to your account" --
 *                              a per-inference CHARGE. `is_byok` says the
 *                              user's own upstream key served it and
 *                              `upstream_inference_cost` what that would have
 *                              cost at list. None of them says which credit
 *                              balance a specific inference was drawn from.
 *   Vercel `/v1/credits`       balance + total_used only; no purchase flag,
 *                              no per-generation funding source.
 *
 * So no surface USAGE uses can distinguish, per request, purchased credit
 * from bonus / promotional / monthly free credit on an account that HAS
 * purchased. `metered_paid` therefore means precisely:
 *
 *   paid-capable account (provider-stated) + positive charged inference
 *   (provider-stated) + endpoint the user does not control
 *
 * -- "paid_account_metered", not source-of-funds provenance. The public
 * class name is kept; M15 must read it with this meaning. The conservative
 * rule follows: an account the provider has NOT stated as paid is
 * promotional (held) whatever it was charged, and USAGE's own key is always
 * promotional.
 */
export function classifyEconomicSource(input: ClassificationInput): EconomicSourceClass {
  if (input.subscription || input.funding?.class === "subscription") return "subscription";

  // USAGE's own budget, whatever it cost: rewarding it would be USAGE paying
  // twice for the same dollar.
  if (input.usageFunded || input.funding?.class === "usage_credit") return "promotional";

  const costStated = input.actualCostMicros !== null && AUTHORITATIVE_COST.has(input.actualCostAuthority ?? "");

  // A stated zero is accepted from anywhere: it can only reduce a reward.
  if (costStated && input.actualCostMicros === 0) return "free";

  // A cost stated by something the user controls is a claim, not evidence.
  if (input.endpointControlledByUser) return "byok";

  // The provider ran it on the user's own upstream key. The user's upstream
  // account paid -- and nothing here can see whether that account is paid.
  if (input.funding?.class === "byok_upstream") return "byok";

  // The provider says this account has never bought credit. A positive cost
  // here was charged to free credit, which is promotional funding.
  if (input.funding?.class === "free_tier_account") return "promotional";

  // metered_paid needs all three: a trusted endpoint, a positive authoritative
  // cost, and the provider's own statement that the account is a paying one.
  if (costStated && (input.actualCostMicros ?? 0) > 0 && input.funding?.class === "paid_account") {
    return "metered_paid";
  }

  return "unknown";
}

// ------------------------------------------------------------------ verification policy

export type EconomicVerificationStatus = "verified" | "held" | "ineligible" | "not_verified";

export type EconomicVerificationReason =
  | "local_only"
  | "no_authoritative_identity"
  | "evidence_not_trusted"
  | "usage_not_authoritative"
  | "duplicate_unit"
  | "identity_conflict"
  | "metered_paid_verified"
  | "byok_paid_verified"
  | "byok_funding_unproven"
  | "free_inference"
  | "promotional_funding"
  | "subscription_pending_policy"
  | "funding_unknown";

export interface EconomicVerificationPolicy {
  version: string;
  effectiveFrom: string;
  status: "active" | "superseded";
  description: string;
}

/**
 * The beta economic verification policy. Conservative on purpose: every
 * ambiguous case is HELD, which is reversible, rather than rewarded, which is
 * not. It does not replace `usage-reward-policy-v1`; it decides whether the
 * evidence is strong enough to hand that policy a class at all.
 */
export const ECONOMIC_VERIFICATION_POLICY_V1: EconomicVerificationPolicy = {
  version: "economic-verification-v1",
  effectiveFrom: "2026-09-10",
  status: "active",
  description:
    "Beta. A unit is economically verified only with an authoritative identity, authoritative usage and provider-stated paid funding. Free is ineligible; promotional, subscription, BYOK-without-proof and unknown are held; device-only evidence is never economically verified.",
};

export const CURRENT_ECONOMIC_VERIFICATION_POLICY = ECONOMIC_VERIFICATION_POLICY_V1;

const ECONOMIC_POLICIES: readonly EconomicVerificationPolicy[] = [ECONOMIC_VERIFICATION_POLICY_V1];

export function getEconomicVerificationPolicy(version: string): EconomicVerificationPolicy | null {
  return ECONOMIC_POLICIES.find((policy) => policy.version === version) ?? null;
}

export interface EconomicVerificationInput {
  evidence: EconomicUsageEvidence;
  economicEventKey: string | null;
  dedupeStatus: DedupeStatus;
  sourceClass: EconomicSourceClass;
  policy?: EconomicVerificationPolicy;
}

export interface EconomicVerificationDecision {
  status: EconomicVerificationStatus;
  reason: EconomicVerificationReason;
  policyVersion: string;
}

export function verifyEconomically(input: EconomicVerificationInput): EconomicVerificationDecision {
  const policyVersion = (input.policy ?? CURRENT_ECONOMIC_VERIFICATION_POLICY).version;
  const decide = (status: EconomicVerificationStatus, reason: EconomicVerificationReason) => ({
    status,
    reason,
    policyVersion,
  });
  const { evidence } = input;

  // LOCAL_ONLY. A device signature proves a paired device produced the
  // observation; it proves nothing about the provider, the counts, the money
  // or uniqueness. Economically powerless, by policy and by construction.
  if (evidence.sourceAuthority === "device") return decide("not_verified", "local_only");
  if (!input.economicEventKey) return decide("not_verified", "no_authoritative_identity");
  if (evidence.evidenceTrust !== "trusted_server" && evidence.evidenceTrust !== "provider_authoritative") {
    return decide("not_verified", "evidence_not_trusted");
  }
  if (!usageIsAuthoritative(evidence)) return decide("held", "usage_not_authoritative");

  // Uniqueness before funding: a second copy of a paid request is not paid twice.
  if (input.dedupeStatus === "duplicate") return decide("held", "duplicate_unit");
  if (input.dedupeStatus === "conflict") return decide("held", "identity_conflict");

  switch (input.sourceClass) {
    case "metered_paid":
      // classifyEconomicSource only says metered_paid with paid_account
      // funding and a positive authoritative cost; re-checked here so the
      // policy does not depend on the classifier's internals.
      return evidence.fundingClass === "paid_account" && (evidence.actualCostMicros ?? 0) > 0
        ? decide("verified", "metered_paid_verified")
        : decide("held", "funding_unknown");
    case "byok":
      // "byok_paid" in the brief: the user's own upstream account, PROVEN paid.
      // No surface USAGE uses can prove that today, so this branch is held
      // until one exists. The condition is written so the day it does, the
      // policy version is what changes -- not a silent flip.
      return !evidence.endpointControlledByUser &&
        evidence.fundingClass === "paid_account" &&
        (evidence.actualCostMicros ?? 0) > 0
        ? decide("verified", "byok_paid_verified")
        : decide("held", "byok_funding_unproven");
    case "free":
      return decide("ineligible", "free_inference");
    case "promotional":
      return decide("held", "promotional_funding");
    case "subscription":
      return decide("held", "subscription_pending_policy");
    default:
      return decide("held", "funding_unknown");
  }
}

/** Metadata keys the adapter writes so an auditor can replay every decision. */
export const ECONOMIC_METADATA_KEYS = [
  "economic_event_key",
  "economic_identity_kind",
  "economic_identity_authority",
  "dedupe_status",
  "economic_duplicate_of",
  "funding_class",
  "funding_basis",
  "economic_verification_status",
  "economic_verification_reason",
  "economic_verification_policy_version",
  "source_authority",
  "evidence_trust",
] as const;

/** Read the key an event carries, wherever the schema of the day keeps it. */
export function economicKeyOf(rawMetadata: Record<string, unknown> | null | undefined): string | null {
  const value = rawMetadata?.economic_event_key;
  return typeof value === "string" && value.startsWith("ecu1:") ? value : null;
}
