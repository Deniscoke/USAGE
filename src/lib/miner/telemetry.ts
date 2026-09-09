import { createHash, createPublicKey, verify } from "node:crypto";
import { describeTool, VERIFICATION_RANK, type VerificationLevel } from "./tools";

/**
 * Local observation ingestion: validate, verify, dedupe, correlate.
 *
 * Pure decision logic, framework-free, exercised directly by tests. The route
 * calls it; the store executes what it decides.
 *
 * THE ONE RULE, restated because everything here bends toward it: a device
 * upload can never create economic value. It can create a row in
 * local_usage_observations (analytics for the user), and it can attach itself
 * as extra provenance to a usage_event the server already trusts. It cannot
 * insert a usage_event, alter a reward, or change a price.
 */

export const ACCEPTED_SCHEMAS = ["local-usage-observation-v1"] as const;
export const TELEMETRY_LIMITS = {
  maxObservationsPerBatch: 200,
  maxBodyBytes: 256 * 1024,
  maxRequestIdLength: 200,
  maxTokenValue: 100_000_000,
} as const;

export interface IncomingObservation {
  schema: string;
  adapter: string;
  tool: string;
  toolVersion: string | null;
  sourceType: string;
  provider: string;
  model: string | null;
  upstreamRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  toolTokens: number | null;
  estimatedCostMicros: number | null;
  occurredAt: string;
  localSessionId: string;
  localEventId: string;
}

export interface IncomingSigned {
  observation: IncomingObservation;
  signature: { version: string; value: string } | null;
}

const OBSERVATION_KEYS = new Set([
  "schema", "adapter", "tool", "toolVersion", "sourceType", "provider", "model",
  "upstreamRequestId", "inputTokens", "outputTokens", "cacheReadTokens",
  "cacheWriteTokens", "reasoningTokens", "toolTokens", "estimatedCostMicros",
  "occurredAt", "localSessionId", "localEventId",
]);

/** Field names a client might try to smuggle. Presence alone rejects the item. */
const FORBIDDEN_KEYS = [
  "proof_status", "proofStatus", "verification_type", "verificationType", "verification_status",
  "economic_status", "economicStatus", "reward", "reward_status", "rewardStatus", "eligible_compute_micros",
  "protocol_compute_micros", "points", "score", "pricing", "prompt", "response", "messages", "body",
];

function optionalInt(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > TELEMETRY_LIMITS.maxTokenValue) {
    return undefined;
  }
  return value;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

export type ValidationResult =
  | { ok: true; observation: IncomingObservation; signature: { version: string; value: string } | null }
  | { ok: false; reason: string };

/**
 * Strict schema validation. Unknown keys reject the item rather than being
 * ignored: an unknown key is either a client bug or an attempt, and neither
 * should be silently tolerated on a security boundary.
 */
export function validateIncoming(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not_an_object" };
  const item = raw as { observation?: unknown; signature?: unknown };
  const o = item.observation;
  if (!o || typeof o !== "object") return { ok: false, reason: "missing_observation" };
  const obj = o as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.includes(key)) return { ok: false, reason: `forbidden_field:${key}` };
    if (!OBSERVATION_KEYS.has(key)) return { ok: false, reason: `unknown_field:${key}` };
  }
  if (!ACCEPTED_SCHEMAS.includes(obj.schema as (typeof ACCEPTED_SCHEMAS)[number])) {
    return { ok: false, reason: "unsupported_schema" };
  }

  const tool = optionalText(obj.tool, 40);
  const descriptor = tool ? describeTool(tool) : null;
  if (!descriptor) return { ok: false, reason: "unknown_tool" };
  const adapter = optionalText(obj.adapter, 60);
  if (!adapter || !descriptor.acceptedAdapters.includes(adapter)) return { ok: false, reason: "unsupported_adapter" };
  if (obj.sourceType !== "native_otel") return { ok: false, reason: "unsupported_source" };
  const provider = optionalText(obj.provider, 40);
  if (provider !== descriptor.provider) return { ok: false, reason: "provider_mismatch" };

  const occurredAt = optionalText(obj.occurredAt, 40);
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) return { ok: false, reason: "bad_timestamp" };
  const localSessionId = optionalText(obj.localSessionId, 64);
  const localEventId = optionalText(obj.localEventId, 64);
  if (!localSessionId || !localEventId || !/^[A-Za-z0-9_-]+$/.test(localEventId)) {
    return { ok: false, reason: "bad_local_ids" };
  }

  const ints = {
    inputTokens: optionalInt(obj.inputTokens ?? null),
    outputTokens: optionalInt(obj.outputTokens ?? null),
    cacheReadTokens: optionalInt(obj.cacheReadTokens ?? null),
    cacheWriteTokens: optionalInt(obj.cacheWriteTokens ?? null),
    reasoningTokens: optionalInt(obj.reasoningTokens ?? null),
    toolTokens: optionalInt(obj.toolTokens ?? null),
    estimatedCostMicros: optionalInt(obj.estimatedCostMicros ?? null),
  };
  for (const [key, value] of Object.entries(ints)) {
    if (value === undefined) return { ok: false, reason: `bad_number:${key}` };
  }
  if (ints.inputTokens === null && ints.outputTokens === null) return { ok: false, reason: "no_usage" };

  const model = optionalText(obj.model ?? null, 128);
  if (model === undefined) return { ok: false, reason: "bad_model" };
  const upstreamRequestId = optionalText(obj.upstreamRequestId ?? null, TELEMETRY_LIMITS.maxRequestIdLength);
  if (upstreamRequestId === undefined) return { ok: false, reason: "bad_request_id" };
  // A tool whose telemetry cannot carry a provider id must not be able to
  // assert one. Codex claiming a request id is a client lying.
  if (upstreamRequestId && !descriptor.carriesUpstreamIdentity) return { ok: false, reason: "identity_not_expected" };

  const toolVersion = optionalText(obj.toolVersion ?? null, 40);
  if (toolVersion === undefined) return { ok: false, reason: "bad_tool_version" };

  let signature: { version: string; value: string } | null = null;
  if (item.signature !== undefined && item.signature !== null) {
    const sig = item.signature as { version?: unknown; value?: unknown };
    if (sig.version !== "device-sig-v1" || typeof sig.value !== "string" || sig.value.length > 200) {
      return { ok: false, reason: "bad_signature_shape" };
    }
    signature = { version: sig.version, value: sig.value };
  }

  return {
    ok: true,
    signature,
    observation: {
      schema: obj.schema as string,
      adapter,
      tool,
      toolVersion,
      sourceType: "native_otel",
      provider,
      model,
      upstreamRequestId,
      ...(ints as Required<typeof ints> & Record<keyof typeof ints, number | null>),
      occurredAt: new Date(occurredAt).toISOString(),
      localSessionId,
      localEventId,
    } as IncomingObservation,
  };
}

/** Must match the device's `canonicalObservation` byte for byte. */
export function canonicalObservation(observation: IncomingObservation): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(observation).sort()) {
    ordered[key] = observation[key as keyof IncomingObservation];
  }
  return JSON.stringify(ordered);
}

export function verifyDeviceSignature(
  publicKeyBase64: string,
  observation: IncomingObservation,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalObservation(observation), "utf8"), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** A joinable identity that does not reveal the id. Null without an id. */
export function providerIdentityHash(provider: string, upstreamRequestId: string | null): string | null {
  if (!upstreamRequestId) return null;
  return `sha256:${createHash("sha256").update(`${provider}\n${upstreamRequestId}`).digest("hex")}`;
}

/**
 * The level a freshly received observation starts at. Never higher than
 * device_attested: the two upper rungs require the server to find something
 * of its own.
 */
export function initialLevel(signatureVerified: boolean): VerificationLevel {
  return signatureVerified ? "device_attested" : "local_observed";
}

export interface CorrelationCandidate {
  eventId: string;
  verificationLevel: VerificationLevel | null;
  provenanceSources: readonly string[];
}

export interface CorrelationDecision {
  /** Update for the observation. */
  observation: { correlationStatus: "matched" | "unmatched" | "none"; level: VerificationLevel; correlatedEventId: string | null };
  /** Update for the trusted event, if any. NEVER touches reward fields. */
  event: { eventId: string; provenanceSources: string[]; correlationStatus: "matched" } | null;
}

/**
 * Exact correlation, or nothing.
 *
 * The observation's upstream request id either equals the identity USAGE
 * recorded for a routed/imported event, or it does not. There is no
 * "same token count and roughly the same minute" path -- that is how two
 * different requests get counted as one, or a fabricated one gets counted at
 * all. Weak matching is a crypto-economics bug waiting to be exploited, so it
 * is not written.
 *
 * On a match the OBSERVATION rises to provider_correlated and the EVENT gains
 * "local_telemetry" as a provenance source. The event's reward columns are not
 * in the returned update, by construction: this function cannot express a
 * change to them.
 */
export function correlate(
  observation: { upstreamRequestId: string | null; signatureVerified: boolean },
  candidate: CorrelationCandidate | null,
): CorrelationDecision {
  const base = initialLevel(observation.signatureVerified);
  if (!observation.upstreamRequestId) {
    return { observation: { correlationStatus: "none", level: base, correlatedEventId: null }, event: null };
  }
  if (!candidate) {
    // Left "unmatched", not "none": a trusted record may arrive later (a
    // provider import for the day), and a later pass can try again.
    return { observation: { correlationStatus: "unmatched", level: base, correlatedEventId: null }, event: null };
  }
  const sources = new Set(candidate.provenanceSources);
  sources.add("local_telemetry");
  return {
    observation: {
      correlationStatus: "matched",
      level: VERIFICATION_RANK.provider_correlated > VERIFICATION_RANK[base] ? "provider_correlated" : base,
      correlatedEventId: candidate.eventId,
    },
    event: { eventId: candidate.eventId, provenanceSources: [...sources].sort(), correlationStatus: "matched" },
  };
}
