import {
  resolveTrustEnvironment,
  type GatewayObservation,
  type GatewayTokenUsage,
  type ObservationEnvironment,
} from "./observation";

/**
 * Real-mode gateway probe: makes ONE small AI request through the Vercel AI
 * Gateway and captures what USAGE observed.
 *
 * This is deliberately not a chat feature. Its only job is to prove that a real
 * request produces trustworthy routed evidence.
 *
 * Cost: a real request spends real credits, so nothing here runs implicitly --
 * see scripts/gateway-probe.ts for the confirmation gate.
 */

export type GatewayFailureKind =
  | "not_configured"
  | "authentication"
  | "budget_exceeded"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "network"
  | "malformed_metadata"
  | "unknown";

export interface GatewayFailure {
  kind: GatewayFailureKind;
  statusCode?: number;
  message: string;
}

export type GatewayProbeResult =
  | { ok: true; observation: GatewayObservation }
  | { ok: false; failure: GatewayFailure };

/**
 * Map a transport/provider error onto an operational failure.
 *
 * Every branch here ends in "no usage event". A failed request produced no
 * trustworthy evidence that billable usage occurred, and guessing would be
 * inventing economic value.
 */
export function classifyGatewayFailure(error: unknown): GatewayFailure {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = readStatusCode(error);

  if (statusCode === 401 || statusCode === 403) {
    return { kind: "authentication", statusCode, message };
  }
  if (statusCode === 402) return { kind: "budget_exceeded", statusCode, message };
  if (statusCode === 429) return { kind: "rate_limited", statusCode, message };
  if (statusCode !== undefined && statusCode >= 500) {
    return { kind: "provider_unavailable", statusCode, message };
  }

  const lowered = message.toLowerCase();
  if (lowered.includes("timeout") || lowered.includes("timed out") || isAbortError(error)) {
    return { kind: "timeout", statusCode, message };
  }
  if (
    lowered.includes("fetch failed") ||
    lowered.includes("econnrefused") ||
    lowered.includes("enotfound") ||
    lowered.includes("network")
  ) {
    return { kind: "network", statusCode, message };
  }

  return { kind: "unknown", statusCode, message };
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { statusCode?: unknown; status?: unknown };
  const value = candidate.statusCode ?? candidate.status;
  return typeof value === "number" ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export interface GatewayProbeOptions {
  model: string;
  /** Kept trivial on purpose: this probe measures plumbing, not model quality. */
  prompt?: string;
  maxOutputTokens?: number;
  now?: () => Date;
}

/** Server-side only: reads the gateway credential from the environment. */
export function gatewayCredentialPresent(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}

interface AiSdkResult {
  usage?: GatewayTokenUsage;
  providerMetadata?: Record<string, Record<string, unknown> | undefined>;
  response?: { id?: string; modelId?: string; timestamp?: Date };
  finishReason?: string;
}

/**
 * Convert an AI SDK result into a trusted observation.
 *
 * Only usage metadata is read. The generated text is never touched, never
 * returned and never logged: USAGE is a compute ledger, not a transcript store.
 */
export function observationFromAiSdkResult(
  result: AiSdkResult,
  context: {
    model: string;
    startedAt: Date;
    finishedAt: Date;
    environment?: ObservationEnvironment;
    clientType?: string;
  },
): GatewayObservation {
  const gateway = (result.providerMetadata?.gateway ?? {}) as {
    generationId?: unknown;
    cost?: unknown;
    routing?: { resolvedProvider?: unknown };
  };

  const generationId =
    typeof gateway.generationId === "string" ? gateway.generationId : (result.response?.id ?? "");

  const cost =
    typeof gateway.cost === "string" || typeof gateway.cost === "number"
      ? { value: gateway.cost, currency: "USD" }
      : null;

  const resolvedProvider = gateway.routing?.resolvedProvider;

  return {
    // Trust comes from where this ran, never from the response.
    environment: context.environment ?? resolveTrustEnvironment(),
    clientType: context.clientType ?? "probe",
    generationIdSource:
      typeof gateway.generationId === "string" ? "gateway_generation_id" : "response_id",
    generationId,
    model: result.response?.modelId || context.model,
    servedByProvider:
      typeof resolvedProvider === "string" ? resolvedProvider : context.model.split("/")[0],
    occurredAt: (result.response?.timestamp ?? context.finishedAt).toISOString(),
    usage: result.usage ?? {},
    cost,
    finishReason: result.finishReason,
    latencyMs: context.finishedAt.getTime() - context.startedAt.getTime(),
  };
}

/**
 * Make one real gateway request. Never called automatically.
 */
export async function runGatewayProbe(options: GatewayProbeOptions): Promise<GatewayProbeResult> {
  if (!gatewayCredentialPresent()) {
    return {
      ok: false,
      failure: {
        kind: "not_configured",
        message: "Neither AI_GATEWAY_API_KEY nor VERCEL_OIDC_TOKEN is set on the server.",
      },
    };
  }

  const startedAt = new Date();
  try {
    // Imported lazily so the AI SDK never enters the app bundle or the test run.
    const { generateText } = await import("ai");
    const result = await generateText({
      model: options.model,
      prompt: options.prompt ?? "Reply with the single word: ok",
      maxOutputTokens: options.maxOutputTokens ?? 16,
      // No automatic retries: a probe must make exactly one attempt, so a
      // failure is reported rather than quietly multiplied into more spend.
      maxRetries: 0,
    });

    return {
      ok: true,
      observation: observationFromAiSdkResult(result as AiSdkResult, {
        model: options.model,
        startedAt,
        finishedAt: new Date(),
        clientType: "probe",
      }),
    };
  } catch (error) {
    return { ok: false, failure: classifyGatewayFailure(error) };
  }
}

/**
 * Resolve a model without hardcoding one that may be retired.
 * Prefers an explicit override, otherwise asks the gateway what exists.
 */
export async function resolveProbeModel(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();

  const { gateway } = await import("ai");
  const available = await gateway.getAvailableModels();
  const languageModels = available.models.filter((model) => model.modelType === "language");
  if (languageModels.length === 0) {
    throw new Error("AI Gateway returned no language models.");
  }

  // Cheapest input price wins; ties broken by id so the choice is deterministic.
  const priced = languageModels
    .map((model) => ({
      id: model.id,
      input: Number(model.pricing?.input ?? Number.POSITIVE_INFINITY),
    }))
    .sort((a, b) => a.input - b.input || a.id.localeCompare(b.id));

  return priced[0].id;
}
