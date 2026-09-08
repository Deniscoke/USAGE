import {
  listProviders,
  type ConnectionMethod,
  type MethodAvailability,
  type ProviderDefinition,
} from "@/lib/providers/catalog";

/**
 * What the product shows under "Connected AI".
 *
 * Every state here is derived from three facts -- what the registry declares,
 * what the user has connected, and whether they hold a live miner credential.
 * None of it is a hardcoded label, so adding a provider to the catalog makes it
 * appear correctly without touching a component.
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
  state: ConnectionState;
  note?: string;
  /** True when usage from this connection can earn. Never true for imports of reported data. */
  earns: boolean;
}

const STATE_FROM_AVAILABILITY: Partial<Record<MethodAvailability, ConnectionState>> = {
  coming_soon: "coming_soon",
  experimental: "experimental",
};

export interface DeriveConnectionsInput {
  connections: readonly StoredConnection[];
  /** A live, unrevoked miner credential exists for this user. */
  hasActiveMiner: boolean;
  /** Providers USAGE has actually observed usage from recently. */
  activeProviders: ReadonlySet<string>;
  providers?: readonly ProviderDefinition[];
}

/**
 * One row per provider-method the product can talk about.
 *
 * Methods the provider does not support at all are omitted rather than shown as
 * unavailable: a list of things that will never exist is noise, not a feature.
 */
export function deriveConnections(input: DeriveConnectionsInput): ConnectedTool[] {
  const providers = input.providers ?? listProviders();
  const stored = new Map(
    input.connections.map((connection) => [`${connection.provider}:${connection.method}`, connection]),
  );

  const rows: ConnectedTool[] = [];
  for (const provider of providers) {
    for (const [method, definition] of Object.entries(provider.methods) as [
      ConnectionMethod,
      ProviderDefinition["methods"][ConnectionMethod],
    ][]) {
      if (definition.availability === "unsupported") continue;

      const tool = provider.tools.find((entry) => entry.method === method);
      const connection = stored.get(`${provider.slug}:${method}`);
      const state = resolveState({
        availability: definition.availability,
        connection,
        method,
        hasActiveMiner: input.hasActiveMiner,
        isActiveProvider: input.activeProviders.has(provider.slug),
      });

      rows.push({
        key: `${provider.slug}:${method}`,
        providerSlug: provider.slug,
        providerName: provider.name,
        label: tool?.name ?? provider.name,
        method,
        state,
        note: definition.note,
        // Whether a connection *can* contribute. Whether a given request
        // actually earns is still decided per proof, by verification type,
        // proof status and pricing -- never by this flag.
        earns: state === "active",
      });
    }
  }
  return rows;
}

function resolveState(input: {
  availability: MethodAvailability;
  connection: StoredConnection | undefined;
  method: ConnectionMethod;
  hasActiveMiner: boolean;
  isActiveProvider: boolean;
}): ConnectionState {
  const declared = STATE_FROM_AVAILABILITY[input.availability];
  // A capability that does not exist cannot be in an error or active state,
  // whatever a stored row claims.
  if (declared) return declared;

  if (input.connection?.status === "error") return "error";
  if (input.connection?.status === "revoked") return "revoked";

  if (input.method === "routed_mining") {
    // Mining needs a credential AND traffic. A credential alone is set-up done
    // but nothing mined yet, which is a different thing to say.
    if (!input.hasActiveMiner) return "setup_required";
    return input.isActiveProvider ? "active" : "available";
  }

  return input.connection ? "active" : "available";
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
