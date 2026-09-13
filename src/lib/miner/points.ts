import { estimateReward } from "@/lib/domain/epoch";
import { effectiveEmissionPoints, type ProtocolScheduleEntry } from "@/lib/protocol/schedule";

/**
 * What the desktop window says about USAGE Points.
 *
 * It used to say nothing. The usage endpoint sent `estimatedPoints: null` on
 * every request, so the window showed a dash on a day with no mining and the
 * same dash on a day with a lot, and it never showed the balance at all -- a
 * person with 200,000 settled points opened the app to an empty tile.
 *
 * Three numbers, each labelled for what it is:
 *   - balance:   settled points, from the ledger; never changes once credited
 *   - lastCredit: the most recent settled day, so the morning after mining
 *                 shows what that day paid
 *   - estimate:  today's open epoch, with the same arithmetic the dashboard
 *                 uses, including beta-v2's scaled pool; zero once the epoch
 *                 has closed, because a closed epoch has an allocation instead
 */

export interface LedgerRow {
  epochId: string;
  amount: number;
  createdAt: string;
}

export interface MinerPointsView {
  balance: number;
  lastCredit: { day: string; points: number; creditedAt: string } | null;
  estimatedPoints: number;
}

export function minerPointsView(input: {
  ledger: readonly LedgerRow[];
  userScoreToday: number;
  networkScoreToday: number;
  todayProtocol: ProtocolScheduleEntry;
  todayEpochOpen: boolean;
}): MinerPointsView {
  const balance = input.ledger.reduce((sum, row) => sum + (Number.isFinite(row.amount) ? row.amount : 0), 0);

  const newest = [...input.ledger].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  const lastCredit = newest
    ? { day: newest.epochId.slice("epoch-".length), points: newest.amount, creditedAt: newest.createdAt }
    : null;

  const userScore = Math.max(0, input.userScoreToday);
  // The network total always includes this user; a stale view that lags
  // behind their own score must not produce a share above 100%.
  const networkScore = Math.max(userScore, input.networkScoreToday);
  const pool = effectiveEmissionPoints(input.todayProtocol, networkScore);
  const estimate = input.todayEpochOpen ? estimateReward({ userScore, networkScore, rewardPoolPoints: pool }).points : 0;

  return { balance, lastCredit, estimatedPoints: estimate };
}
