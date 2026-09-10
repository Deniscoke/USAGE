import type { LocalUsageObservationRow, UsageEventRow } from "@/lib/supabase/database.types";
import { VERIFICATION_COPY, type VerificationLevel } from "./tools";

/**
 * Tracked, verified, eligible: three numbers that are never one number --
 * and now each of the first two is a BREAKDOWN, never one number either.
 *
 *   TRACKED   what the user's devices reported. Analytics. Includes everything
 *             in local_usage_observations plus every trusted event, deduped so
 *             a local observation that was matched to a routed event is not
 *             counted twice.
 *   VERIFIED  usage on usage_events with verification_status = confirmed.
 *             Only the server writes those rows.
 *   ELIGIBLE  eligible_compute_micros summed over confirmed events -- what the
 *             reward policy actually admitted. In micro-USD, because tokens
 *             are not a unit of value.
 *
 * WHY A BREAKDOWN. The M13C acceptance request was 2 input, 18 output,
 * 28,726 cache-read and 33,033 cache-write tokens. Showing "20 tokens" was
 * true of two categories and silent about the two that were 3,000 times
 * larger. Input, output, cache read, cache write and reasoning are different
 * compute with different prices; they are kept apart here and shown apart.
 * `trackedTokens` / `verifiedTokens` remain as the FRESH total (input +
 * output) for callers that need one figure, and are named as such in the UI.
 *
 * Token totals are analytics. Mining never reads them: reward comes from
 * `eligible_compute_micros`, which the versioned pricing snapshot and reward
 * policy produced per event. Nothing here can change an economic value.
 *
 * Pure. Same function feeds the miner's HOME screen, the device page and the
 * dashboard panel, so the three can never disagree.
 */

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requestCount: number;
}

export const EMPTY_BREAKDOWN: UsageBreakdown = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  requestCount: 0,
};

export interface UsageSummary {
  day: string;
  /** Fresh tokens (input + output) reported by the device or a trusted event. */
  trackedTokens: number;
  /** Fresh tokens on confirmed events. */
  verifiedTokens: number;
  tracked: UsageBreakdown;
  verified: UsageBreakdown;
  eligibleComputeMicros: number;
  recent: ActivityItem[];
}

export interface ActivityItem {
  at: string;
  tool: string;
  model: string | null;
  /** Fresh tokens (input + output), for the one-line view. */
  tokens: number;
  breakdown: UsageBreakdown;
  level: VerificationLevel;
  label: string;
  /** "tracked" | "verified" | "routed" -- the word a user sees. */
  status: "tracked" | "verified" | "routed";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** An observation names every category in its own columns. */
export function breakdownOfObservation(row: LocalUsageObservationRow): UsageBreakdown {
  return {
    inputTokens: int(row.input_tokens),
    outputTokens: int(row.output_tokens),
    cacheReadTokens: int(row.cache_read_tokens),
    cacheWriteTokens: int(row.cache_write_tokens),
    reasoningTokens: int(row.reasoning_tokens),
    requestCount: 1,
  };
}

/**
 * A usage event stores fresh input, cached input and output as columns;
 * cache writes and reasoning live in the adapter's metadata. Reasoning is a
 * breakdown of output (already counted there), so it is reported, not added.
 */
export function breakdownOfEvent(row: UsageEventRow): UsageBreakdown {
  return {
    inputTokens: int(row.input_tokens),
    outputTokens: int(row.output_tokens),
    cacheReadTokens: int(row.cached_input_tokens),
    cacheWriteTokens: int(row.raw_metadata?.cache_write_tokens),
    reasoningTokens: int(row.raw_metadata?.reasoning_tokens),
    requestCount: int(row.requests) || 1,
  };
}

export function addBreakdown(a: UsageBreakdown, b: UsageBreakdown): UsageBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    requestCount: a.requestCount + b.requestCount,
  };
}

/** Fresh tokens: what was newly read and newly written, excluding cache traffic. */
export function freshTokens(b: UsageBreakdown): number {
  return b.inputTokens + b.outputTokens;
}

/** Every category, for a "total tokens" figure that is labelled as such. */
export function allTokens(b: UsageBreakdown): number {
  return b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
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
  now?: Date;
}): UsageSummary {
  const sameDay = (iso: string) => iso.slice(0, 10) === input.day;

  const dayObservations = input.observations.filter((o) => sameDay(o.occurred_at));
  const dayEvents = input.events.filter((e) => sameDay(e.occurred_at));

  // Matched observations are the same compute as their event: count once.
  // The event side wins because it is the trusted record; the observation's
  // categories are the device's view of the same request.
  const unmatched = dayObservations.filter((o) => o.correlation_status !== "matched");
  const tracked = [
    ...unmatched.map(breakdownOfObservation),
    ...dayEvents.map(breakdownOfEvent),
  ].reduce(addBreakdown, EMPTY_BREAKDOWN);

  const confirmed = dayEvents.filter((e) => e.verification_status === "confirmed");
  const verified = confirmed.map(breakdownOfEvent).reduce(addBreakdown, EMPTY_BREAKDOWN);
  const eligibleComputeMicros = confirmed.reduce((sum, e) => sum + (e.eligible_compute_micros ?? 0), 0);

  const recent: ActivityItem[] = [
    ...unmatched.map((o) => {
      const level = o.verification_level as VerificationLevel;
      const breakdown = breakdownOfObservation(o);
      return {
        at: o.occurred_at,
        tool: o.tool_id,
        model: o.model,
        tokens: freshTokens(breakdown),
        breakdown,
        level,
        label: VERIFICATION_COPY[level].label,
        status: statusFor(level),
      };
    }),
    ...dayEvents.map((e) => {
      const level = (e.verification_level ?? "routed_confirmed") as VerificationLevel;
      const breakdown = breakdownOfEvent(e);
      return {
        at: e.occurred_at,
        tool: toolForEvent(e),
        model: e.model,
        tokens: freshTokens(breakdown),
        breakdown,
        level,
        label: VERIFICATION_COPY[level].label,
        status: statusFor(level),
      };
    }),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 20);

  return {
    day: input.day,
    trackedTokens: freshTokens(tracked),
    verifiedTokens: freshTokens(verified),
    tracked,
    verified,
    eligibleComputeMicros,
    recent,
  };
}
