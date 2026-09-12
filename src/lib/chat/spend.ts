/**
 * The day boundary, and the second ceiling that is counted in messages.
 *
 * The money ceiling lives with the wallet, in `@/lib/wallet/balance`, because
 * how much a person may spend depends on whether the money is theirs or
 * USAGE's. What stays here is what has nothing to do with a balance: where a
 * UTC day starts, and how many messages one account gets in it.
 *
 * A count is needed alongside the money because a provider that reports no
 * cost would leave the money cap unfilled forever. A count cannot be left
 * blank by an upstream that declines to answer.
 */

/** Start of the current UTC day, for "what did this account spend today". */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export const DEFAULT_FUNDED_DAILY_REQUESTS = 60;

/** The configured message limit, or the default when the variable is absent or nonsense. */
export function fundedDailyRequestLimit(raw: string | undefined = process.env.USAGE_CHAT_FUNDED_DAILY_REQUESTS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_FUNDED_DAILY_REQUESTS;
}
