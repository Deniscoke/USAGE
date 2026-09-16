import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, LocalUsageObservationRow, UsageEventRow } from "@/lib/supabase/database.types";
import { LOCAL_USAGE_LANE } from "./local-usage-lane";
import { LOCAL_TOOLS } from "./tools";
import { breakdownOfEvent } from "./usage-summary";

/**
 * Local AI usage (M17B): the subscription lane as a product.
 *
 * What a person's Claude Code, Codex and Gemini CLI reported through USAGE
 * Miner, normalized, grouped and ranged -- and nothing else. Every figure in
 * this file is analytics. It has no path into Economic Compute: it reads
 * `local_usage_observations`, which carries no economic column, and it never
 * reads a price, an eligibility or a score.
 *
 * Two rules shape the arithmetic:
 *
 *   UNKNOWN IS NOT ZERO. A tool that does not report cache writes has not
 *   reported zero cache writes. Per row an unreported category stays null;
 *   in a sum the known values are added and a per-category `reported` count
 *   says how many rows contributed, so a surface can print "—" when none did.
 *
 *   COUNTED ONCE. An observation whose provider request id matched a trusted
 *   usage_event (correlation_status = 'matched') is the same compute as that
 *   event. It belongs to the verified lane and is excluded here. The verified
 *   side exposes how many of its events were also observed locally.
 *
 * Days are UTC, like the rest of the product.
 */

// ---------------------------------------------------------------------------
// Copy -- one wording for every surface that shows this lane

export const LOCAL_AI_USAGE_COPY = {
  title: "Local AI usage",
  chip: "LOCAL ONLY",
  badge: "LOCAL ONLY · REWARD 0",
  note: "Tracked on your device. Not independently verified for billing and does not earn Usage Points.",
  costLabel: "Tool-reported estimate (API-equivalent), not spend",
  live: "TRACKING LIVE",
} as const;

// ---------------------------------------------------------------------------
// Ranges

export const USAGE_RANGES = ["today", "7d", "30d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const RANGE_LABEL: Record<UsageRange, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const RANGE_DAYS: Record<UsageRange, number> = { today: 1, "7d": 7, "30d": 30 };

/** The longest range any loader reads. */
export const MAX_RANGE_DAYS = 30;

export function parseRange(value: unknown, fallback: UsageRange = "7d"): UsageRange {
  const raw = Array.isArray(value) ? value[0] : value;
  return (USAGE_RANGES as readonly unknown[]).includes(raw) ? (raw as UsageRange) : fallback;
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The UTC days a range covers, oldest first, today last. */
export function rangeDays(range: UsageRange, now: Date): string[] {
  const count = RANGE_DAYS[range];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, index) => utcDay(new Date(today - (count - 1 - index) * 86_400_000)));
}

export function rangeSinceDay(range: UsageRange, now: Date): string {
  return rangeDays(range, now)[0];
}

// ---------------------------------------------------------------------------
// Per-observation view

/**
 * The product each tool's subscription usage comes from. A login, not a plan:
 * USAGE cannot see which tier the account is on and does not guess.
 */
export const LOCAL_TOOL_PRODUCT: Record<string, string> = {
  "claude-code": "Claude account",
  codex: "ChatGPT account",
  "gemini-cli": "Google account",
};

export function productLabel(tool: string): string | null {
  return LOCAL_TOOL_PRODUCT[tool] ?? null;
}

export function toolDisplayName(tool: string): string {
  return LOCAL_TOOLS[tool]?.displayName ?? tool;
}

export const TOKEN_CATEGORIES = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export const TOKEN_CATEGORY_LABEL: Record<TokenCategory, string> = {
  inputTokens: "Input",
  outputTokens: "Output",
  cacheReadTokens: "Cache read",
  cacheWriteTokens: "Cache write",
  reasoningTokens: "Reasoning",
};

export type LocalTokenUsage = Record<TokenCategory, number | null>;

/** Exactly the columns the local lane reads. Nothing economic exists to select. */
export const LOCAL_OBSERVATION_COLUMNS =
  "tool_id, provider, model, occurred_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_micros, upstream_request_id, local_session_id, correlation_status" as const;

export type LocalObservationSlice = Pick<
  LocalUsageObservationRow,
  | "tool_id"
  | "provider"
  | "model"
  | "occurred_at"
  | "input_tokens"
  | "output_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens"
  | "reasoning_tokens"
  | "estimated_cost_micros"
  | "upstream_request_id"
  | "local_session_id"
  | "correlation_status"
>;

export interface LocalAiUsage {
  tool: string;
  provider: string;
  model: string | null;
  occurredAt: string;
  usage: LocalTokenUsage;
  /** What the tool itself estimated, API-equivalent. Never a price USAGE computed, never spend. */
  estimatedCostMicros: number | null;
  requestId: string | null;
  /** The tool's local session id. */
  sessionId: string;
  source: typeof LOCAL_USAGE_LANE.source;
  verification: typeof LOCAL_USAGE_LANE.verification;
  economicCompute: typeof LOCAL_USAGE_LANE.economicAuthority;
  rewardPoints: typeof LOCAL_USAGE_LANE.reward;
  claimable: typeof LOCAL_USAGE_LANE.claimable;
}

/** A count, or null when the tool did not report one. Never a synthesized 0. */
function known(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function normalizeObservation(row: LocalObservationSlice): LocalAiUsage {
  return {
    tool: row.tool_id,
    provider: row.provider,
    model: row.model,
    occurredAt: row.occurred_at,
    usage: {
      inputTokens: known(row.input_tokens),
      outputTokens: known(row.output_tokens),
      cacheReadTokens: known(row.cache_read_tokens),
      cacheWriteTokens: known(row.cache_write_tokens),
      reasoningTokens: known(row.reasoning_tokens),
    },
    estimatedCostMicros: known(row.estimated_cost_micros),
    requestId: row.upstream_request_id,
    sessionId: row.local_session_id,
    source: LOCAL_USAGE_LANE.source,
    verification: LOCAL_USAGE_LANE.verification,
    economicCompute: LOCAL_USAGE_LANE.economicAuthority,
    rewardPoints: LOCAL_USAGE_LANE.reward,
    claimable: LOCAL_USAGE_LANE.claimable,
  };
}

/** Matched observations are the verified lane's; everything else is local. */
export function isCountedLocally(row: Pick<LocalUsageObservationRow, "correlation_status">): boolean {
  return row.correlation_status !== "matched";
}

// ---------------------------------------------------------------------------
// Sums

export interface LocalTokenTotals {
  requests: number;
  /** Sum of the known values per category. Read with `tokenValue` to respect unknowns. */
  sums: Record<TokenCategory, number>;
  /** How many rows reported each category. 0 means unknown, not zero. */
  reported: Record<TokenCategory, number>;
  estimatedCostMicros: number;
  /** Rows that carried a tool-emitted cost estimate. */
  costReported: number;
}

function zeroCategories(): Record<TokenCategory, number> {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export function emptyTotals(): LocalTokenTotals {
  return { requests: 0, sums: zeroCategories(), reported: zeroCategories(), estimatedCostMicros: 0, costReported: 0 };
}

function addUsage(totals: LocalTokenTotals, row: LocalAiUsage): void {
  totals.requests += 1;
  for (const category of TOKEN_CATEGORIES) {
    const value = row.usage[category];
    if (value === null) continue;
    totals.sums[category] += value;
    totals.reported[category] += 1;
  }
  if (row.estimatedCostMicros !== null) {
    totals.estimatedCostMicros += row.estimatedCostMicros;
    totals.costReported += 1;
  }
}

/** The category's total, or null when no row reported it. */
export function tokenValue(totals: LocalTokenTotals, category: TokenCategory): number | null {
  return totals.reported[category] > 0 ? totals.sums[category] : null;
}

/** Input + output, from what was reported. */
export function freshTotal(totals: LocalTokenTotals): number {
  return totals.sums.inputTokens + totals.sums.outputTokens;
}

/** Cache read + cache write, from what was reported. */
export function cacheTotal(totals: LocalTokenTotals): number {
  return totals.sums.cacheReadTokens + totals.sums.cacheWriteTokens;
}

/** The tool-reported estimate, only when at least one row carried one. */
export function estimatedCost(totals: LocalTokenTotals): number | null {
  return totals.costReported > 0 ? totals.estimatedCostMicros : null;
}

// ---------------------------------------------------------------------------
// The report

export interface LocalToolGroup {
  tool: string;
  toolName: string;
  product: string | null;
  totals: LocalTokenTotals;
}

export interface LocalModelGroup {
  model: string | null;
  label: string;
  tools: string[];
  totals: LocalTokenTotals;
}

export interface LocalCategoryRow {
  category: TokenCategory;
  label: string;
  value: number | null;
  reported: number;
}

export interface LocalDayRow {
  day: string;
  totals: LocalTokenTotals;
}

export interface LocalAiUsageReport {
  range: UsageRange;
  days: string[];
  lane: {
    source: typeof LOCAL_USAGE_LANE.source;
    verification: typeof LOCAL_USAGE_LANE.verification;
    economicCompute: typeof LOCAL_USAGE_LANE.economicAuthority;
    rewardPoints: typeof LOCAL_USAGE_LANE.reward;
    claimable: typeof LOCAL_USAGE_LANE.claimable;
  };
  totals: LocalTokenTotals;
  byTool: LocalToolGroup[];
  byModel: LocalModelGroup[];
  byCategory: LocalCategoryRow[];
  byDay: LocalDayRow[];
  /** Observations in range left out because the verified lane already counts them. */
  countedInVerified: number;
  /** The loader hit its row bound; totals are a lower bound. */
  truncated: boolean;
}

function byTotalsDescending<T extends { totals: LocalTokenTotals }>(a: T, b: T): number {
  const tokens = (t: LocalTokenTotals) => freshTotal(t) + cacheTotal(t);
  return tokens(b.totals) - tokens(a.totals) || b.totals.requests - a.totals.requests;
}

export function summarizeLocalAiUsage(input: {
  observations: readonly LocalObservationSlice[];
  range: UsageRange;
  now: Date;
  truncated?: boolean;
}): LocalAiUsageReport {
  const days = rangeDays(input.range, input.now);
  const inRange = new Set(days);
  const totals = emptyTotals();
  const tools = new Map<string, LocalToolGroup>();
  const models = new Map<string, LocalModelGroup>();
  const dayTotals = new Map<string, LocalTokenTotals>(days.map((day) => [day, emptyTotals()]));
  let countedInVerified = 0;

  for (const row of input.observations) {
    const day = row.occurred_at.slice(0, 10);
    if (!inRange.has(day)) continue;
    if (!isCountedLocally(row)) {
      countedInVerified += 1;
      continue;
    }
    const usage = normalizeObservation(row);
    addUsage(totals, usage);

    let tool = tools.get(usage.tool);
    if (!tool) {
      tool = { tool: usage.tool, toolName: toolDisplayName(usage.tool), product: productLabel(usage.tool), totals: emptyTotals() };
      tools.set(usage.tool, tool);
    }
    addUsage(tool.totals, usage);

    const modelKey = usage.model ?? "";
    let model = models.get(modelKey);
    if (!model) {
      model = { model: usage.model, label: usage.model ?? "Unknown model", tools: [], totals: emptyTotals() };
      models.set(modelKey, model);
    }
    if (!model.tools.includes(usage.tool)) model.tools.push(usage.tool);
    addUsage(model.totals, usage);

    addUsage(dayTotals.get(day)!, usage);
  }

  return {
    range: input.range,
    days,
    lane: {
      source: LOCAL_USAGE_LANE.source,
      verification: LOCAL_USAGE_LANE.verification,
      economicCompute: LOCAL_USAGE_LANE.economicAuthority,
      rewardPoints: LOCAL_USAGE_LANE.reward,
      claimable: LOCAL_USAGE_LANE.claimable,
    },
    totals,
    byTool: [...tools.values()].sort(byTotalsDescending),
    byModel: [...models.values()].sort(byTotalsDescending),
    byCategory: TOKEN_CATEGORIES.map((category) => ({
      category,
      label: TOKEN_CATEGORY_LABEL[category],
      value: tokenValue(totals, category),
      reported: totals.reported[category],
    })),
    byDay: days.map((day) => ({ day, totals: dayTotals.get(day)! })),
    countedInVerified,
    truncated: input.truncated ?? false,
  };
}

// ---------------------------------------------------------------------------
// The verified lane, for the same range, kept apart

export const VERIFIED_EVENT_COLUMNS =
  "occurred_at, input_tokens, cached_input_tokens, output_tokens, requests, raw_metadata, verification_status, eligible_compute_micros, correlation_status" as const;

export type VerifiedEventSlice = Pick<
  UsageEventRow,
  | "occurred_at"
  | "input_tokens"
  | "cached_input_tokens"
  | "output_tokens"
  | "requests"
  | "raw_metadata"
  | "verification_status"
  | "eligible_compute_micros"
  | "correlation_status"
>;

export interface VerifiedLaneTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** From the persisted reward policy per event; never derived from tokens here. */
  eligibleComputeMicros: number;
  /** Confirmed events a device also reported: counted here, once, and not in local totals. */
  alsoObservedLocally: number;
  truncated: boolean;
}

/**
 * Confirmed usage_events only -- the records the server wrote itself. Token
 * categories come from the same `breakdownOfEvent` the device views use.
 */
export function summarizeVerifiedLane(input: {
  events: readonly VerifiedEventSlice[];
  range: UsageRange;
  now: Date;
  truncated?: boolean;
}): VerifiedLaneTotals {
  const inRange = new Set(rangeDays(input.range, input.now));
  const out: VerifiedLaneTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    eligibleComputeMicros: 0,
    alsoObservedLocally: 0,
    truncated: input.truncated ?? false,
  };
  for (const event of input.events) {
    if (event.verification_status !== "confirmed") continue;
    if (!inRange.has(event.occurred_at.slice(0, 10))) continue;
    const b = breakdownOfEvent(event);
    out.requests += b.requestCount;
    out.inputTokens += b.inputTokens;
    out.outputTokens += b.outputTokens;
    out.cacheReadTokens += b.cacheReadTokens;
    out.cacheWriteTokens += b.cacheWriteTokens;
    out.reasoningTokens += b.reasoningTokens;
    out.eligibleComputeMicros += event.eligible_compute_micros ?? 0;
    if (event.correlation_status === "matched") out.alsoObservedLocally += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loaders -- as the signed-in user, so RLS decides what comes back

/** PostgREST returns at most 1000 rows per request by default. */
export const PAGE_SIZE = 1000;
/** Hard ceiling per load. Past it the report says `truncated`. */
export const MAX_ROWS = 20_000;

/** Never read further back than the longest range. */
export function boundedSinceDay(sinceDay: string, now: Date): string {
  const floor = rangeSinceDay("30d", now);
  return /^\d{4}-\d{2}-\d{2}$/.test(sinceDay) && sinceDay > floor ? sinceDay : floor;
}

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

async function paginate<T>(fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`local usage load failed: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function loadLocalAiUsage(
  supabase: SupabaseClient<Database>,
  userId: string,
  sinceDay: string,
  now: Date = new Date(),
): Promise<{ observations: LocalObservationSlice[]; truncated: boolean }> {
  const since = `${boundedSinceDay(sinceDay, now)}T00:00:00Z`;
  const { rows, truncated } = await paginate<LocalObservationSlice>((from, to) =>
    supabase
      .from("local_usage_observations")
      .select(LOCAL_OBSERVATION_COLUMNS)
      .eq("user_id", userId)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as PromiseLike<PageResult<LocalObservationSlice>>,
  );
  return { observations: rows, truncated };
}

export async function loadVerifiedLane(
  supabase: SupabaseClient<Database>,
  userId: string,
  sinceDay: string,
  now: Date = new Date(),
): Promise<{ events: VerifiedEventSlice[]; truncated: boolean }> {
  const since = `${boundedSinceDay(sinceDay, now)}T00:00:00Z`;
  const { rows, truncated } = await paginate<VerifiedEventSlice>((from, to) =>
    supabase
      .from("usage_events")
      .select(VERIFIED_EVENT_COLUMNS)
      .eq("user_id", userId)
      .eq("verification_status", "confirmed")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as PromiseLike<PageResult<VerifiedEventSlice>>,
  );
  return { events: rows, truncated };
}
