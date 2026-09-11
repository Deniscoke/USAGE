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
import { creditDecision, startingCreditMicros } from "./credit";

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
  /** The starting grant: the same for every account, counted down for life. */
  credit: { grantMicros: number; spentMicros: number; remainingMicros: number };
  allowed: boolean;
  /** Why the shared route is closed, when it is. */
  refusal: "credit" | "daily_cap" | "daily_requests" | null;
}

export async function fundedUsageToday(admin: SupabaseClient<Database>, userId: string): Promise<FundedUsageToday> {
  // One read of everything this account ever cost USAGE; today is a filter
  // over it. Both ceilings come from the same rows.
  const { data } = await admin
    .from("usage_events")
    .select("actual_cost_micros, occurred_at")
    .eq("user_id", userId)
    .in("gateway_id", [OPENROUTER_GATEWAY_ID, VERCEL_COMPUTE_GATEWAY_ID]);

  const rows = (data ?? []) as { actual_cost_micros: number | null; occurred_at: string }[];
  const cost = (row: { actual_cost_micros: number | null }) => Math.max(0, row.actual_cost_micros ?? 0);
  const dayStart = utcDayStart();
  const today = rows.filter((row) => row.occurred_at >= dayStart);

  const lifetime = creditDecision({ grantMicros: startingCreditMicros(), spentLifetimeMicros: rows.reduce((s, r) => s + cost(r), 0) });
  const daily = fundedSpendDecision({ spentMicros: today.reduce((s, r) => s + cost(r), 0), capMicros: fundedDailyCapMicros() });
  const requestLimit = fundedDailyRequestLimit();
  const requestsOk = withinRequestBudget(today.length, requestLimit);

  const refusal: FundedUsageToday["refusal"] = !lifetime.allowed ? "credit" : !daily.allowed ? "daily_cap" : !requestsOk ? "daily_requests" : null;

  return {
    spentMicros: daily.spentMicros,
    capMicros: daily.capMicros,
    remainingMicros: daily.remainingMicros,
    requestsToday: today.length,
    requestLimit,
    credit: { grantMicros: lifetime.grantMicros, spentMicros: lifetime.spentMicros, remainingMicros: lifetime.remainingMicros },
    allowed: refusal === null,
    refusal,
  };
}
