import type { NormalizedUsageRecord, ProviderCapability, VerificationType } from "@/lib/domain/types";

/**
 * The integration boundary.
 *
 * Adapters are the ONLY place allowed to know a provider's wire format.
 * `fetchUsage` returns whatever the provider gave us (opaque to callers) and
 * `normalize` is the one-way door into USAGE's domain model.
 */

export interface UsageWindow {
  /** Inclusive. */
  since: Date;
  /** Exclusive. */
  until: Date;
}

/** Opaque, per-connection credentials/config. Server-side only, never logged. */
export interface ConnectionContext {
  connectionId: string;
  /** Resolved secrets. Adapters must not persist or echo these. */
  secrets: Readonly<Record<string, string>>;
  config: Readonly<Record<string, string>>;
}

export type ValidationResult =
  | { ok: true; accountLabel: string }
  | { ok: false; reason: string };

export interface RawUsagePayload<T = unknown> {
  provider: string;
  window: UsageWindow;
  rows: readonly T[];
}

export interface UsageProviderAdapter<TRaw = unknown> {
  readonly provider: string;
  readonly label: string;
  readonly capability: ProviderCapability;

  validateConnection(context: ConnectionContext): Promise<ValidationResult>;

  fetchUsage(context: ConnectionContext, window: UsageWindow): Promise<RawUsagePayload<TRaw>>;

  /** Pure. Treat `payload` as untrusted input. */
  normalize(payload: RawUsagePayload<TRaw>): NormalizedUsageRecord[];

  getVerificationType(): VerificationType;
}

/**
 * Type-erased view of an adapter so a heterogeneous registry stays type-safe:
 * the raw payload type is captured at the seam and never escapes.
 */
export interface ProviderIntegration {
  readonly provider: string;
  readonly label: string;
  readonly capability: ProviderCapability;
  readonly verificationType: VerificationType;
  validateConnection(context: ConnectionContext): Promise<ValidationResult>;
  collect(context: ConnectionContext, window: UsageWindow): Promise<NormalizedUsageRecord[]>;
}

export function toIntegration<TRaw>(adapter: UsageProviderAdapter<TRaw>): ProviderIntegration {
  return {
    provider: adapter.provider,
    label: adapter.label,
    capability: adapter.capability,
    verificationType: adapter.getVerificationType(),
    validateConnection: (context) => adapter.validateConnection(context),
    async collect(context, window) {
      const payload = await adapter.fetchUsage(context, window);
      return adapter.normalize(payload);
    },
  };
}
