import { canonicalDecimal } from "./decimal";
import type { GithubUsageResponse, UsagePeriod } from "./github";

/**
 * Provider billing items -> current normalized rows.
 *
 * IDENTITY is (provider, principal, billing scope, period kind, period start,
 * product, sku, model, unit type). When the row was fetched is not part of it,
 * so polling the same period a hundred times converges on one row.
 *
 * REVISIONS. Same identity, same values: nothing changes, not even the
 * revision. Same identity, different values (a provider correction): the row
 * takes the new values, its revision goes up by one, and it points at the new
 * snapshot -- the old snapshot is immutable and stays. An identity the latest
 * response for that period no longer lists is marked withdrawn, never deleted.
 */

export type PeriodKind = "day" | "month";

export interface NormalizedBillingRow {
  identityKey: string;
  provider: string;
  principalId: string;
  billingScope: "personal";
  periodKind: PeriodKind;
  /** YYYY-MM-DD; the first of the month for a month row. */
  periodStart: string;
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnitText: string;
  pricePerUnitMicros: number;
  grossQuantityText: string;
  grossQuantityMicroUnits: number;
  discountQuantityText: string;
  discountQuantityMicroUnits: number;
  netQuantityText: string;
  netQuantityMicroUnits: number;
  grossAmountText: string;
  grossAmountMicros: number;
  discountAmountText: string;
  discountAmountMicros: number;
  netAmountText: string;
  netAmountMicros: number;
}

/** A current row as stored. */
export interface StoredBillingRow extends NormalizedBillingRow {
  id: string;
  revision: number;
  withdrawn: boolean;
  currentSnapshotId: string;
}

export class DuplicateIdentityError extends Error {
  constructor() {
    super("The provider listed the same billing identity twice in one response.");
    this.name = "DuplicateIdentityError";
  }
}

export function periodStartFor(period: UsagePeriod): { kind: PeriodKind; start: string } {
  const month = String(period.month).padStart(2, "0");
  if (period.day === undefined) return { kind: "month", start: `${period.year}-${month}-01` };
  return { kind: "day", start: `${period.year}-${month}-${String(period.day).padStart(2, "0")}` };
}

export function billingIdentityKey(row: Pick<
  NormalizedBillingRow,
  "provider" | "principalId" | "billingScope" | "periodKind" | "periodStart" | "product" | "sku" | "model" | "unitType"
>): string {
  // JSON array: unambiguous whatever characters the provider's labels contain.
  return JSON.stringify([
    row.provider,
    row.principalId,
    row.billingScope,
    row.periodKind,
    row.periodStart,
    row.product,
    row.sku,
    row.model,
    row.unitType,
  ]);
}

export function normalizeGithubUsage(input: {
  response: GithubUsageResponse;
  principalId: string;
  period: UsagePeriod;
}): NormalizedBillingRow[] {
  const { kind, start } = periodStartFor(input.period);
  const seen = new Set<string>();
  return input.response.usageItems.map((item) => {
    const base = {
      provider: "github",
      principalId: input.principalId,
      billingScope: "personal" as const,
      periodKind: kind,
      periodStart: start,
      product: item.product,
      sku: item.sku,
      model: item.model,
      unitType: item.unitType,
    };
    const identityKey = billingIdentityKey(base);
    // Two items with one identity would have to be summed, and GitHub does not
    // document that case. Refusing is safer than guessing.
    if (seen.has(identityKey)) throw new DuplicateIdentityError();
    seen.add(identityKey);
    return {
      ...base,
      identityKey,
      pricePerUnitText: item.pricePerUnit.text,
      pricePerUnitMicros: item.pricePerUnit.scaled,
      grossQuantityText: item.grossQuantity.text,
      grossQuantityMicroUnits: item.grossQuantity.scaled,
      discountQuantityText: item.discountQuantity.text,
      discountQuantityMicroUnits: item.discountQuantity.scaled,
      netQuantityText: item.netQuantity.text,
      netQuantityMicroUnits: item.netQuantity.scaled,
      grossAmountText: item.grossAmount.text,
      grossAmountMicros: item.grossAmount.scaled,
      discountAmountText: item.discountAmount.text,
      discountAmountMicros: item.discountAmount.scaled,
      netAmountText: item.netAmount.text,
      netAmountMicros: item.netAmount.scaled,
    };
  });
}

const VALUE_TEXT_FIELDS = [
  "pricePerUnitText",
  "grossQuantityText",
  "discountQuantityText",
  "netQuantityText",
  "grossAmountText",
  "discountAmountText",
  "netAmountText",
] as const;

/** Same values, compared as exact decimals ("1" equals "1.0"; never floats). */
export function sameBillingValues(a: NormalizedBillingRow, b: NormalizedBillingRow): boolean {
  return VALUE_TEXT_FIELDS.every((field) => canonicalDecimal(a[field]) === canonicalDecimal(b[field]));
}

export interface UsageUpsertPlan {
  inserts: NormalizedBillingRow[];
  updates: { id: string; row: NormalizedBillingRow; revision: number }[];
  withdrawals: { id: string; revision: number }[];
  unchanged: number;
}

/**
 * Decide what one response for one period does to the stored rows.
 * `existing` must be every stored row for the same account and period.
 */
export function planUsageUpsert(existing: readonly StoredBillingRow[], incoming: readonly NormalizedBillingRow[]): UsageUpsertPlan {
  const stored = new Map(existing.map((row) => [row.identityKey, row]));
  const plan: UsageUpsertPlan = { inserts: [], updates: [], withdrawals: [], unchanged: 0 };
  const present = new Set<string>();

  for (const row of incoming) {
    present.add(row.identityKey);
    const current = stored.get(row.identityKey);
    if (!current) {
      plan.inserts.push(row);
    } else if (current.withdrawn || !sameBillingValues(current, row)) {
      plan.updates.push({ id: current.id, row, revision: current.revision + 1 });
    } else {
      plan.unchanged += 1;
    }
  }
  for (const row of existing) {
    if (!present.has(row.identityKey) && !row.withdrawn) {
      plan.withdrawals.push({ id: row.id, revision: row.revision + 1 });
    }
  }
  return plan;
}
