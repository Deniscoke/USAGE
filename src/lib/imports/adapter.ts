import type { UsageProviderAdapter } from "@/lib/providers/adapter";
import { listPullIntegrations } from "@/lib/providers/registry";
import { findProvider, type ProviderDefinition } from "@/lib/providers/catalog";
import type { NormalizedUsageRecord, VerificationType } from "@/lib/domain/types";
import type { ConnectionContext, UsageWindow, ValidationResult } from "@/lib/providers/adapter";

/**
 * The import boundary.
 *
 * Routed mining and historical import are different kinds of evidence and are
 * kept apart deliberately:
 *
 *   routed mining   USAGE executed the request and watched it happen.
 *                   Strength: ROUTED. Can become economically eligible.
 *   import          a provider's own admin API tells us what happened, after
 *                   the fact, on the provider's authority.
 *                   Strength: VERIFIED when the source is an authenticated
 *                   organization API, REPORTED when it is a user-supplied file.
 *
 * An import adapter therefore declares its own verification strength, and that
 * declaration is what ingestion records -- an adapter cannot claim to be
 * stronger than the source it read from, because the adapter *is* the source's
 * representation in the system.
 *
 * REPORTED usage is displayed and never rewarded, whatever an adapter says.
 */

export interface UsageImportAdapter<TRaw = unknown> {
  readonly providerSlug: string;
  readonly label: string;
  /** What kind of evidence this source can honestly produce. */
  verificationStrength(): VerificationType;
  validateConnection(context: ConnectionContext): Promise<ValidationResult>;
  fetchUsage(
    context: ConnectionContext,
    window: UsageWindow,
  ): Promise<{ provider: string; window: UsageWindow; rows: readonly TRaw[] }>;
  /** Pure. Treat the payload as untrusted input. */
  normalize(payload: {
    provider: string;
    window: UsageWindow;
    rows: readonly TRaw[];
  }): NormalizedUsageRecord[];
}

/**
 * Adapt a pull-mode provider adapter to the import boundary.
 *
 * The existing adapter interface already has exactly this shape -- pull mode IS
 * import -- so this is a narrowing, not a parallel hierarchy. Writing a second
 * near-identical interface would guarantee the two drift.
 */
export function toImportAdapter<TRaw>(
  adapter: UsageProviderAdapter<TRaw>,
  providerSlug: string,
): UsageImportAdapter<TRaw> {
  return {
    providerSlug,
    label: adapter.label,
    verificationStrength: () => adapter.getVerificationType(),
    validateConnection: (context) => adapter.validateConnection(context),
    fetchUsage: (context, window) => adapter.fetchUsage(context, window),
    normalize: (payload) => adapter.normalize(payload),
  };
}

export interface ImportCapability {
  provider: ProviderDefinition;
  /** True only when an adapter is registered AND the catalog says available. */
  implemented: boolean;
  verificationStrength: VerificationType | null;
}

/**
 * What can actually be imported right now.
 *
 * Derived from the two things that must agree: a registered adapter, and a
 * catalog entry that claims the capability. Disagreement means the capability
 * is not offered -- the product never shows an import it cannot perform.
 */
export function listImportCapabilities(): ImportCapability[] {
  const adapters = new Map(
    listPullIntegrations()
      .map((integration) => [integration.provider, integration] as const)
      .filter(([provider]) => !provider.startsWith("demo-")),
  );

  const capabilities: ImportCapability[] = [];
  for (const [slug, integration] of adapters) {
    const provider = findProvider(slug);
    if (!provider) continue;
    capabilities.push({
      provider,
      implemented: provider.methods.verified_import.availability === "available",
      verificationStrength: integration.verificationType,
    });
  }
  return capabilities;
}
