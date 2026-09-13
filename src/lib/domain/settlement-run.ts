/**
 * One nightly settlement run: which days it looks at, and whether it failed.
 *
 * WHY MORE THAN YESTERDAY. The job used to settle only the day before. A day
 * it refused, or a night Vercel did not run it, was then never looked at
 * again, and the people who mined that day were simply never paid. Looking
 * back a few days costs nothing -- a settled epoch is skipped -- and turns a
 * missed night into a late payment instead of a lost one.
 *
 * WHY A REFUSAL IS A FAILURE. It used to answer 200 with the reason in the
 * body. The scheduler records a 200 as success, so a refusal that recurred
 * every night looked exactly like a healthy job. A refusal is the system
 * declining to pay people; that has to show up as a failed run.
 */

export const SETTLEMENT_LOOKBACK_DAYS = 3;

/** The last `count` complete UTC days, oldest first. */
export function recentCompleteDays(count: number = SETTLEMENT_LOOKBACK_DAYS, now: Date = new Date()): string[] {
  const days: string[] = [];
  for (let back = count; back >= 1; back -= 1) {
    days.push(new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

export type RunOutcome = "settled" | "skipped" | "refused";

/** 200 when every day settled or had nothing to do; 500 when any was refused. */
export function settlementRunStatus(outcomes: readonly RunOutcome[]): 200 | 500 {
  return outcomes.includes("refused") ? 500 : 200;
}
