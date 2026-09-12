/**
 * The wallet: what a person has to spend on USAGE's own key, and what is left.
 *
 * TWO SOURCES, ONE NUMBER. Credit comes from the ledger (grants somebody was
 * given, top-ups somebody paid for). Spend is never in the ledger: it is read
 * from the persisted usage rows, the same ones the dashboard, the epoch and
 * the receipts are built from. So the balance a person sees is arithmetic over
 * facts, not a counter that could quietly disagree with their own history.
 *
 * WALLET CREDIT IS NOT USAGE POINTS, and the two must never meet. Credit is
 * money-denominated and buys inference. Points are an off-chain, non-transferable
 * reputation record that carries no monetary value and comes from a fixed epoch
 * pool. Nothing in this file converts between them, and nothing should: the day
 * credit buys points is the day points are for sale.
 */

/** The starting grant, once per account, for life. */
export const STARTING_GRANT_MICROS = 500_000; // $0.50

/** The idempotency key of that grant. Bump the suffix to make a NEW grant. */
export const STARTING_GRANT_REFERENCE = "starting-credit-v1";

/**
 * What a new account is given, at the moment it is given.
 *
 * Configurable because the figure is a business decision, but read only when
 * the grant is written: once it is a row in the ledger it is history, and
 * changing the variable later must not silently restate somebody's balance.
 */
export function startingGrantMicros(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.USAGE_CHAT_STARTING_CREDIT_MICROS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : STARTING_GRANT_MICROS;
}

/** While the balance is USAGE's own money, the day is small. */
export const FREE_DAILY_CAP_MICROS = 250_000; // $0.25

/** Once somebody has paid in, the day is their own, with a runaway rail. */
export const PAID_DAILY_CAP_MICROS = 25_000_000; // $25.00

export type WalletEntryKind = "grant" | "topup" | "refund" | "adjustment";

export interface WalletEntry {
  kind: WalletEntryKind;
  amountMicros: number;
  createdAt: string;
  note?: string | null;
  reference?: string | null;
}

export interface WalletBalance {
  /** Everything ever credited, of any kind. */
  creditedMicros: number;
  /** Of that, the part somebody actually paid for. */
  paidMicros: number;
  /** Of that, the part USAGE gave away. */
  grantedMicros: number;
  /** What this account's traffic on USAGE's funded gateways has cost. */
  spentMicros: number;
  /** Credited minus spent, floored at zero for display. See `overdrawnMicros`. */
  balanceMicros: number;
  /**
   * How far past zero the last reply carried them. A reply's cost is only
   * known once it has been written, so the final message of a balance can
   * cross the line and the next request is refused. Bounded by one reply.
   */
  overdrawnMicros: number;
  /** True once any real money is in the ledger, which lifts the daily rail. */
  funded: boolean;
}

const whole = (value: number): number => (Number.isFinite(value) ? Math.trunc(value) : 0);

/** True when an entry represents money somebody actually paid, not a giveaway. */
function isPaidMovement(entry: WalletEntry): boolean {
  if (entry.kind === "topup") return true;
  // A refund or correction follows the money it corrects: it is only paid
  // money if it carries the payment's reference.
  if (entry.kind === "refund" || entry.kind === "adjustment") return Boolean(entry.reference);
  return false;
}

export function walletBalance(input: {
  entries: readonly WalletEntry[];
  fundedSpentMicros: number;
}): WalletBalance {
  let paid = 0;
  let granted = 0;

  for (const entry of input.entries) {
    const amount = whole(entry.amountMicros);
    if (amount === 0) continue;
    if (isPaidMovement(entry)) paid += amount;
    else granted += amount;
  }

  const credited = paid + granted;
  const spent = Math.max(0, whole(input.fundedSpentMicros));
  const net = credited - spent;

  return {
    creditedMicros: credited,
    paidMicros: paid,
    grantedMicros: granted,
    spentMicros: spent,
    balanceMicros: Math.max(0, net),
    overdrawnMicros: net < 0 ? -net : 0,
    // A refunded top-up leaves no money behind, so the rail comes back down.
    funded: paid > 0,
  };
}

/**
 * The daily ceiling this account runs under.
 *
 * USAGE's own money is rationed by the day, because a stranger with a loop
 * should not be able to drain a giveaway in one afternoon. Money somebody paid
 * in is theirs to spend, and its ceiling exists only so a runaway script
 * cannot empty a wallet before its owner notices.
 */
export function walletDailyCapMicros(
  balance: Pick<WalletBalance, "funded">,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = balance.funded ? env.USAGE_WALLET_PAID_DAILY_CAP_MICROS : env.USAGE_CHAT_FUNDED_DAILY_CAP_MICROS;
  const fallback = balance.funded ? PAID_DAILY_CAP_MICROS : FREE_DAILY_CAP_MICROS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export type WalletRefusal = "empty" | "daily_cap" | "daily_requests";

export interface WalletDecision {
  allowed: boolean;
  refusal: WalletRefusal | null;
  capMicros: number;
  spentTodayMicros: number;
  remainingTodayMicros: number;
}

export function walletDecision(input: {
  balance: WalletBalance;
  spentTodayMicros: number;
  requestsToday: number;
  requestLimit: number;
  env?: Record<string, string | undefined>;
}): WalletDecision {
  const cap = walletDailyCapMicros(input.balance, input.env ?? process.env);
  const spentToday = Math.max(0, whole(input.spentTodayMicros));
  const requests = Math.max(0, whole(input.requestsToday));
  const limit = Math.max(0, whole(input.requestLimit));

  const refusal: WalletRefusal | null =
    input.balance.balanceMicros <= 0
      ? "empty"
      : spentToday >= cap
        ? "daily_cap"
        : requests >= limit
          ? "daily_requests"
          : null;

  return {
    allowed: refusal === null,
    refusal,
    capMicros: cap,
    spentTodayMicros: spentToday,
    remainingTodayMicros: Math.max(0, cap - spentToday),
  };
}

/** What to tell somebody who has just been refused. */
export function walletRefusalMessage(refusal: WalletRefusal, funded: boolean): string {
  if (refusal === "empty") {
    return funded
      ? "Your wallet is empty. Top it up, or connect a paid provider of your own."
      : "Your starting credit is used up. Connect a paid provider of your own to keep going, and to earn.";
  }
  if (refusal === "daily_cap") {
    return "Today's spending limit is reached. It resets at midnight UTC.";
  }
  return "Today's message limit is reached. It resets at midnight UTC.";
}
