import { hashSeed, mulberry32 } from "@/lib/providers/random";

/**
 * SIMULATED network-wide totals.
 *
 * Real network score will be a SUM over all participants' score_records for the
 * epoch. Until there is a network, the dashboard needs a plausible denominator
 * for network share, so we derive one deterministically per day. Everything
 * here is clearly labelled as demo data in the UI.
 */

/** USAGE Points distributed per daily epoch. Fixed by design. */
export const DAILY_REWARD_POOL_POINTS = 100_000;

export interface SimulatedNetwork {
  day: string;
  participants: number;
  score: number;
}

export function simulatedNetwork(day: string): SimulatedNetwork {
  const rng = mulberry32(hashSeed("usage-network", day));
  const participants = 3_800 + Math.floor(rng() * 900);
  // Average scored participant sits around a few hundred points per day.
  const score = Math.round(participants * (620 + rng() * 260));
  return { day, participants, score };
}
