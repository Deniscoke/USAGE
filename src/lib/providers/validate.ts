import { safeFetch } from "@/lib/net/ssrf";
import { UNKNOWN_CAPABILITIES, type DiscoveredModel, type ProtocolCapabilities } from "@/lib/protocols/protocol";
import { authHeaders, type ProviderConnectionProfile } from "./profiles";

/**
 * Validate a credential against a provider profile, without generating.
 *
 * Three verdicts, and the difference between them is the whole point:
 *
 *   accepted      the documented probe answered 2xx with the credential.
 *   rejected      the documented probe on the documented host said 401 (or
 *                 403 on an endpoint that does list models). This is the ONLY
 *                 case that may be shown as "credential rejected".
 *   inconclusive  everything else: no model list, wrong-looking endpoint,
 *                 rate limit, timeout, malformed body, a 403 from a host that
 *                 is not the provider's API. The credential MAY be fine; the
 *                 connection is saved and the user is told validation is
 *                 incomplete, never that their key is wrong.
 *
 * A model list proves two things -- the credential authenticated and which
 * models exist -- and nothing about generations. Generation-time capabilities
 * are taken from the profile's documentation, and for a custom endpoint stay
 * unknown until a request is observed.
 */

export type ValidationFailure =
  | "invalid_credentials"
  | "forbidden"
  | "wrong_endpoint"
  | "no_model_list"
  | "unreachable"
  | "rate_limited"
  | "malformed"
  | "unknown";

export interface ValidationResult {
  verdict: "accepted" | "rejected" | "inconclusive";
  failure: ValidationFailure | null;
  /** Safe to show. Never an upstream body, never a credential. */
  message: string;
  capabilities: ProtocolCapabilities;
  models: DiscoveredModel[];
  /** What the provider's account surface said, when the probe was a key endpoint. */
  accountContext: Record<string, unknown> | null;
  /** The URL that was probed, host and path only, for the report. */
  probed: string;
}

export interface ValidateInput {
  profile: ProviderConnectionProfile;
  baseUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  allowInsecure?: boolean;
  timeoutMs?: number;
}

function documentedCapabilities(profile: ProviderConnectionProfile, authenticated: boolean, models: boolean): ProtocolCapabilities {
  return { ...UNKNOWN_CAPABILITIES, ...profile.documented, authenticated, models };
}

function safeUrlLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

async function fetchWithProfile(input: ValidateInput, url: string): Promise<{ response: Response } | { error: "unreachable" | "timeout"; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  try {
    const response = await safeFetch(
      url,
      { headers: authHeaders(input.profile, input.credential), cache: "no-store", signal: controller.signal },
      { fetchImpl: input.fetchImpl, resolve: input.resolve, allowInsecure: input.allowInsecure },
    );
    return { response };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { error: "timeout", message: "The provider did not answer in time." };
    return {
      error: "unreachable",
      message: error instanceof Error && error.name === "SsrfError" ? error.message : "USAGE could not reach that endpoint.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseModels(payload: unknown): DiscoveredModel[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data
    .filter((entry): entry is { id: string; display_name?: unknown; name?: unknown } => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string")
    .map((entry) => ({
      upstreamModelId: entry.id,
      displayName: typeof entry.display_name === "string" ? entry.display_name : typeof entry.name === "string" ? entry.name : undefined,
    }));
}

export async function validateConnection(input: ValidateInput): Promise<ValidationResult> {
  const { profile } = input;
  const base = input.baseUrl.replace(/\/+$/, "");
  const known = profile.family !== "custom";
  const noModels = (): ProtocolCapabilities => documentedCapabilities(profile, false, false);

  // --- 1. the credential probe
  const probePath = profile.validation.kind === "key_info" ? profile.validation.path : profile.modelsPath;
  const probeUrl = `${base}${probePath}`;
  const probed = safeUrlLabel(probeUrl);
  const first = await fetchWithProfile(input, probeUrl);
  if ("error" in first) {
    return {
      verdict: "inconclusive",
      failure: "unreachable",
      message: first.message,
      capabilities: noModels(),
      models: [],
      accountContext: null,
      probed,
    };
  }
  const response = first.response;

  if (response.status === 401) {
    return {
      verdict: "rejected",
      failure: "invalid_credentials",
      message: `${profile.displayName === "Custom" ? "The endpoint" : profile.displayName} rejected the API key (401).`,
      capabilities: noModels(),
      models: [],
      accountContext: null,
      probed,
    };
  }
  if (response.status === 403) {
    // On the provider's real API a 403 is an authenticated key without
    // permission or billing -- a conclusive answer about THIS key. On any
    // other host it is most likely an edge/WAF answering for a wrong URL.
    return known
      ? {
          verdict: "rejected",
          failure: "forbidden",
          message: `${profile.displayName} recognised the key but refused it (403): check the key's permissions or billing.`,
          capabilities: noModels(),
          models: [],
          accountContext: null,
          probed,
        }
      : {
          verdict: "inconclusive",
          failure: "wrong_endpoint",
          message: "That address answered 403 before reaching an API. Check the base URL — it should be the provider's API host, not its website.",
          capabilities: noModels(),
          models: [],
          accountContext: null,
          probed,
        };
  }
  if (response.status === 429) {
    return { verdict: "inconclusive", failure: "rate_limited", message: "The provider is rate limiting; the key was saved and will be checked again.", capabilities: noModels(), models: [], accountContext: null, probed };
  }
  if (response.status === 404 || response.status === 405) {
    return {
      verdict: "inconclusive",
      failure: known ? "wrong_endpoint" : "no_model_list",
      message: known
        ? `${profile.displayName} answered ${response.status} at its documented endpoint; USAGE could not confirm the key.`
        : "That endpoint has no model list at the documented path. The key was saved; USAGE will confirm it on the first request.",
      capabilities: noModels(),
      models: [],
      accountContext: null,
      probed,
    };
  }
  if (!response.ok) {
    return { verdict: "inconclusive", failure: "unknown", message: `The provider answered ${response.status}; USAGE could not confirm the key.`, capabilities: noModels(), models: [], accountContext: null, probed };
  }

  // --- 2. the body: models, or account context
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { verdict: "inconclusive", failure: "malformed", message: "The endpoint answered, but not with JSON USAGE understands.", capabilities: noModels(), models: [], accountContext: null, probed };
  }

  if (profile.validation.kind === "key_info") {
    const data = (payload as { data?: unknown })?.data;
    const accountContext = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
    // The key authenticated. Models come from the public list, when there is one.
    let models: DiscoveredModel[] = [];
    if (profile.validation.modelsPublic) {
      const list = await fetchWithProfile(input, `${base}${profile.modelsPath}`);
      if (!("error" in list) && list.response.ok) {
        try {
          models = parseModels(await list.response.json()) ?? [];
        } catch {
          models = [];
        }
      }
    }
    return {
      verdict: "accepted",
      failure: null,
      message: `Connected to ${profile.displayName}. ${models.length} model${models.length === 1 ? "" : "s"} available.`,
      capabilities: documentedCapabilities(profile, true, models.length > 0),
      models,
      accountContext,
      probed,
    };
  }

  const models = parseModels(payload);
  if (models === null) {
    return { verdict: "inconclusive", failure: "malformed", message: "The endpoint answered, but not with a model list USAGE understands. The key was saved.", capabilities: noModels(), models: [], accountContext: null, probed };
  }
  return {
    verdict: "accepted",
    failure: null,
    message: `Connected. ${models.length} model${models.length === 1 ? "" : "s"} discovered.`,
    capabilities: documentedCapabilities(profile, true, models.length > 0),
    models,
    accountContext: null,
    probed,
  };
}

/**
 * What a validation verdict means for the connection being created.
 *
 *   rejected     nothing is stored; the form shows the reason and keeps the
 *                user's other fields
 *   unreachable  nothing is stored either: the provider could not be asked,
 *                and a key that was never checked should not sit in a row
 *                labelled anything
 *   inconclusive stored as `validating` -- "credential saved, validation
 *                incomplete" -- never as invalid
 *   accepted     stored with the status the capabilities and pricing imply
 */
export function decideCreateOutcome(validation: ValidationResult):
  | { store: false; error: "credential_rejected" | "unreachable"; message: string }
  | { store: true; provisionalStatus: "validating" | null; ok: boolean } {
  if (validation.verdict === "rejected") return { store: false, error: "credential_rejected", message: validation.message };
  if (validation.failure === "unreachable") return { store: false, error: "unreachable", message: validation.message };
  if (validation.verdict === "inconclusive") return { store: true, provisionalStatus: "validating", ok: false };
  return { store: true, provisionalStatus: null, ok: true };
}
