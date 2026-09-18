import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { BillingScope } from "./github";
import type { BillingAccountStatus } from "./store";

/**
 * What the dashboard, /analytics and /providers show for the provider-billing
 * lane. Read as the signed-in user, so RLS decides what comes back.
 *
 * This lane is summed only with itself. Nothing here accepts local telemetry
 * or verified compute, and nothing here returns a figure in their units:
 * provider billing is aggregate money and provider units, not requests.
 */

export const PROVIDER_BILLING_COPY = {
  title: "Provider-confirmed usage",
  explanation:
    "Usage reported directly by GitHub billing. It is authoritative billing evidence but does not currently earn Usage Points.",
  reward: "Reward: NOT ENABLED",
} as const;

export interface BillingAccountView {
  provider: "github";
  login: string | null;
  status: BillingAccountStatus;
  billingScope: BillingScope;
  permissionState: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastErrorClass: string | null;
}

export interface BillingUsageRowView {
  provider: string;
  periodKind: "day" | "month";
  periodStart: string;
  product: string;
  sku: string;
  model: string;
  unitType: string;
  grossQuantityMicroUnits: number;
  discountQuantityMicroUnits: number;
  netQuantityMicroUnits: number;
  grossAmountMicros: number;
  discountAmountMicros: number;
  netAmountMicros: number;
  withdrawn: boolean;
}

export interface UnitTotals {
  unitType: string;
  grossMicroUnits: number;
  includedMicroUnits: number;
  netMicroUnits: number;
}

export interface BillingMonthSummary {
  provider: string;
  month: string;
  units: UnitTotals[];
  grossAmountMicros: number;
  includedAmountMicros: number;
  netAmountMicros: number;
  models: string[];
  products: string[];
  itemCount: number;
}

export interface BillingDaySummary {
  day: string;
  units: UnitTotals[];
  grossAmountMicros: number;
  netAmountMicros: number;
}

function addUnits(map: Map<string, UnitTotals>, row: BillingUsageRowView): void {
  const current = map.get(row.unitType) ?? { unitType: row.unitType, grossMicroUnits: 0, includedMicroUnits: 0, netMicroUnits: 0 };
  map.set(row.unitType, {
    unitType: row.unitType,
    grossMicroUnits: current.grossMicroUnits + row.grossQuantityMicroUnits,
    includedMicroUnits: current.includedMicroUnits + row.discountQuantityMicroUnits,
    netMicroUnits: current.netMicroUnits + row.netQuantityMicroUnits,
  });
}

/** This month's aggregate, per provider, from month rows only (never day rows added up). */
export function summarizeBillingMonth(rows: readonly BillingUsageRowView[], month: string): BillingMonthSummary[] {
  const byProvider = new Map<string, BillingUsageRowView[]>();
  for (const row of rows) {
    if (row.withdrawn || row.periodKind !== "month" || !row.periodStart.startsWith(month)) continue;
    byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row]);
  }
  return [...byProvider.entries()].map(([provider, list]) => {
    const units = new Map<string, UnitTotals>();
    for (const row of list) addUnits(units, row);
    return {
      provider,
      month,
      units: [...units.values()],
      grossAmountMicros: list.reduce((sum, r) => sum + r.grossAmountMicros, 0),
      includedAmountMicros: list.reduce((sum, r) => sum + r.discountAmountMicros, 0),
      netAmountMicros: list.reduce((sum, r) => sum + r.netAmountMicros, 0),
      models: [...new Set(list.map((r) => r.model).filter((m) => m.length > 0))].sort(),
      products: [...new Set(list.map((r) => r.product))].sort(),
      itemCount: list.length,
    };
  });
}

/** Daily rows, oldest first. Days GitHub has not reported are absent, not zero. */
export function summarizeBillingDays(rows: readonly BillingUsageRowView[], month: string): BillingDaySummary[] {
  const byDay = new Map<string, BillingUsageRowView[]>();
  for (const row of rows) {
    if (row.withdrawn || row.periodKind !== "day" || !row.periodStart.startsWith(month)) continue;
    byDay.set(row.periodStart, [...(byDay.get(row.periodStart) ?? []), row]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => {
      const units = new Map<string, UnitTotals>();
      for (const row of list) addUnits(units, row);
      return {
        day,
        units: [...units.values()],
        grossAmountMicros: list.reduce((sum, r) => sum + r.grossAmountMicros, 0),
        netAmountMicros: list.reduce((sum, r) => sum + r.netAmountMicros, 0),
      };
    });
}

export interface BillingHeadline {
  availability: "AVAILABLE" | "NOT APPLICABLE" | "PERMISSION MISSING" | "NOT YET CHECKED";
  scopeLabel: string;
  permissionLabel: string;
  connectionLabel: "CONNECTED" | "DEGRADED" | "NEEDS RECONNECT" | "DISCONNECTED";
}

export function billingHeadline(account: BillingAccountView): BillingHeadline {
  const availability =
    account.billingScope === "personal"
      ? "AVAILABLE"
      : account.billingScope === "no_data_or_managed" || account.billingScope === "unavailable"
        ? "NOT APPLICABLE"
        : account.billingScope === "permission_insufficient"
          ? "PERMISSION MISSING"
          : "NOT YET CHECKED";
  const scopeLabel = {
    personal: "Personal",
    no_data_or_managed: "No personal billing (organization-managed or none)",
    permission_insufficient: "Not permitted",
    unavailable: "Not supported for this account",
    unknown: "Not yet checked",
  }[account.billingScope];
  const permissionLabel =
    account.permissionState === "insufficient" ? "Plan (read) not granted" : "Plan (read)";
  const connectionLabel = {
    connected: "CONNECTED",
    degraded: "DEGRADED",
    needs_reauth: "NEEDS RECONNECT",
    revoked: "DISCONNECTED",
  }[account.status] as BillingHeadline["connectionLabel"];
  return { availability, scopeLabel, permissionLabel, connectionLabel };
}

export function utcMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Columns a signed-in user may select (0029 grants these and no others). */
export const BILLING_ACCOUNT_COLUMNS =
  "provider, provider_login, status, billing_scope, permission_state, last_sync_at, last_success_at, last_error_class";
export const BILLING_USAGE_COLUMNS =
  "provider, period_kind, period_start, product, sku, model, unit_type, gross_quantity_micro_units, discount_quantity_micro_units, net_quantity_micro_units, gross_amount_micros, discount_amount_micros, net_amount_micros, withdrawn_at";

export interface LoadedProviderBilling {
  accounts: BillingAccountView[];
  rows: BillingUsageRowView[];
  month: string;
}

/** Read this month's provider billing as the signed-in user. */
export async function loadProviderBilling(
  supabase: SupabaseClient<Database>,
  userId: string,
  now: Date,
): Promise<LoadedProviderBilling> {
  const month = utcMonth(now);
  const [accounts, rows] = await Promise.all([
    supabase.from("provider_billing_accounts").select(BILLING_ACCOUNT_COLUMNS).eq("user_id", userId),
    supabase
      .from("provider_billing_usage")
      .select(BILLING_USAGE_COLUMNS)
      .gte("period_start", `${month}-01`)
      .order("period_start", { ascending: true })
      .limit(2000),
  ]);
  if (accounts.error) throw new Error(`provider billing accounts: ${accounts.error.message}`);
  if (rows.error) throw new Error(`provider billing usage: ${rows.error.message}`);

  return {
    month,
    accounts: (accounts.data ?? []).map((a) => ({
      provider: "github" as const,
      login: a.provider_login,
      status: a.status as BillingAccountStatus,
      billingScope: a.billing_scope as BillingScope,
      permissionState: a.permission_state,
      lastSyncAt: a.last_sync_at,
      lastSuccessAt: a.last_success_at,
      lastErrorClass: a.last_error_class,
    })),
    rows: (rows.data ?? []).map((r) => rowView(r)),
  };
}

export function rowView(r: {
  provider: string;
  period_kind: string;
  period_start: string;
  product: string;
  sku: string;
  model: string;
  unit_type: string;
  gross_quantity_micro_units: number | string;
  discount_quantity_micro_units: number | string;
  net_quantity_micro_units: number | string;
  gross_amount_micros: number | string;
  discount_amount_micros: number | string;
  net_amount_micros: number | string;
  withdrawn_at: string | null;
}): BillingUsageRowView {
  const int = (value: number | string): number => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(n)) throw new Error("provider billing value out of exact range");
    return n;
  };
  return {
    provider: r.provider,
    periodKind: r.period_kind === "day" ? "day" : "month",
    periodStart: String(r.period_start).slice(0, 10),
    product: r.product,
    sku: r.sku,
    model: r.model,
    unitType: r.unit_type,
    grossQuantityMicroUnits: int(r.gross_quantity_micro_units),
    discountQuantityMicroUnits: int(r.discount_quantity_micro_units),
    netQuantityMicroUnits: int(r.net_quantity_micro_units),
    grossAmountMicros: int(r.gross_amount_micros),
    discountAmountMicros: int(r.discount_amount_micros),
    netAmountMicros: int(r.net_amount_micros),
    withdrawn: r.withdrawn_at !== null,
  };
}
