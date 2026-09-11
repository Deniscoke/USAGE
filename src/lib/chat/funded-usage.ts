import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { OPENROUTER_GATEWAY_ID } from "@/lib/compute/openrouter-gateway";
import { VERCEL_COMPUTE_GATEWAY_ID } from "@/lib/compute/vercel-gateway";
import {
  fundedDailyCapMicros,
  fundedDailyRequestLimit,
  fundedSpendDecision,
  utcDayStart,
  withinRequestBudget,
} from "./spend";

/**
 * What this account has already spent of USAGE's money today.
 *
 * Read from the persisted units -- the same rows everything else is measured
 * from -- never from a counter the chat keeps for itself. Both USAGE-funded
 * gateways count, whichever surface produced the traffic: the miner's fallback
 * and the chat's shared route draw on the same balance.
 */
export interface FundedUsageToday {
  spentMicros: number;
  capMicros: number;
  remainingMicros: number;
  requestsToday: number;
  requestLimit: number;
  allowed: boolean;
}

export async function fundedUsageToday(admin: SupabaseClient<Database>, userId: string): Promise<FundedUsageToday> {
  const { data } = await admin
    .from("usage_events")
    .select("actual_cost_micros")
    .eq("user_id", userId)
    .in("gateway_id", [OPENROUTER_GATEWAY_ID, VERCEL_COMPUTE_GATEWAY_ID])
    .gte("occurred_at", utcDayStart());

  const rows = (data ?? []) as { actual_cost_micros: number | null }[];
  const spentMicros = rows.reduce((sum, row) => sum + Math.max(0, row.actual_cost_micros ?? 0), 0);
  const decision = fundedSpendDecision({ spentMicros, capMicros: fundedDailyCapMicros() });
  const requestLimit = fundedDailyRequestLimit();

  return {
    spentMicros: decision.spentMicros,
    capMicros: decision.capMicros,
    remainingMicros: decision.remainingMicros,
    requestsToday: rows.length,
    requestLimit,
    allowed: decision.allowed && withinRequestBudget(rows.length, requestLimit),
  };
}
