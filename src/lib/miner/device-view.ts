import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  LocalUsageObservationRow,
  MinerDeviceRow,
  MinerToolMappingRow,
  UsageEventRow,
} from "@/lib/supabase/database.types";
import { LOCAL_TOOLS, VERIFICATION_COPY, type LocalToolDescriptor, type VerificationLevel } from "./tools";
import { summarizeUsage, type UsageSummary } from "./usage-summary";

/**
 * What the website shows about a paired device.
 *
 * Read as the signed-in user, so RLS is the access control: a device that is
 * not theirs is simply not in the result. Every number comes from
 * `summarizeUsage`, the same function the desktop window is served, so the
 * two surfaces cannot drift.
 */

export interface DeviceToolView {
  tool: LocalToolDescriptor;
  /** From the last heartbeat. */
  detected: boolean;
  version: string | null;
  mapped: boolean;
  mappingStatus: "enabled" | "disabled" | "never";
  meteringMethod: string | null;
  /** Ceiling from the registry; an individual event may be weaker. */
  verificationCapability: VerificationLevel;
  verificationLabel: string;
  /** Plain words for the reward column. */
  mining: "eligible_when_routed" | "held" | "not_eligible";
  lastEventAt: string | null;
}

export interface DeviceView {
  device: MinerDeviceRow;
  online: boolean;
  revoked: boolean;
  /**
   * A newer, live pairing exists for a device with this name. This row is a
   * previous pairing of (very probably) the same computer -- kept, never
   * deleted, and labelled so the owner can tell it from the current one.
   */
  previousPairing: boolean;
  attested: boolean;
  tools: DeviceToolView[];
  today: UsageSummary;
  lastUsageEventAt: string | null;
}

export function isOnline(lastSeenAt: string | null, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  return now - new Date(lastSeenAt).getTime() < 5 * 60 * 1000;
}

function miningWord(tool: LocalToolDescriptor): DeviceToolView["mining"] {
  if (tool.meteringMethods.includes("routed")) return "eligible_when_routed";
  if (tool.meteringMethods.includes("unsupported")) return "not_eligible";
  return "not_eligible";
}

export function buildDeviceView(input: {
  device: MinerDeviceRow;
  mappings: readonly MinerToolMappingRow[];
  observations: readonly LocalUsageObservationRow[];
  events: readonly UsageEventRow[];
  day: string;
  now?: number;
  /** Every device of the user, so the current pairing per name can be found. */
  siblings?: readonly MinerDeviceRow[];
}): DeviceView {
  const now = input.now ?? Date.now();
  const stateByTool = new Map(input.device.tool_state.map((t) => [t.tool, t] as const));
  const mappingByTool = new Map(input.mappings.map((m) => [m.tool_id, m] as const));

  const tools: DeviceToolView[] = Object.values(LOCAL_TOOLS).map((tool) => {
    const state = stateByTool.get(tool.id);
    const mapping = mappingByTool.get(tool.id);
    const mapped = mapping?.status === "enabled";
    return {
      tool,
      detected: state?.detected ?? input.device.enabled_tools.includes(tool.id),
      version: state?.version ?? mapping?.tool_version ?? null,
      mapped,
      mappingStatus: mapping ? mapping.status : "never",
      meteringMethod: mapping?.metering_method ?? null,
      verificationCapability: tool.verificationCapability,
      verificationLabel: VERIFICATION_COPY[tool.verificationCapability].label,
      mining: miningWord(tool),
      lastEventAt: mapping?.last_event_at ?? null,
    };
  });

  const deviceObservations = input.observations.filter((o) => o.device_id === input.device.id);

  const newerLive = (input.siblings ?? []).some(
    (other) =>
      other.id !== input.device.id &&
      other.name === input.device.name &&
      other.revoked_at === null &&
      new Date(other.created_at).getTime() > new Date(input.device.created_at).getTime(),
  );

  return {
    device: input.device,
    online: !input.device.revoked_at && isOnline(input.device.last_seen_at, now),
    revoked: input.device.revoked_at !== null,
    previousPairing: input.device.revoked_at === null && newerLive,
    attested: Boolean(input.device.public_key),
    tools,
    today: summarizeUsage({ day: input.day, observations: deviceObservations, events: input.events }),
    lastUsageEventAt: input.device.last_usage_event_at,
  };
}

/** Everything the /miners pages need, loaded as the user. */
export async function loadDeviceViews(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: { deviceId?: string } = {},
): Promise<DeviceView[]> {
  const day = new Date().toISOString().slice(0, 10);
  const since = `${day}T00:00:00Z`;

  let deviceQuery = supabase.from("miner_devices").select("*").eq("user_id", userId).order("created_at", { ascending: false });
  if (options.deviceId) deviceQuery = deviceQuery.eq("id", options.deviceId);

  const [{ data: devices }, { data: mappings }, { data: observations }, { data: events }] = await Promise.all([
    deviceQuery,
    supabase.from("miner_tool_mappings").select("*").eq("user_id", userId),
    supabase.from("local_usage_observations").select("*").eq("user_id", userId).gte("occurred_at", since),
    supabase.from("usage_events").select("*").eq("user_id", userId).gte("occurred_at", since),
  ]);

  const { data: allDevices } = options.deviceId
    ? await supabase.from("miner_devices").select("*").eq("user_id", userId)
    : { data: devices };

  return ((devices ?? []) as MinerDeviceRow[]).map((device) =>
    buildDeviceView({
      device,
      siblings: (allDevices ?? []) as MinerDeviceRow[],
      mappings: ((mappings ?? []) as MinerToolMappingRow[]).filter((m) => m.device_id === device.id),
      observations: (observations ?? []) as LocalUsageObservationRow[],
      events: (events ?? []) as UsageEventRow[],
      day,
    }),
  );
}
