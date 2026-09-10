/**
 * What the platform knows about each local tool.
 *
 * This is the SERVER's registry, and it is the only place a mapping's
 * metering method and verification ceiling come from. The miner declares the
 * same facts for display, but a device that claims "I am routed and
 * provider-correlated" for a tool this table says is analytics-only is simply
 * ignored: the row is written from here.
 *
 * Verification ladder (rung order matters; each is strictly stronger):
 *
 *   local_observed            the miner saw telemetry. Analytics. Reward 0.
 *   device_attested           ...and signed it with a registered device key.
 *                             Proves origin, not truth. Reward 0.
 *   provider_correlated       the observation's upstream request id matched a
 *                             record USAGE itself trusts. Provenance of THAT
 *                             record improves; nothing new is rewarded.
 *   routed_confirmed          USAGE's gateway carried the request. Existing.
 *   provider_verified_import  a provider's own usage API. Existing.
 *
 * Nothing below the third rung has an economic value, and nothing at or above
 * it is reachable from a device upload alone.
 */

export type VerificationLevel =
  | "local_observed"
  | "device_attested"
  | "provider_correlated"
  | "routed_confirmed"
  | "provider_verified_import";

export type MeteringMethod = "native_otel" | "routed" | "provider_import" | "local_observed" | "unsupported";

export const VERIFICATION_RANK: Record<VerificationLevel, number> = {
  local_observed: 0,
  device_attested: 1,
  provider_correlated: 2,
  routed_confirmed: 3,
  provider_verified_import: 4,
};

export interface LocalToolDescriptor {
  id: string;
  displayName: string;
  provider: string;
  meteringMethods: readonly MeteringMethod[];
  /** Ceiling on what this tool's own telemetry can reach. */
  verificationCapability: VerificationLevel;
  /** Whether its telemetry carries a provider request identity worth correlating. */
  carriesUpstreamIdentity: boolean;
  experimental: boolean;
  reads: readonly string[];
  neverReads: readonly string[];
  availabilityNote: string | null;
  /** Adapter versions this server accepts. Anything else is rejected cleanly. */
  acceptedAdapters: readonly string[];
}

export const LOCAL_TOOLS: Record<string, LocalToolDescriptor> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    provider: "anthropic",
    meteringMethods: ["native_otel", "routed"],
    verificationCapability: "provider_correlated",
    carriesUpstreamIdentity: true,
    experimental: false,
    reads: ["Model", "Token counts (input, output, cache read, cache write)", "Request ID", "Cost estimate", "Timing"],
    neverReads: ["Prompts", "Responses", "Tool arguments", "File paths", "Source code", "Your email or account id"],
    availabilityNote: null,
    acceptedAdapters: ["claude-otel-adapter-v1"],
  },
  "gemini-cli": {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    provider: "google",
    meteringMethods: ["native_otel"],
    verificationCapability: "device_attested",
    carriesUpstreamIdentity: false,
    experimental: false,
    reads: ["Model", "Token counts (input, output, cached, thinking, tool)", "Timing"],
    neverReads: ["Prompts", "Responses", "Tool arguments", "File paths", "Source code", "Your email"],
    availabilityNote: "Telemetry carries no request id, so usage is tracked but cannot be verified.",
    acceptedAdapters: ["gemini-otel-adapter-v1"],
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    provider: "openai",
    meteringMethods: ["native_otel", "routed"],
    verificationCapability: "device_attested",
    carriesUpstreamIdentity: false,
    experimental: true,
    reads: ["Model", "Token counts (input, output, cached, cache write, reasoning)", "Timing"],
    neverReads: ["Prompts", "Responses", "Tool arguments and output", "File paths", "Source code"],
    availabilityNote:
      "Codex telemetry reports the model and token counts but no request id, so usage is tracked but cannot be correlated or verified.",
    acceptedAdapters: ["codex-otel-adapter-v1"],
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    provider: "cursor",
    meteringMethods: ["unsupported"],
    verificationCapability: "local_observed",
    carriesUpstreamIdentity: false,
    experimental: false,
    reads: [],
    neverReads: ["Anything: detected, not read"],
    availabilityNote:
      "Cursor exports usage only on the Enterprise plan, server-side, via a team admin. No local surface exists for personal accounts.",
    acceptedAdapters: [],
  },
};

export function describeTool(id: string): LocalToolDescriptor | null {
  return LOCAL_TOOLS[id] ?? null;
}

/** The metering method the server will record for a mapping. */
export function meteringMethodFor(tool: LocalToolDescriptor): MeteringMethod {
  return tool.meteringMethods.includes("native_otel") ? "native_otel" : tool.meteringMethods[0] ?? "unsupported";
}

export const VERIFICATION_COPY: Record<VerificationLevel, { label: string; short: string }> = {
  local_observed: { label: "Tracked", short: "reported by your device" },
  device_attested: { label: "Tracked", short: "signed by your device" },
  provider_correlated: { label: "Verified", short: "matched a record USAGE trusts" },
  routed_confirmed: { label: "Routed", short: "carried by USAGE's gateway" },
  provider_verified_import: { label: "Verified", short: "from the provider's own records" },
};
