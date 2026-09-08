import {
  isUsable,
  listProviders,
  type ConnectionMethod,
  type ProviderDefinition,
  type RouteStatus,
} from "@/lib/providers/catalog";

/**
 * What the product shows under "Connected AI".
 *
 * Every state is derived from three facts -- what the registry declares, what
 * the user has connected, and whether they hold a live miner credential. None
 * of it is a hardcoded label, so adding a provider or a gateway to the registry
 * makes it appear correctly without touching a component.
 *
 * Mining rows are per (provider, gateway), because "Claude" and "Claude via
 * OpenRouter" are genuinely different connections with different upstreams.
 */

export type ConnectionState =
  | "active"
  | "available"
  | "setup_required"
  | "coming_soon"
  | "experimental"
  | "error"
  | "revoked";

export interface StoredConnection {
  provider: string;
  method: ConnectionMethod;
  status: "active" | "error" | "revoked";
  lastSyncedAt: string | null;
}

export interface ConnectedTool {
  key: string;
  providerSlug: string;
  providerName: string;
  /** The name a person recognises, e.g. "Claude Code". */
  label: string;
  method: ConnectionMethod;
  /** Which gateway carries it, for mining rows. Null for imports and BYOK. */
  gateway: string | null;
  gatewayName: string | null;
  state: ConnectionState;
  note?: string;
  lastSyncedAt: string | null;
  /** True when this connection can contribute to mining right now. */
  earns: boolean;
}

export interface DeriveConnectionsInput {
  connections: readonly StoredConnection[];
  /** A live, unrevoked miner credential exists for this user. */
  hasActiveMiner: boolean;
  /** Providers USAGE has actually observed usage from recently. */
  activeProviders: ReadonlySet<string>;
  /** Gateways USAGE has actually observed usage through recently. */
  activeGateways?: ReadonlySet<string>;
  providers?: readonly ProviderDefinition[];
}

/**
 * One row per thing the product can talk about.
 *
 * Capabilities a provider does not support at all are omitted rather than
 * listed as unavailable: a list of things that will never exist is noise.
 */
export function deriveConnections(input: DeriveConnectionsInput): ConnectedTool[] {
  const providers = input.providers ?? listProviders();
  const activeGateways = input.activeGateways ?? new Set<string>();
  const stored = new Map(
    input.connections.map((connection) => [
      `${connection.provider}:${connection.method}`,
      connection,
    ]),
  );

  const rows: ConnectedTool[] = [];

  for (const provider of providers) {
    const connection = stored.get(`${provider.slug}:routed_mining`);
    const miningTool = provider.tools.find((tool) => tool.method === "routed_mining");

    for (const route of provider.routes) {
      const state = resolveRouteState({
        status: route.status,
        connection,
        hasActiveMiner: input.hasActiveMiner,
        // Active means this provider's traffic was seen through this gateway.
        isActive:
          input.activeProviders.has(provider.slug) && activeGateways.has(route.gateway),
      });

      rows.push({
        key: `${provider.slug}:routed_mining:${route.gateway}`,
        providerSlug: provider.slug,
        providerName: provider.name,
        label: miningTool?.name ?? provider.name,
        method: "routed_mining",
        gateway: route.gateway,
        gatewayName: route.gatewayName,
        state,
        note: route.note,
        lastSyncedAt: connection?.lastSyncedAt ?? null,
        earns: state === "active",
      });
    }

    const importConnection = stored.get(`${provider.slug}:verified_import`);
    if (provider.import.status !== "unsupported") {
      const state = resolveSimpleState(provider.import.status, importConnection);
      rows.push({
        key: `${provider.slug}:verified_import`,
        providerSlug: provider.slug,
        providerName: provider.name,
        label:
          provider.tools.find((tool) => tool.method === "verified_import")?.name ??
          `${provider.name} organization`,
        method: "verified_import",
        gateway: null,
        gatewayName: null,
        state,
        note: provider.import.note,
        lastSyncedAt: importConnection?.lastSyncedAt ?? null,
        earns: state === "active",
      });
    }

    for (const method of ["byok", "subscription"] as const) {
      const definition = provider[method];
      if (definition.availability === "unsupported") continue;
      const methodConnection = stored.get(`${provider.slug}:${method}`);
      const state: ConnectionState =
        definition.availability === "available"
          ? methodConnection
            ? "active"
            : "available"
          : definition.availability === "experimental"
            ? "experimental"
            : "coming_soon";

      rows.push({
        key: `${provider.slug}:${method}`,
        providerSlug: provider.slug,
        providerName: provider.name,
        label: provider.name,
        method,
        gateway: null,
        gatewayName: null,
        state,
        note: definition.note,
        lastSyncedAt: methodConnection?.lastSyncedAt ?? null,
        earns: false,
      });
    }
  }

  return rows;
}

function resolveRouteState(input: {
  status: RouteStatus;
  connection: StoredConnection | undefined;
  hasActiveMiner: boolean;
  isActive: boolean;
}): ConnectionState {
  // A capability that does not exist cannot be in an error or active state,
  // whatever a stored row claims.
  if (!isUsable(input.status)) return "coming_soon";

  if (input.connection?.status === "error") return "error";
  if (input.connection?.status === "revoked") return "revoked";

  // Mining needs a credential AND traffic. A credential alone is set-up done
  // but nothing mined yet, which is a different thing to say.
  if (!input.hasActiveMiner) return "setup_required";
  return input.isActive ? "active" : "available";
}

function resolveSimpleState(
  status: RouteStatus,
  connection: StoredConnection | undefined,
): ConnectionState {
  if (!isUsable(status)) return "coming_soon";
  if (connection?.status === "error") return "error";
  if (connection?.status === "revoked") return "revoked";
  return connection ? "active" : "setup_required";
}

/** Compact copy for a state badge. Product vocabulary, not internal vocabulary. */
export const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  active: "MINING",
  available: "READY",
  setup_required: "CONNECT",
  coming_soon: "SOON",
  experimental: "EXPERIMENTAL",
  error: "ERROR",
  revoked: "REVOKED",
};
