import type { LocalUsageObservationRow, UsageEventRow } from "@/lib/supabase/database.types";
import { VERIFICATION_COPY, type VerificationLevel } from "./tools";

/**
 * Tracked, verified, eligible: three numbers that are never one number.
 *
 *   TRACKED   what the user's devices reported. Analytics. Includes everything
 *             in local_usage_observations plus every trusted event, deduped so
 *             a local observation that was matched to a routed event is not
 *             counted twice.
 *   VERIFIED  tokens on usage_events with verification_status = confirmed.
 *             Only the server writes those rows.
 *   ELIGIBLE  eligible_compute_micros summed over confirmed events -- what the
 *             reward policy actually admitted. In micro-USD, because tokens
 *             are not a unit of value.
 *
 * Pure. Same function feeds the miner's HOME screen, the device page and the
 * dashboard panel, so the three can never disagree.
 */

export interface UsageSummary {
  day: string;
  trackedTokens: number;
  verifiedTokens: number;
  eligibleComputeMicros: number;
  recent: ActivityItem[];
}

export interface ActivityItem {
  at: string;
  tool: string;
  model: string | null;
  tokens: number;
  level: VerificationLevel;
  label: string;
  /** "tracked" | "verified" | "routed" -- the word a user sees. */
  status: "tracked" | "verified" | "routed";
}

function tokensOf(row: { input_tokens: number | null; output_tokens: number | null }): number {
  return (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
}

function statusFor(level: VerificationLevel): ActivityItem["status"] {
  if (level === "routed_confirmed") return "routed";
  if (level === "provider_correlated" || level === "provider_verified_import") return "verified";
  return "tracked";
}

/** Tool id for a trusted event: from the client type when it names a tool. */
function toolForEvent(event: UsageEventRow): string {
  const client = String(event.raw_metadata?.client_type ?? "");
  if (client === "claude-code" || client === "codex" || client === "gemini-cli") return client;
  return "usage-gateway";
}

export function summarizeUsage(input: {
  day: string;
  observations: readonly LocalUsageObservationRow[];
  events: readonly UsageEventRow[];
  /** Restrict trusted events to those the device produced, when known. */
  now?: Date;
}): UsageSummary {
  const sameDay = (iso: string) => iso.slice(0, 10) === input.day;

  const dayObservations = input.observations.filter((o) => sameDay(o.occurred_at));
  const dayEvents = input.events.filter((e) => sameDay(e.occurred_at));

  // Matched observations are the same compute as their event: count once.
  const unmatched = dayObservations.filter((o) => o.correlation_status !== "matched");
  const trackedTokens =
    unmatched.reduce((sum, o) => sum + tokensOf(o), 0) +
    dayEvents.reduce((sum, e) => sum + tokensOf(e), 0);

  const confirmed = dayEvents.filter((e) => e.verification_status === "confirmed");
  const verifiedTokens = confirmed.reduce((sum, e) => sum + tokensOf(e), 0);
  const eligibleComputeMicros = confirmed.reduce((sum, e) => sum + (e.eligible_compute_micros ?? 0), 0);

  const recent: ActivityItem[] = [
    ...unmatched.map((o) => {
      const level = o.verification_level as VerificationLevel;
      return {
        at: o.occurred_at,
        tool: o.tool_id,
        model: o.model,
        tokens: tokensOf(o),
        level,
        label: VERIFICATION_COPY[level].label,
        status: statusFor(level),
      };
    }),
    ...dayEvents.map((e) => {
      const level = (e.verification_level ?? "routed_confirmed") as VerificationLevel;
      return {
        at: e.occurred_at,
        tool: toolForEvent(e),
        model: e.model,
        tokens: tokensOf(e),
        level,
        label: VERIFICATION_COPY[level].label,
        status: statusFor(level),
      };
    }),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 20);

  return { day: input.day, trackedTokens, verifiedTokens, eligibleComputeMicros, recent };
}
