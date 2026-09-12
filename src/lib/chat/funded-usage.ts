import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { readWallet, type WalletSnapshot } from "@/lib/wallet/store";
import { walletDecision, walletRefusalMessage, type WalletRefusal } from "@/lib/wallet/balance";
import { fundedDailyRequestLimit } from "./spend";

/**
 * What this account may still spend of USAGE's money, and why not when it may not.
 *
 * The balance comes from the wallet: credit in the ledger, minus what this
 * account's traffic on USAGE's funded gateways actually cost. Both funded
 * gateways count, whichever surface produced the traffic, so the miner's
 * fallback and the chat's shared route draw on one balance rather than two.
 *
 * Compute on a person's own connection is not counted here at all. They are
 * spending their own credit with their own provider, and that provider already
 * enforces its own limits.
 */
export interface FundedUsageToday {
  /** Spent today on USAGE's key. */
  spentMicros: number;
  capMicros: number;
  remainingMicros: number;
  requestsToday: number;
  requestLimit: number;
  wallet: {
    balanceMicros: number;
    creditedMicros: number;
    paidMicros: number;
    grantedMicros: number;
    spentMicros: number;
    overdrawnMicros: number;
    /** True once real money has been paid in, which lifts the daily rail. */
    funded: boolean;
    /** False until migration 0024 runs; top-ups cannot be recorded yet. */
    persisted: boolean;
  };
  allowed: boolean;
  refusal: WalletRefusal | null;
  /** What to show the person when the route is closed. */
  message: string | null;
}

export async function fundedUsageToday(admin: SupabaseClient<Database>, userId: string): Promise<FundedUsageToday> {
  const snapshot = await readWallet(admin, userId);
  return summariseWallet(snapshot);
}

export function summariseWallet(snapshot: WalletSnapshot): FundedUsageToday {
  const requestLimit = fundedDailyRequestLimit();
  const decision = walletDecision({
    balance: snapshot,
    spentTodayMicros: snapshot.todayMicros,
    requestsToday: snapshot.requestsToday,
    requestLimit,
  });

  return {
    spentMicros: decision.spentTodayMicros,
    capMicros: decision.capMicros,
    remainingMicros: decision.remainingTodayMicros,
    requestsToday: snapshot.requestsToday,
    requestLimit,
    wallet: {
      balanceMicros: snapshot.balanceMicros,
      creditedMicros: snapshot.creditedMicros,
      paidMicros: snapshot.paidMicros,
      grantedMicros: snapshot.grantedMicros,
      spentMicros: snapshot.spentMicros,
      overdrawnMicros: snapshot.overdrawnMicros,
      funded: snapshot.funded,
      persisted: snapshot.persisted,
    },
    allowed: decision.allowed,
    refusal: decision.refusal,
    message: decision.refusal ? walletRefusalMessage(decision.refusal, snapshot.funded) : null,
  };
}
