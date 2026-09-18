import type { ProviderBillingAccountRow, ProviderBillingUsageRow } from "@/lib/supabase/database.types";
import type { BillingScope } from "./github";
import { billingIdentityKey, type NormalizedBillingRow, type StoredBillingRow } from "./normalize";
import type { BillingAccount, BillingAccountPatch } from "./store";

/**
 * Row <-> domain mapping for the provider-billing tables, shared by the
 * Supabase store and the SQL test store so both write exactly the same shape.
 */

export const ACCOUNT_COLUMNS =
  "id, user_id, provider, provider_principal_id, provider_login, billing_scope, status, permission_state, token_secret_id, secret_backend, access_token_expires_at, refresh_token_expires_at, last_sync_at, last_success_at, last_manual_sync_at, last_error_class";

type AccountSelect = Pick<
  ProviderBillingAccountRow,
  | "id"
  | "user_id"
  | "provider"
  | "provider_principal_id"
  | "provider_login"
  | "billing_scope"
  | "status"
  | "permission_state"
  | "token_secret_id"
  | "secret_backend"
  | "access_token_expires_at"
  | "refresh_token_expires_at"
  | "last_sync_at"
  | "last_success_at"
  | "last_manual_sync_at"
  | "last_error_class"
>;

export function accountFromRow(row: AccountSelect): BillingAccount {
  return {
    id: row.id,
    userId: row.user_id,
    provider: "github",
    principalId: row.provider_principal_id,
    login: row.provider_login,
    billingScope: row.billing_scope as BillingScope,
    status: row.status,
    permissionState: row.permission_state,
    tokenSecretId: row.token_secret_id,
    secretBackend: row.secret_backend,
    accessExpiresAt: row.access_token_expires_at,
    refreshExpiresAt: row.refresh_token_expires_at,
    lastSyncAt: row.last_sync_at,
    lastSuccessAt: row.last_success_at,
    lastManualSyncAt: row.last_manual_sync_at,
    lastErrorClass: row.last_error_class,
  };
}

export function patchToRow(patch: BillingAccountPatch, now: string): Partial<ProviderBillingAccountRow> {
  const row: Partial<ProviderBillingAccountRow> = { updated_at: now };
  if (patch.login !== undefined) row.provider_login = patch.login;
  if (patch.billingScope !== undefined) row.billing_scope = patch.billingScope;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.permissionState !== undefined) row.permission_state = patch.permissionState;
  if (patch.tokenSecretId !== undefined) row.token_secret_id = patch.tokenSecretId;
  if (patch.secretBackend !== undefined) row.secret_backend = patch.secretBackend;
  if (patch.accessExpiresAt !== undefined) row.access_token_expires_at = patch.accessExpiresAt;
  if (patch.refreshExpiresAt !== undefined) row.refresh_token_expires_at = patch.refreshExpiresAt;
  if (patch.apiVersion !== undefined) row.api_version = patch.apiVersion;
  if (patch.lastSyncAt !== undefined) row.last_sync_at = patch.lastSyncAt;
  if (patch.lastSuccessAt !== undefined) row.last_success_at = patch.lastSuccessAt;
  if (patch.lastErrorClass !== undefined) row.last_error_class = patch.lastErrorClass;
  if (patch.disconnectedAt !== undefined) row.disconnected_at = patch.disconnectedAt;
  return row;
}

export function usageRowValues(row: NormalizedBillingRow) {
  return {
    price_per_unit_text: row.pricePerUnitText,
    price_per_unit_micros: row.pricePerUnitMicros,
    gross_quantity_text: row.grossQuantityText,
    gross_quantity_micro_units: row.grossQuantityMicroUnits,
    discount_quantity_text: row.discountQuantityText,
    discount_quantity_micro_units: row.discountQuantityMicroUnits,
    net_quantity_text: row.netQuantityText,
    net_quantity_micro_units: row.netQuantityMicroUnits,
    gross_amount_text: row.grossAmountText,
    gross_amount_micros: row.grossAmountMicros,
    discount_amount_text: row.discountAmountText,
    discount_amount_micros: row.discountAmountMicros,
    net_amount_text: row.netAmountText,
    net_amount_micros: row.netAmountMicros,
  };
}

export function storedFromUsageRow(r: ProviderBillingUsageRow): StoredBillingRow {
  const base = {
    provider: r.provider,
    principalId: r.principal_id,
    billingScope: "personal" as const,
    periodKind: r.period_kind,
    periodStart: String(r.period_start).slice(0, 10),
    product: r.product,
    sku: r.sku,
    model: r.model,
    unitType: r.unit_type,
  };
  return {
    ...base,
    identityKey: billingIdentityKey(base),
    id: r.id,
    revision: r.revision,
    withdrawn: r.withdrawn_at !== null,
    currentSnapshotId: r.current_snapshot_id,
    pricePerUnitText: r.price_per_unit_text,
    pricePerUnitMicros: Number(r.price_per_unit_micros),
    grossQuantityText: r.gross_quantity_text,
    grossQuantityMicroUnits: Number(r.gross_quantity_micro_units),
    discountQuantityText: r.discount_quantity_text,
    discountQuantityMicroUnits: Number(r.discount_quantity_micro_units),
    netQuantityText: r.net_quantity_text,
    netQuantityMicroUnits: Number(r.net_quantity_micro_units),
    grossAmountText: r.gross_amount_text,
    grossAmountMicros: Number(r.gross_amount_micros),
    discountAmountText: r.discount_amount_text,
    discountAmountMicros: Number(r.discount_amount_micros),
    netAmountText: r.net_amount_text,
    netAmountMicros: Number(r.net_amount_micros),
  };
}

