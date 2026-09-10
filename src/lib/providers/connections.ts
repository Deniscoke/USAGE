import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSafeUrl } from "@/lib/net/ssrf";
import { resolveSecretStore, storeForBackend } from "@/lib/secrets/store";
import { getProtocol } from "@/lib/protocols/registry";
import {
  deriveMiningEligibility,
  UNKNOWN_CAPABILITIES,
  type MiningEligibility,
  type ProtocolCapabilities,
  type ProviderProtocol,
  type ProviderProtocolId,
} from "@/lib/protocols/protocol";
import { findModelPrice, CURRENT_PRICING_VERSION } from "@/lib/pricing/compute";
import { customProfile, isRecognisedEndpoint, profileForFamily, profileForUrl, resolveBaseUrl, type ProviderConnectionProfile } from "./profiles";
import { validateConnection, type ValidationResult } from "./validate";
import { deriveProviderStatusView, type ProviderStatusView } from "./status-view";
import type {
  ConnectionStatusDetailRow,
  Database,
  ProviderConnectionRow,
  ProviderDefinitionRow,
  ProviderModelRow,
} from "@/lib/supabase/database.types";

/**
 * Provider connections: creating them, validating them, and resolving one for
 * a request.
 *
 * THE SECURITY SHAPE. A miner request names a connection ID, never a URL. The
 * server looks the connection up, checks it belongs to the authenticated user
 * and is not revoked, re-validates the stored base URL against the SSRF guard,
 * and decrypts the credential in memory for that one call. A client can
 * therefore choose *which of its own approved connections* to use, and nothing
 * else -- it cannot point USAGE at an arbitrary address on any request.
 *
 * The credential never leaves this module in plaintext except into the outbound
 * request. It is not returned, not logged, not put in a receipt.
 */

export type ConnectionStatus = ConnectionStatusDetailRow;

export interface CreateConnectionInput {
  userId: string;
  displayName: string;
  protocol: ProviderProtocolId;
  baseUrl: string;
  credential: string;
  /** Reuse an official definition, or create a user-owned custom one. */
  definitionId?: string | null;
  providerFamily?: string | null;
  /** How the credential was obtained. OAuth means the user never saw a key. */
  authMethod?: "api_key" | "oauth";
  fetchImpl?: typeof fetch;
}

export interface ConnectionSummaryView {
  id: string;
  displayName: string;
  definitionId: string | null;
  protocol: ProviderProtocolId | null;
  baseUrlHost: string | null;
  status: ConnectionStatus;
  miningEligibility: MiningEligibility;
  capabilities: ProtocolCapabilities;
  origin: ProviderDefinitionRow["origin"] | null;
  authMethod: "api_key" | "oauth";
  modelCount: number;
  pricedModelCount: number;
  validatedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  revokedAt: string | null;
  /** Registry family / provider slug the connection was made for. */
  provider: string;
  /** The six separate facts every surface shows. Server-derived, never guessed by UI. */
  view: ProviderStatusView;
}

export class ConnectionError extends Error {
  constructor(
    readonly code:
      | "unknown_protocol"
      | "unsafe_url"
      | "probe_failed"
      | "credential_rejected"
      | "unreachable"
      | "not_found"
      | "revoked"
      | "no_credential"
      | "not_routable",
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "custom-provider"
  );
}

/**
 * Map a discovered upstream model onto an approved protocol price, if one
 * exists.
 *
 * DELIBERATELY CONSERVATIVE: only an exact match against the current pricing
 * snapshot counts. A user cannot supply a mapping, and a near-miss is not
 * guessed -- a custom provider that could claim its model is really `gpt-5.4`
 * would be claiming that model's price.
 */
export function resolveProtocolModelKey(
  providerFamily: string | null,
  upstreamModelId: string,
): string | null {
  const candidates = [
    upstreamModelId,
    providerFamily ? `${providerFamily}/${upstreamModelId}` : null,
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (findModelPrice(CURRENT_PRICING_VERSION, candidate)) return candidate;
  }
  return null;
}

/** Derive the status a connection should show, from what was actually observed. */
export function deriveConnectionStatus(input: {
  ok: boolean;
  failure?: string;
  capabilities: ProtocolCapabilities;
  eligibility: MiningEligibility;
}): ConnectionStatus {
  if (!input.ok) {
    if (input.failure === "invalid_credentials" || input.failure === "forbidden") {
      return "invalid_credentials";
    }
    return "error";
  }
  if (!input.capabilities.usage) return "unsupported_usage";
  if (input.eligibility === "pending_pricing") return "pending_pricing";
  if (input.eligibility === "analytics_only") return "limited";
  return "active";
}

export function createConnectionStore(admin: SupabaseClient<Database>) {
  function fail(context: string, error: { message: string } | null): void {
    if (error) throw new Error(`${context}: ${error.message}`);
  }

  return {
    /**
     * Create and validate a connection in one step.
     *
     * Validation happens BEFORE anything is stored as usable: the URL is
     * checked against the SSRF guard, the credential is probed, and the result
     * decides the status. A connection that never worked is recorded as broken
     * rather than quietly offered as working.
     */
    async create(input: CreateConnectionInput): Promise<{ connectionId: string; status: ConnectionStatus; eligibility: MiningEligibility; message: string; validation: ValidationResult }> {
      const protocol = getProtocol(input.protocol);
      if (!protocol) {
        // usage_import and custom_unsupported are real answers, but they are
        // not something USAGE can route, and it will not pretend otherwise.
        throw new ConnectionError(
          "not_routable",
          "USAGE cannot route that protocol yet. Your provider is recorded, but nothing will be mined.",
        );
      }
      if (protocol.id !== "openai_compatible" && protocol.id !== "anthropic_compatible") {
        throw new ConnectionError("not_routable", "USAGE cannot route that protocol yet.");
      }

      // PROVIDER != PROTOCOL. A known provider gets its server-controlled
      // profile (fixed API host, documented auth header, documented probe);
      // anything else is a custom endpoint with the protocol's generic shape.
      // A typed URL whose host belongs to a known provider is treated as that
      // provider, so `https://openai.com` becomes OpenAI's real API rather
      // than a 403 from a website.
      const profile: ProviderConnectionProfile =
        profileForFamily(input.providerFamily) ??
        profileForUrl(input.baseUrl) ??
        customProfile(protocol.id, input.baseUrl);
      if (profile.family !== "custom" && profile.protocol !== protocol.id) {
        throw new ConnectionError("unknown_protocol", `${profile.displayName} speaks ${profile.protocol.replace("_", "-")}; choose that protocol.`);
      }
      const baseUrl = resolveBaseUrl(profile, input.baseUrl);
      // Throws SsrfError, which the caller surfaces as a user-safe message.
      await assertSafeUrl(`${baseUrl}${profile.modelsPath}`);

      const validation = await validateConnection({
        profile,
        baseUrl,
        credential: input.credential,
        fetchImpl: input.fetchImpl,
      });

      // A conclusive rejection stores nothing: the user corrects the same
      // form. Only an accepted or INCONCLUSIVE result is worth keeping, and an
      // inconclusive one is labelled as such rather than as a bad key.
      if (validation.verdict === "rejected") {
        throw new ConnectionError("credential_rejected", validation.message);
      }
      if (validation.failure === "unreachable") {
        throw new ConnectionError("unreachable", validation.message);
      }
      const probe = {
        ok: validation.verdict === "accepted",
        capabilities: validation.capabilities,
        models: validation.models,
        failure: validation.failure ?? undefined,
        message: validation.message,
      };

      // The credential goes straight into the secret store -- Vault in
      // production, application AES elsewhere -- and this module never learns
      // which.
      const secretStore = await resolveSecretStore(admin);
      const secret = await secretStore.create({
        userId: input.userId,
        secret: input.credential,
        label: `${input.displayName} API key`,
      });

      const providerFamily = profile.family === "custom" ? (input.providerFamily ?? null) : profile.family;
      const definitionId =
        input.definitionId ??
        (await this.createCustomDefinition({
          userId: input.userId,
          displayName: input.displayName,
          protocol: input.protocol,
          baseUrl,
          providerFamily,
          capabilities: probe.capabilities,
          authMethod: input.authMethod,
        }));

      const models = await this.recordModels(definitionId, providerFamily, probe.models);
      const eligibility = deriveMiningEligibility({
        routable: protocol.routable,
        capabilities: probe.capabilities,
        hasPricedModel: models.priced > 0,
      });
      // Inconclusive is its own state: saved, not proven, not "invalid".
      const status: ConnectionStatus = probe.ok
        ? deriveConnectionStatus({ ok: true, capabilities: probe.capabilities, eligibility })
        : "validating";

      const { data: connection, error } = await admin
        .from("provider_connections")
        .insert({
          user_id: input.userId,
          provider: slugify(input.displayName),
          account_label: input.displayName,
          method: "byok",
          auth_method: input.authMethod ?? "api_key",
          status: probe.ok ? "active" : "error",
          definition_id: definitionId,
          protocol: input.protocol,
          base_url: baseUrl,
          secret_id: secret.id,
          connection_status: status,
          capabilities: probe.capabilities as unknown as Record<string, boolean>,
          mining_eligibility: eligibility,
          validated_at: probe.ok ? new Date().toISOString() : null,
          last_error_code: probe.ok ? null : (probe.failure ?? "error"),
          // What the provider's account surface said (OpenRouter: is_free_tier).
          // Funding evidence for the economic policy; never a credential.
          account_context: validation.accountContext,
        })
        .select("id")
        .single();
      fail("createConnection", error);
      if (!connection) throw new Error("createConnection: no row returned");

      return {
        connectionId: connection.id,
        status,
        eligibility,
        message: probe.message ?? "Connection recorded.",
        validation,
      };
    },

    /**
     * Re-check an existing connection with its STORED credential.
     *
     * For a connection created before provider profiles existed, or one whose
     * validation was inconclusive. The owner may name the provider family
     * (e.g. "openai") so the fixed API host replaces a mistyped one; the
     * credential itself is read server-side and never returned.
     */
    async revalidate(
      connectionId: string,
      userId: string,
      options: { providerFamily?: string | null; fetchImpl?: typeof fetch } = {},
    ): Promise<{ status: ConnectionStatus; eligibility: MiningEligibility; validation: ValidationResult; baseUrl: string }> {
      const resolved = await this.resolveForRequest(connectionId, userId);
      const protocol = resolved.protocol;
      if (protocol.id !== "openai_compatible" && protocol.id !== "anthropic_compatible") {
        throw new ConnectionError("not_routable", "That connection cannot be validated.");
      }
      const { data: definition } = await admin
        .from("provider_definitions")
        .select("id, provider_family, default_base_url, owner_user_id")
        .eq("id", resolved.connection.definition_id ?? "")
        .maybeSingle();
      const profile =
        profileForFamily(options.providerFamily ?? definition?.provider_family) ??
        profileForUrl(resolved.baseUrl) ??
        customProfile(protocol.id, resolved.baseUrl);
      if (profile.family !== "custom" && profile.protocol !== protocol.id) {
        throw new ConnectionError("unknown_protocol", `${profile.displayName} speaks ${profile.protocol.replace("_", "-")}.`);
      }
      const baseUrl = resolveBaseUrl(profile, resolved.baseUrl);
      await assertSafeUrl(`${baseUrl}${profile.modelsPath}`);

      const validation = await validateConnection({ profile, baseUrl, credential: resolved.credential, fetchImpl: options.fetchImpl });
      const providerFamily = profile.family === "custom" ? (definition?.provider_family ?? null) : profile.family;
      const models = definition ? await this.recordModels(definition.id, providerFamily, validation.models) : { total: 0, priced: 0 };
      const ok = validation.verdict === "accepted";
      const eligibility = deriveMiningEligibility({ routable: protocol.routable, capabilities: validation.capabilities, hasPricedModel: models.priced > 0 });
      const status: ConnectionStatus = ok
        ? deriveConnectionStatus({ ok: true, capabilities: validation.capabilities, eligibility })
        : validation.verdict === "rejected"
          ? "invalid_credentials"
          : "validating";

      // The definition the user owns learns the corrected host and family.
      if (definition && definition.owner_user_id === userId) {
        await admin
          .from("provider_definitions")
          .update({ default_base_url: baseUrl, provider_family: providerFamily })
          .eq("id", definition.id)
          .eq("owner_user_id", userId);
      }
      const { error } = await admin
        .from("provider_connections")
        .update({
          base_url: baseUrl,
          status: ok ? "active" : "error",
          connection_status: status,
          capabilities: validation.capabilities as unknown as Record<string, boolean>,
          mining_eligibility: eligibility,
          validated_at: ok ? new Date().toISOString() : resolved.connection.validated_at,
          last_error_code: ok ? null : (validation.failure ?? "error"),
          account_context: validation.accountContext ?? resolved.connection.account_context,
        })
        .eq("id", connectionId)
        .eq("user_id", userId);
      fail("revalidate", error);
      return { status, eligibility, validation, baseUrl };
    },

    /**
     * The definition a connection belongs to.
     *
     * An OAuth provider is one USAGE configured, so its definition is SHARED:
     * the second person to connect OpenRouter reuses the first one's row rather
     * than publishing a duplicate. A pasted-key provider is the user's own.
     */
    async createCustomDefinition(input: {
      userId: string;
      displayName: string;
      protocol: ProviderProtocolId;
      baseUrl: string;
      providerFamily: string | null;
      capabilities: ProtocolCapabilities;
      authMethod?: "api_key" | "oauth";
    }): Promise<string> {
      if (input.authMethod === "oauth") {
        // Shared definition, created once and reused by everyone after.
        const existing = await admin
          .from("provider_definitions")
          .select("id")
          .eq("slug", slugify(input.displayName))
          .is("owner_user_id", null)
          .maybeSingle();
        if (existing.data) return existing.data.id;
      }

      const { data, error } = await admin
        .from("provider_definitions")
        .insert({
          slug: input.authMethod === "oauth"
            ? slugify(input.displayName)
            : `${slugify(input.displayName)}-${input.userId.slice(0, 8)}`,
          display_name: input.displayName,
          provider_family: input.providerFamily,
          protocol: input.protocol,
          default_base_url: input.baseUrl,
          supports_models: input.capabilities.models,
          supports_streaming: input.capabilities.streaming,
          supports_usage: input.capabilities.usage,
          supports_request_identity: input.capabilities.requestIdentity,
          supports_cost: input.capabilities.cost,
          supports_cache_usage: input.capabilities.cacheUsage,
          supports_reasoning_usage: input.capabilities.reasoningUsage,
          // A routable protocol can produce routed evidence. It is still only
          // CONFIRMED if trusted infrastructure signs it.
          verification_capability: "routed",
          // A definition USAGE created from its own OAuth configuration is a
          // provider it recognises, not a URL somebody typed.
          origin: input.authMethod === "oauth" ? "community_supported" : "custom",
          owner_user_id: input.authMethod === "oauth" ? null : input.userId,
        })
        .select("id")
        .single();
      fail("createDefinition", error);
      if (!data) throw new Error("createDefinition: no row returned");
      return data.id;
    },

    /**
     * Record discovered models, mapping each onto an approved price where one
     * exists. An unmapped model is stored, usable, and permanently
     * PENDING_PRICING until a snapshot covers it.
     */
    async recordModels(
      definitionId: string,
      providerFamily: string | null,
      models: readonly { upstreamModelId: string; displayName?: string }[],
    ): Promise<{ total: number; priced: number }> {
      if (models.length === 0) return { total: 0, priced: 0 };

      const rows = models.map((model) => ({
        definition_id: definitionId,
        upstream_model_id: model.upstreamModelId,
        display_name: model.displayName ?? null,
        protocol_model_key: resolveProtocolModelKey(providerFamily, model.upstreamModelId),
      }));

      const { error } = await admin
        .from("provider_models")
        .upsert(rows, { onConflict: "definition_id,upstream_model_id" });
      fail("recordModels", error);

      return {
        total: rows.length,
        priced: rows.filter((row) => row.protocol_model_key !== null).length,
      };
    },

    /**
     * Resolve a connection for a request.
     *
     * Every check that matters happens here: ownership, revocation, protocol,
     * and a fresh SSRF validation of the stored URL. The URL is re-validated
     * rather than trusted because DNS can change after a connection was
     * created, and the address that was public last week may be internal today.
     */
    async resolveForRequest(
      connectionId: string,
      userId: string,
    ): Promise<{
      connection: ProviderConnectionRow;
      protocol: ProviderProtocol;
      credential: string;
      baseUrl: string;
      /**
       * Whether the endpoint is one USAGE recognises rather than an arbitrary
       * URL the user typed. Only the former can be economic evidence.
       */
      endpointTrusted: boolean;
      /** Registry family from the definition, when known. */
      providerFamily: string | null;
      /** From the provider profile; "" when the base carries its version. */
      pathPrefix: "v1" | "";
    }> {
      const { data, error } = await admin
        .from("provider_connections")
        .select("*")
        .eq("id", connectionId)
        // Ownership is a WHERE clause on the server, not a check a caller can skip.
        .eq("user_id", userId)
        .maybeSingle();
      fail("resolveConnection", error);

      const connection = data as ProviderConnectionRow | null;
      if (!connection) throw new ConnectionError("not_found", "No such connection.");
      if (connection.revoked_at || connection.connection_status === "revoked") {
        throw new ConnectionError("revoked", "That connection has been revoked.");
      }

      const protocol = connection.protocol ? getProtocol(connection.protocol) : null;
      if (!protocol) throw new ConnectionError("not_routable", "That connection cannot be routed.");
      if (!connection.base_url) throw new ConnectionError("not_routable", "That connection has no endpoint.");
      if (!connection.secret_id) throw new ConnectionError("no_credential", "That connection has no credential.");

      // Re-validated every time: DNS is not a constant.
      await assertSafeUrl(connection.base_url);

      // Read from whichever backend actually holds it, scoped to this user.
      const { data: secretRow, error: secretError } = await admin
        .from("provider_secrets")
        .select("backend")
        .eq("id", connection.secret_id)
        .eq("user_id", userId)
        .maybeSingle();
      fail("readSecretRef", secretError);
      if (!secretRow) throw new ConnectionError("no_credential", "That connection has no credential.");

      const credential = await storeForBackend(admin, secretRow.backend).read({
        id: connection.secret_id,
        userId,
      });

      // A custom definition is an endpoint the user chose; an official or
      // community-supported one is a provider USAGE knows. So is a user-owned
      // definition whose family and host match a server-controlled profile:
      // the user picked "OpenAI", and the server fixed the host.
      const { data: definition } = await admin
        .from("provider_definitions")
        .select("origin, provider_family")
        .eq("id", connection.definition_id ?? "")
        .maybeSingle();
      const providerFamily = definition?.provider_family ?? null;
      const profile = profileForFamily(providerFamily);

      return {
        connection,
        protocol,
        credential,
        baseUrl: connection.base_url,
        providerFamily,
        pathPrefix: profile?.apiPathPrefix ?? "v1",
        endpointTrusted:
          definition?.origin === "official" ||
          definition?.origin === "community_supported" ||
          isRecognisedEndpoint(providerFamily, connection.base_url),
      };
    },

    /** Revocation takes effect immediately: the next request cannot resolve. */
    async revoke(connectionId: string, userId: string): Promise<boolean> {
      const { data, error } = await admin
        .from("provider_connections")
        .update({
          connection_status: "revoked",
          status: "revoked",
          revoked_at: new Date().toISOString(),
        })
        .eq("id", connectionId)
        .eq("user_id", userId)
        .is("revoked_at", null)
        .select("id");
      fail("revokeConnection", error);
      return (data ?? []).length > 0;
    },

    async recordOutcome(
      connectionId: string,
      outcome: { ok: boolean; errorCode?: string },
    ): Promise<void> {
      // Health only. No prompt content, no raw upstream error text.
      await admin
        .from("provider_connections")
        .update(
          outcome.ok
            ? { last_success_at: new Date().toISOString(), last_error_code: null }
            : { last_error_code: outcome.errorCode ?? "error" },
        )
        .eq("id", connectionId);
    },

    async list(userId: string): Promise<ConnectionSummaryView[]> {
      const { data, error } = await admin
        .from("provider_connections")
        .select("*")
        .eq("user_id", userId)
        .not("definition_id", "is", null)
        .order("created_at", { ascending: false });
      fail("listConnections", error);

      const connections = (data ?? []) as ProviderConnectionRow[];
      if (connections.length === 0) return [];

      const definitionIds = [
        ...new Set(connections.map((connection) => connection.definition_id).filter(Boolean)),
      ] as string[];

      const [{ data: definitions }, { data: models }] = await Promise.all([
        admin.from("provider_definitions").select("*").in("id", definitionIds),
        admin.from("provider_models").select("*").in("definition_id", definitionIds),
      ]);

      const definitionById = new Map(
        ((definitions ?? []) as ProviderDefinitionRow[]).map((row) => [row.id, row]),
      );
      const modelRows = (models ?? []) as ProviderModelRow[];

      return connections.map((connection) => {
        const forDefinition = modelRows.filter(
          (model) => model.definition_id === connection.definition_id,
        );
        return {
          id: connection.id,
          displayName: connection.account_label ?? connection.provider,
          definitionId: connection.definition_id,
          protocol: connection.protocol,
          // Host only: the full URL can carry a path a user would rather not
          // see echoed, and the host is what identifies the provider.
          baseUrlHost: connection.base_url ? safeHost(connection.base_url) : null,
          status: connection.connection_status,
          miningEligibility: connection.mining_eligibility,
          capabilities: {
            ...UNKNOWN_CAPABILITIES,
            ...(connection.capabilities as Partial<ProtocolCapabilities>),
          },
          origin: connection.definition_id
            ? (definitionById.get(connection.definition_id)?.origin ?? null)
            : null,
          authMethod: connection.auth_method ?? "api_key",
          modelCount: forDefinition.length,
          pricedModelCount: forDefinition.filter((model) => model.protocol_model_key).length,
          validatedAt: connection.validated_at,
          lastSuccessAt: connection.last_success_at,
          lastErrorCode: connection.last_error_code,
          revokedAt: connection.revoked_at,
          provider: connection.provider,
          view: deriveProviderStatusView({
            provider: connection.provider,
            authMethod: connection.auth_method ?? "api_key",
            connectionStatus: connection.connection_status,
            miningEligibility: connection.mining_eligibility,
            capabilities: { ...UNKNOWN_CAPABILITIES, ...(connection.capabilities as Partial<ProtocolCapabilities>) },
            modelCount: forDefinition.length,
            pricedModelCount: forDefinition.filter((model) => model.protocol_model_key).length,
            accountContext: connection.account_context,
            validatedAt: connection.validated_at,
            endpointTrusted: (() => {
              const definition = connection.definition_id ? definitionById.get(connection.definition_id) : undefined;
              return (
                definition?.origin === "official" ||
                definition?.origin === "community_supported" ||
                isRecognisedEndpoint(definition?.provider_family, connection.base_url)
              );
            })(),
            revoked: connection.revoked_at !== null || connection.connection_status === "revoked",
          }),
        };
      });
    },
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
