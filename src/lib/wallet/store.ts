import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database, UsageWalletEntryRow } from "@/lib/supabase/database.types";
import { OPENROUTER_GATEWAY_ID } from "@/lib/compute/openrouter-gateway";
import { VERCEL_COMPUTE_GATEWAY_ID } from "@/lib/compute/vercel-gateway";
import { utcDayStart } from "@/lib/chat/spend";
import {
  STARTING_GRANT_MICROS,
  STARTING_GRANT_REFERENCE,
  startingGrantMicros,
  walletBalance,
  type WalletBalance,
  type WalletEntry,
} from "./balance";

/**
 * Reading and writing the wallet.
 *
 * Credit is written here and nowhere else, always through `creditWallet`,
 * always with a reference -- the unique index on (user_id, reference) is what
 * makes crediting the same payment twice impossible rather than unlikely.
 *
 * Spend is never written. It is summed from `usage_events` on USAGE's own
 * funded gateways, which is the same source the dashboard and the epoch read.
 * Traffic on somebody's own connection is their own money and never touches
 * this balance.
 */

/** The table does not exist yet on a deployment that has not run 0024. */
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

function tableMissing(error: PostgrestError | null): boolean {
  return Boolean(error && (MISSING_TABLE.has(error.code) || /usage_wallet_entries/.test(error.message ?? "")));
}

function toEntry(row: UsageWalletEntryRow): WalletEntry {
  return {
    kind: row.kind,
    amountMicros: Number(row.amount_micros),
    createdAt: row.created_at,
    note: row.note,
    reference: row.reference,
  };
}

/** The grant every account has had since before there was a ledger to put it in. */
const VIRTUAL_STARTING_GRANT: WalletEntry = {
  kind: "grant",
  amountMicros: STARTING_GRANT_MICROS,
  createdAt: "1970-01-01T00:00:00.000Z",
  reference: STARTING_GRANT_REFERENCE,
  note: "Starting credit",
};

export interface WalletLedger {
  entries: WalletEntry[];
  /** False when 0024 has not been applied; the balance is then the grant alone. */
  persisted: boolean;
}

export async function readWalletLedger(admin: SupabaseClient<Database>, userId: string): Promise<WalletLedger> {
  const { data, error } = await admin
    .from("usage_wallet_entries")
    .select("id, user_id, kind, amount_micros, currency, reference, note, created_at, created_by")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    // Before the migration runs, every account still has exactly the grant it
    // had yesterday. The chat keeps working and nobody's balance moves.
    if (tableMissing(error)) return { entries: [VIRTUAL_STARTING_GRANT], persisted: false };
    throw error;
  }

  const entries = (data ?? []).map(toEntry);
  // A ledger that exists but has never seen this account still owes it the
  // starting grant; `ensureStartingGrant` writes it, and until that lands the
  // person is not left staring at zero.
  if (!entries.some((entry) => entry.reference === STARTING_GRANT_REFERENCE)) {
    entries.unshift(VIRTUAL_STARTING_GRANT);
  }
  return { entries, persisted: true };
}

/**
 * Write the starting grant if this account has never had one.
 *
 * Idempotent by the unique index, not by the read above: two tabs opening at
 * once both see no grant, and only one row survives. The duplicate is expected
 * and is not an error.
 */
export async function ensureStartingGrant(admin: SupabaseClient<Database>, userId: string): Promise<void> {
  const { error } = await admin.from("usage_wallet_entries").insert({
    user_id: userId,
    kind: "grant",
    amount_micros: startingGrantMicros(),
    reference: STARTING_GRANT_REFERENCE,
    note: "Starting credit",
    created_by: "system",
  });

  if (!error) return;
  if (tableMissing(error)) return; // 0024 has not run; nothing to do yet.
  if (error.code === "23505") return; // Already granted. That is the point.
  throw error;
}

/** What this account's traffic on USAGE's own key has cost, in total and today. */
export async function fundedSpend(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<{ lifetimeMicros: number; todayMicros: number; requestsToday: number }> {
  // Every row, a page at a time. PostgREST returns at most 1,000 rows per
  // request, and this query used to take whatever the first response held: past
  // a thousand funded requests the balance stopped going down and the daily
  // cap stopped closing, so the shared route kept spending USAGE's key. Ordered
  // by id so pages neither overlap nor skip rows.
  const rows: { actual_cost_micros: number | null; occurred_at: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("usage_events")
      .select("id, actual_cost_micros, occurred_at")
      .eq("user_id", userId)
      .in("gateway_id", [OPENROUTER_GATEWAY_ID, VERCEL_COMPUTE_GATEWAY_ID])
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    // A failed read must not look like zero spend: that would reopen the route.
    if (error) throw new Error(`fundedSpend: ${error.message}`);
    const page = (data ?? []) as { actual_cost_micros: number | null; occurred_at: string }[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const cost = (row: { actual_cost_micros: number | null }) => Math.max(0, row.actual_cost_micros ?? 0);
  const dayStart = utcDayStart();
  const today = rows.filter((row) => row.occurred_at >= dayStart);

  return {
    lifetimeMicros: rows.reduce((sum, row) => sum + cost(row), 0),
    todayMicros: today.reduce((sum, row) => sum + cost(row), 0),
    requestsToday: today.length,
  };
}

export interface WalletSnapshot extends WalletBalance {
  entries: WalletEntry[];
  todayMicros: number;
  requestsToday: number;
  /** False until 0024 is applied: top-ups cannot be recorded yet. */
  persisted: boolean;
  /** The account's public wallet identifier, or null before 0025 is applied. */
  walletId: string | null;
}

/**
 * The account's public wallet identifier.
 *
 * Null rather than thrown when 0025 has not run: the identifier is a
 * convenience and a wallet without one still works exactly as before.
 */
export async function readWalletId(admin: SupabaseClient<Database>, userId: string): Promise<string | null> {
  const { data, error } = await admin.from("profiles").select("wallet_id").eq("id", userId).maybeSingle();
  if (error) return null;
  return (data as { wallet_id?: string | null } | null)?.wallet_id ?? null;
}

export async function readWallet(admin: SupabaseClient<Database>, userId: string): Promise<WalletSnapshot> {
  const [ledger, spend, walletId] = await Promise.all([
    readWalletLedger(admin, userId),
    fundedSpend(admin, userId),
    readWalletId(admin, userId),
  ]);
  const balance = walletBalance({ entries: ledger.entries, fundedSpentMicros: spend.lifetimeMicros });
  return {
    ...balance,
    entries: ledger.entries,
    todayMicros: spend.todayMicros,
    requestsToday: spend.requestsToday,
    persisted: ledger.persisted,
    walletId,
  };
}

/** Find an account by the identifier a person quoted. Operator paths only. */
export async function userIdForWalletId(admin: SupabaseClient<Database>, walletId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .eq("wallet_id", walletId.trim().toUpperCase())
    .maybeSingle();
  if (error) return null;
  return (data as { id?: string } | null)?.id ?? null;
}

export interface CreditInput {
  userId: string;
  kind: WalletEntry["kind"];
  amountMicros: number;
  /** Idempotency key. A payment's intent id; a grant's version. */
  reference: string;
  note?: string;
  createdBy?: string;
}

export type CreditResult = { ok: true; duplicate: boolean } | { ok: false; reason: string };

/**
 * Put credit into a wallet. The ONLY way money enters.
 *
 * `reference` is required and not optional-by-convention: an unreferenced
 * credit cannot be replayed safely, and every caller that matters (a payment
 * webhook, an operator grant) has a natural one.
 */
export async function creditWallet(admin: SupabaseClient<Database>, input: CreditInput): Promise<CreditResult> {
  const amount = Math.trunc(input.amountMicros);
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, reason: "An entry must move a whole, non-zero number of micro-USD." };
  if ((input.kind === "grant" || input.kind === "topup") && amount < 0) return { ok: false, reason: "A grant or top-up adds credit." };
  if (input.kind === "refund" && amount > 0) return { ok: false, reason: "A refund removes credit." };
  if (!input.reference.trim()) return { ok: false, reason: "Every entry needs a reference, so it can never be applied twice." };

  const { error } = await admin.from("usage_wallet_entries").insert({
    user_id: input.userId,
    kind: input.kind,
    amount_micros: amount,
    reference: input.reference.trim(),
    note: input.note ?? null,
    created_by: input.createdBy ?? "system",
  });

  if (!error) return { ok: true, duplicate: false };
  if (error.code === "23505") return { ok: true, duplicate: true };
  if (tableMissing(error)) return { ok: false, reason: "The wallet ledger does not exist on this deployment yet (migration 0024)." };
  return { ok: false, reason: error.message };
}

export interface PointsHistory {
  totalPoints: number;
  epochs: { epochId: string; points: number; creditedAt: string }[];
}

/**
 * What this account has earned in USAGE Points, per settled epoch.
 *
 * Read-only, and deliberately beside the wallet rather than inside it. The
 * wallet holds credit, which is money for inference. Points are a
 * non-transferable reputation record with no monetary value. They are shown on
 * the same page because a person reasonably looks for "what I have" in one
 * place, and they are kept visually and structurally apart because they are
 * not the same kind of thing and never convert into each other.
 */
export async function readPointsHistory(client: SupabaseClient<Database>, userId: string): Promise<PointsHistory> {
  const { data, error } = await client
    .from("usage_point_ledger")
    .select("epoch_id, amount, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) return { totalPoints: 0, epochs: [] };

  const epochs = ((data ?? []) as { epoch_id: string; amount: number; created_at: string }[]).map((row) => ({
    epochId: row.epoch_id,
    points: Number(row.amount),
    creditedAt: row.created_at,
  }));
  return { totalPoints: epochs.reduce((sum, row) => sum + row.points, 0), epochs };
}
