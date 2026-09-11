/**
 * The daily ceiling on chat that USAGE itself pays for.
 *
 * When a person has no eligible provider of their own, chat runs on USAGE's
 * shared key. That is USAGE's money, and a route that spends somebody else's
 * money with no ceiling is not a feature, it is an invitation: one stranger
 * with a loop could drain the balance before anyone noticed. So every account
 * gets a small daily allowance on the shared route, measured from the same
 * persisted records everything else is measured from, and the request that
 * would cross it is refused before it reaches the provider.
 *
 * Compute on a person's own connection is not capped here. They are spending
 * their own credit, and their provider already enforces its own limits.
 */

export const DEFAULT_FUNDED_DAILY_CAP_MICROS = 250_000; // $0.25 per account per UTC day

export interface SpendDecision {
  allowed: boolean;
  spentMicros: number;
  capMicros: number;
  remainingMicros: number;
}

export function fundedSpendDecision(input: { spentMicros: number; capMicros: number }): SpendDecision {
  const spent = Math.max(0, Math.floor(input.spentMicros));
  const cap = Math.max(0, Math.floor(input.capMicros));
  const remaining = Math.max(0, cap - spent);
  return {
    // Strictly below the cap, so a day with exactly the cap spent is closed.
    // A refused request costs nothing; an allowed one could cost up to a
    // whole reply, so the ceiling is a floor on refusals, not a hard limit
    // on spend -- which is why the cap is small.
    allowed: spent < cap,
    spentMicros: spent,
    capMicros: cap,
    remainingMicros: remaining,
  };
}

/** The configured cap, or the default when the variable is absent or nonsense. */
export function fundedDailyCapMicros(raw: string | undefined = process.env.USAGE_CHAT_FUNDED_DAILY_CAP_MICROS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_FUNDED_DAILY_CAP_MICROS;
}

/** Start of the current UTC day, for "what did this account spend today". */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export const DEFAULT_FUNDED_DAILY_REQUESTS = 60;

/**
 * A second ceiling, in requests. A provider that reports no cost would leave
 * the money cap unfilled forever; a count cannot be left blank.
 */
export function fundedDailyRequestLimit(raw: string | undefined = process.env.USAGE_CHAT_FUNDED_DAILY_REQUESTS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_FUNDED_DAILY_REQUESTS;
}

export function withinRequestBudget(requestsToday: number, limit: number): boolean {
  return Math.max(0, Math.floor(requestsToday)) < Math.max(0, Math.floor(limit));
}
