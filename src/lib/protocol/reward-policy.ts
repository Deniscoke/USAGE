/**
 * Reward eligibility policy.
 *
 * TWO DIFFERENT QUESTIONS, and conflating them is how a metering system becomes
 * a printing press:
 *
 *   1. DID THIS COMPUTE REALLY HAPPEN?   -> proof_status, from evidence
 *   2. SHOULD IT EARN USAGE?             -> reward_status, from policy
 *
 * A CONFIRMED proof does not imply a reward. Free hosted inference is real
 * compute, really observed, and really provable -- and paying for it would make
 * bot farming rational the moment Usage Points have any value.
 *
 * The protocol compute value deliberately ignores what anyone paid, because two
 * identical requests must mine identically. That is right for *measurement* and
 * wrong for *economics*, so economics gets its own layer here rather than a
 * fudge factor inside pricing.
 *
 *   proof -> protocol compute value -> REWARD POLICY -> eligible compute
 *         -> mining score -> epoch reward
 *
 * Nothing here ever downgrades or deletes proof evidence. A held reward keeps
 * its signed receipt, and can be released by a later policy version without
 * re-proving anything.
 */

/**
 * Where the compute came from ECONOMICALLY, independent of how it was proved.
 *
 *   metered_paid  billed at a real rate by a provider, on a real account
 *   byok          the user's own provider credential, cost not yet established
 *   subscription  a flat-rate plan; marginal cost of one request is not defined
 *   free          the provider states it cost nothing
 *   promotional   credit somebody else funded, including USAGE's own gateway
 *   unknown       no trustworthy evidence either way
 *
 * DERIVED FROM TRUSTED EVIDENCE ONLY. A client never chooses this, and a
 * provider's word alone never establishes `metered_paid` -- a malicious user can
 * control both their own endpoint and their USAGE account, so "my API said it
 * cost $5" is a claim, not evidence.
 */
export type EconomicSourceClass =
  | "metered_paid"
  | "byok"
  | "subscription"
  | "free"
  | "promotional"
  | "unknown";

/**
 * May this compute earn, right now?
 *
 *   eligible    counts toward mining
 *   held        might earn under a future policy; nothing is credited yet
 *   ineligible  will not earn under this policy
 */
export type RewardStatus = "eligible" | "held" | "ineligible";

export type RewardReason =
  | "metered_paid"
  | "byok_paid_evidence"
  | "free_inference"
  | "promotional_credit"
  | "subscription_pending_policy"
  | "byok_cost_unknown"
  | "source_unknown"
  | "proof_not_confirmed"
  | "no_economic_weight"
  | "not_priced"
  | "legacy_pre_policy";

export interface RewardPolicyVersion {
  version: string;
  effectiveFrom: string;
  status: "active" | "superseded";
  description: string;
  /** What each economic source class earns under this policy. */
  rules: Readonly<Record<EconomicSourceClass, RewardStatus>>;
}

/**
 * The beta policy: conservative on purpose.
 *
 * `held` rather than `ineligible` wherever the answer is "we do not know yet".
 * Holding is reversible and honest; declaring something ineligible forever
 * because evidence was missing would quietly destroy real work.
 *
 * `free` is the one hard no. Free compute is genuinely valuable to prove and
 * genuinely worth nothing to reward: if it earned, the cheapest way to mine
 * would be to burn free inference in a loop, which is exactly the behaviour the
 * fixed-pool design exists to make pointless.
 */
export const REWARD_POLICY_V1: RewardPolicyVersion = {
  version: "usage-reward-policy-v1",
  effectiveFrom: "2026-09-09",
  status: "active",
  description:
    "Beta policy. Metered paid compute earns; free compute never does; anything unproven is held rather than paid or discarded.",
  rules: {
    metered_paid: "eligible",
    byok: "held",
    subscription: "held",
    free: "ineligible",
    promotional: "held",
    unknown: "held",
  },
};

/**
 * The grandfather policy for records written before eligibility existed.
 *
 * Historical economic decisions must stay reproducible, and settled epochs must
 * not move. Rows created before v1 keep the decision they were actually made
 * under, labelled so nobody mistakes it for a v1 judgement.
 */
export const REWARD_POLICY_V0: RewardPolicyVersion = {
  version: "usage-reward-policy-v0",
  effectiveFrom: "2026-09-01",
  status: "superseded",
  description:
    "Pre-policy records. Economic status was decided by proof status alone; preserved so historical epochs stay reproducible.",
  rules: {
    metered_paid: "eligible",
    byok: "eligible",
    subscription: "eligible",
    free: "eligible",
    promotional: "eligible",
    unknown: "eligible",
  },
};

const POLICIES: readonly RewardPolicyVersion[] = [REWARD_POLICY_V0, REWARD_POLICY_V1];

export const CURRENT_REWARD_POLICY = REWARD_POLICY_V1;

export function getRewardPolicy(version: string): RewardPolicyVersion | null {
  return POLICIES.find((policy) => policy.version === version) ?? null;
}

export function listRewardPolicies(): readonly RewardPolicyVersion[] {
  return POLICIES;
}

/**
 * Evidence USAGE actually holds about who paid for a request.
 *
 * Every field here is established server-side: which gateway ran it, what the
 * upstream reported, and whether that upstream is trusted to report cost at all.
 */
export interface EconomicEvidence {
  /** The gateway that executed it. `connection:*` means the user's own key. */
  gatewayId: string | null;
  /** Authoritative cost in micro-USD, or null when nobody stated one. */
  actualCostMicros: number | null;
  /** How that cost was established. Only some bases are trustworthy. */
  actualCostBasis?: string | null;
  /** True when USAGE's own credential and budget paid for the request. */
  usageFunded: boolean;
  /**
   * True when the user controls the endpoint that produced this figure.
   *
   * A custom provider connection means the same person may control both the
   * endpoint and the USAGE account, so a cost it reports is a CLAIM, not
   * evidence. See deriveEconomicSource for what that changes.
   */
  endpointControlledByUser?: boolean;
  /** Set when a verified import told us the account is on a flat plan. */
  subscription?: boolean;
}

/** Cost bases USAGE will act on economically. A share or a guess is not one. */
const AUTHORITATIVE_COST_BASES = new Set(["gateway_reported", "provider_reported"]);

/**
 * Classify the economic provenance of one request.
 *
 * The ordering matters. USAGE-funded compute is settled first, because a
 * provider reporting a cost against USAGE's own account says nothing about the
 * user having paid anything.
 */
export function deriveEconomicSource(evidence: EconomicEvidence): EconomicSourceClass {
  if (evidence.subscription) return "subscription";

  // USAGE's own gateway budget. Real compute, really observed -- but the user
  // did not fund it, so rewarding it would be USAGE paying twice for the same
  // dollar.
  if (evidence.usageFunded) return "promotional";

  const statedCost =
    evidence.actualCostMicros !== null &&
    AUTHORITATIVE_COST_BASES.has(evidence.actualCostBasis ?? "");

  // A stated ZERO is always accepted, wherever it came from. It can only ever
  // reduce a reward, so nobody has a motive to lie in this direction -- and
  // refusing it would mean free compute quietly earned.
  if (statedCost && evidence.actualCostMicros === 0) return "free";

  const userControlsEndpoint =
    evidence.endpointControlledByUser ?? Boolean(evidence.gatewayId?.startsWith("connection:"));

  // A stated POSITIVE cost is only evidence when the user does not control the
  // thing that stated it. Otherwise "my API says this cost $500" would be a way
  // to mint eligibility, which is the one thing this layer exists to prevent.
  if (statedCost && !userControlsEndpoint) return "metered_paid";

  return userControlsEndpoint ? "byok" : "unknown";
}

export interface RewardDecisionInput {
  proofStatus: string;
  verificationType: string;
  economicSource: EconomicSourceClass;
  /** Deterministic protocol value of the compute, or null when unpriced. */
  protocolComputeMicros: number | null;
  policy?: RewardPolicyVersion;
}

export interface RewardDecision {
  status: RewardStatus;
  reason: RewardReason;
  policyVersion: string;
  /**
   * Compute that actually counts toward mining, in micro-USD.
   *
   * Zero whenever the reward is not eligible. Kept separate from
   * `protocolComputeMicros` so a held record still says what it WOULD be worth,
   * and so releasing a hold is a policy decision rather than a re-measurement.
   */
  eligibleComputeMicros: number;
}

/**
 * Decide whether one confirmed proof earns.
 *
 * Every decision records the policy that made it, so it can be explained and
 * reproduced later. There is no branch here that a client can influence.
 */
export function decideReward(input: RewardDecisionInput): RewardDecision {
  const policy = input.policy ?? CURRENT_REWARD_POLICY;

  // Proof first. Economics never rescue evidence that was not confirmed.
  if (input.proofStatus !== "confirmed") {
    return {
      status: "ineligible",
      reason: "proof_not_confirmed",
      policyVersion: policy.version,
      eligibleComputeMicros: 0,
    };
  }

  // Self-reported usage is displayed and never rewarded, whatever else is true.
  if (input.verificationType === "reported") {
    return {
      status: "ineligible",
      reason: "no_economic_weight",
      policyVersion: policy.version,
      eligibleComputeMicros: 0,
    };
  }

  // Real, provable compute with no approved price. Held, not discarded: a
  // future pricing snapshot can make it earn without re-proving anything.
  if (input.protocolComputeMicros === null) {
    return {
      status: "held",
      reason: "not_priced",
      policyVersion: policy.version,
      eligibleComputeMicros: 0,
    };
  }

  const status = policy.rules[input.economicSource];
  return {
    status,
    reason: reasonFor(input.economicSource, status),
    policyVersion: policy.version,
    // The whole economic effect of the policy, in one number.
    eligibleComputeMicros: status === "eligible" ? input.protocolComputeMicros : 0,
  };
}

function reasonFor(source: EconomicSourceClass, status: RewardStatus): RewardReason {
  if (status === "eligible") {
    return source === "byok" ? "byok_paid_evidence" : "metered_paid";
  }
  switch (source) {
    case "free":
      return "free_inference";
    case "promotional":
      return "promotional_credit";
    case "subscription":
      return "subscription_pending_policy";
    case "byok":
      return "byok_cost_unknown";
    default:
      return "source_unknown";
  }
}

/** One sentence a person can act on, per reason. Shown in the product. */
export const REWARD_REASON_COPY: Record<RewardReason, string> = {
  metered_paid: "Paid compute, verified by the provider's own billing figure.",
  byok_paid_evidence: "Your own provider account was billed for this compute.",
  free_inference:
    "This usage is verified, but free inference does not earn beta USAGE. The proof still counts as history.",
  promotional_credit:
    "USAGE's own gateway credit paid for this compute, so it is proven but does not earn beta USAGE.",
  subscription_pending_policy:
    "Flat-rate subscription usage has no per-request cost yet, so rewards are held pending policy.",
  byok_cost_unknown:
    "Your provider did not report a cost for this request, so the reward is held rather than guessed.",
  source_unknown: "USAGE has no trustworthy evidence of who paid, so the reward is held.",
  proof_not_confirmed: "USAGE does not attest to this as trusted evidence.",
  no_economic_weight: "Self-reported usage is shown in your history and never earns.",
  not_priced:
    "No approved protocol price covers this model yet, so the reward is held until one does.",
  legacy_pre_policy: "Decided before reward policy existed; preserved unchanged.",
};

export const REWARD_STATUS_COPY: Record<RewardStatus, string> = {
  eligible: "Earning",
  held: "Held",
  ineligible: "Not earning",
};

export const ECONOMIC_SOURCE_COPY: Record<EconomicSourceClass, string> = {
  metered_paid: "Paid",
  byok: "Your own key",
  subscription: "Subscription",
  free: "Free",
  promotional: "Promotional credit",
  unknown: "Unknown",
};
