import { describe, expect, it } from "vitest";
import {
  LOCAL_AI_USAGE_COPY,
  LOCAL_OBSERVATION_COLUMNS,
  MAX_ROWS,
  PAGE_SIZE,
  boundedSinceDay,
  estimatedCost,
  loadLocalAiUsage,
  normalizeObservation,
  parseRange,
  productLabel,
  rangeDays,
  summarizeLocalAiUsage,
  summarizeVerifiedLane,
  tokenValue,
  type LocalObservationSlice,
  type VerifiedEventSlice,
} from "./local-ai-usage";
import { LOCAL_USAGE_LANE } from "./local-usage-lane";

/**
 * M17B -- the local subscription lane as analytics. Unknown stays unknown,
 * matched compute is counted once (in the verified lane), and nothing in a
 * local result can carry a reward other than the lane's own zero.
 */

const NOW = new Date("2026-09-17T15:30:00Z");

function obs(over: Partial<LocalObservationSlice> = {}): LocalObservationSlice {
  return {
    tool_id: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    occurred_at: "2026-09-17T10:00:00Z",
    input_tokens: 2,
    output_tokens: 18,
    cache_read_tokens: 28_726,
    cache_write_tokens: 33_033,
    reasoning_tokens: null,
    estimated_cost_micros: null,
    upstream_request_id: "req_1",
    local_session_id: "sess",
    correlation_status: "unmatched",
    ...over,
  };
}

function event(over: Partial<VerifiedEventSlice> = {}): VerifiedEventSlice {
  return {
    occurred_at: "2026-09-17T11:00:00Z",
    input_tokens: 500,
    cached_input_tokens: 100,
    output_tokens: 50,
    requests: 1,
    raw_metadata: { cache_write_tokens: 40, reasoning_tokens: 7 },
    verification_status: "confirmed",
    eligible_compute_micros: 2_500,
    correlation_status: "none",
    ...over,
  };
}

describe("ranges", () => {
  it("are UTC days, oldest first, today last", () => {
    expect(rangeDays("today", NOW)).toEqual(["2026-09-17"]);
    expect(rangeDays("7d", NOW)).toEqual(["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
    const thirty = rangeDays("30d", NOW);
    expect(thirty).toHaveLength(30);
    expect(thirty[0]).toBe("2026-08-19");
    expect(thirty.at(-1)).toBe("2026-09-17");
  });

  it("uses the UTC day even just after local midnight elsewhere", () => {
    expect(rangeDays("today", new Date("2026-09-17T23:59:59Z"))).toEqual(["2026-09-17"]);
    expect(rangeDays("today", new Date("2026-09-18T00:00:00Z"))).toEqual(["2026-09-18"]);
  });

  it("parses only the known values", () => {
    expect(parseRange("today")).toBe("today");
    expect(parseRange(["30d", "7d"])).toBe("30d");
    expect(parseRange("90d")).toBe("7d");
    expect(parseRange(undefined, "today")).toBe("today");
  });

  it("filters observations outside the range", () => {
    const rows = [obs(), obs({ occurred_at: "2026-09-16T23:59:59Z" }), obs({ occurred_at: "2026-09-11T00:00:00Z" }), obs({ occurred_at: "2026-09-10T23:59:59Z" })];
    expect(summarizeLocalAiUsage({ observations: rows, range: "today", now: NOW }).totals.requests).toBe(1);
    expect(summarizeLocalAiUsage({ observations: rows, range: "7d", now: NOW }).totals.requests).toBe(3);
    expect(summarizeLocalAiUsage({ observations: rows, range: "30d", now: NOW }).totals.requests).toBe(4);
  });

  it("never reads further back than 30 days", () => {
    expect(boundedSinceDay("2020-01-01", NOW)).toBe("2026-08-19");
    expect(boundedSinceDay("2026-09-17", NOW)).toBe("2026-09-17");
    expect(boundedSinceDay("not-a-day", NOW)).toBe("2026-08-19");
  });
});

describe("unknown is not zero", () => {
  it("keeps unreported categories null per row", () => {
    const row = normalizeObservation(obs({ cache_write_tokens: null, reasoning_tokens: null, estimated_cost_micros: null }));
    expect(row.usage).toEqual({ inputTokens: 2, outputTokens: 18, cacheReadTokens: 28_726, cacheWriteTokens: null, reasoningTokens: null });
    expect(row.estimatedCostMicros).toBeNull();
  });

  it("keeps a reported zero as zero", () => {
    expect(normalizeObservation(obs({ cache_write_tokens: 0 })).usage.cacheWriteTokens).toBe(0);
  });

  it("sums known values and reports '—' only when no row reported the category", () => {
    const report = summarizeLocalAiUsage({
      observations: [
        obs({ cache_write_tokens: null, reasoning_tokens: null }),
        obs({ tool_id: "codex", provider: "openai", model: "gpt-5-codex", cache_write_tokens: null, reasoning_tokens: 12, cache_read_tokens: null }),
      ],
      range: "today",
      now: NOW,
    });
    expect(tokenValue(report.totals, "cacheWriteTokens")).toBeNull();
    expect(report.totals.reported.cacheWriteTokens).toBe(0);
    expect(tokenValue(report.totals, "reasoningTokens")).toBe(12);
    expect(report.totals.reported.reasoningTokens).toBe(1);
    expect(tokenValue(report.totals, "cacheReadTokens")).toBe(28_726);
    expect(report.totals.reported.cacheReadTokens).toBe(1);
    const writes = report.byCategory.find((c) => c.category === "cacheWriteTokens");
    expect(writes).toEqual({ category: "cacheWriteTokens", label: "Cache write", value: null, reported: 0 });
  });

  it("shows a cost only when at least one row carried the tool's own estimate", () => {
    const none = summarizeLocalAiUsage({ observations: [obs()], range: "today", now: NOW });
    expect(estimatedCost(none.totals)).toBeNull();
    const some = summarizeLocalAiUsage({ observations: [obs({ estimated_cost_micros: 345_153 }), obs()], range: "today", now: NOW });
    expect(estimatedCost(some.totals)).toBe(345_153);
    expect(some.totals.costReported).toBe(1);
  });
});

describe("counted once", () => {
  it("excludes matched observations from local totals and says how many", () => {
    const report = summarizeLocalAiUsage({
      observations: [obs(), obs({ correlation_status: "matched", input_tokens: 9_999 }), obs({ correlation_status: "conflict" }), obs({ correlation_status: "none" })],
      range: "today",
      now: NOW,
    });
    expect(report.totals.requests).toBe(3);
    expect(report.totals.sums.inputTokens).toBe(6);
    expect(report.countedInVerified).toBe(1);
  });

  it("the verified lane counts the matched compute once and flags it as also observed locally", () => {
    const events = [event({ correlation_status: "matched" }), event(), event({ verification_status: "pending", input_tokens: 77 })];
    const verified = summarizeVerifiedLane({ events, range: "today", now: NOW });
    expect(verified.requests).toBe(2);
    expect(verified.inputTokens).toBe(1_000);
    expect(verified.cacheReadTokens).toBe(200);
    expect(verified.cacheWriteTokens).toBe(80);
    expect(verified.eligibleComputeMicros).toBe(5_000);
    expect(verified.alsoObservedLocally).toBe(1);

    // The same request seen from both sides: local 0, verified 1. Never 2.
    const one = summarizeVerifiedLane({ events: [event({ correlation_status: "matched" })], range: "today", now: NOW });
    const local = summarizeLocalAiUsage({ observations: [obs({ correlation_status: "matched", input_tokens: 500 })], range: "today", now: NOW });
    expect(local.totals.requests + one.requests).toBe(1);
    expect(local.totals.sums.inputTokens + one.inputTokens).toBe(500);
    expect(local.countedInVerified).toBe(1);
    expect(one.alsoObservedLocally).toBe(1);
  });
});

describe("grouping", () => {
  const rows = [
    obs(),
    obs({ model: "claude-sonnet-5", cache_read_tokens: 0, cache_write_tokens: 0 }),
    obs({ tool_id: "codex", provider: "openai", model: "gpt-5-codex", input_tokens: 1_000, output_tokens: 100, cache_read_tokens: 500, cache_write_tokens: null }),
    obs({ tool_id: "gemini-cli", provider: "google", model: null, input_tokens: 10, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null, occurred_at: "2026-09-15T08:00:00Z" }),
  ];
  const report = summarizeLocalAiUsage({ observations: rows, range: "7d", now: NOW });

  it("by tool, with the account a login belongs to and no plan tier", () => {
    expect(report.byTool.map((t) => [t.tool, t.toolName, t.product, t.totals.requests])).toEqual([
      ["claude-code", "Claude Code", "Claude account", 2],
      ["codex", "Codex", "ChatGPT account", 1],
      ["gemini-cli", "Gemini CLI", "Google account", 1],
    ]);
    expect(productLabel("claude-code")).toBe("Claude account");
    expect(productLabel("cursor")).toBeNull();
    for (const t of report.byTool) expect(t.product ?? "").not.toMatch(/max|pro|plus|ultra|team|enterprise/i);
  });

  it("by model, with unknown models kept as their own group", () => {
    expect(report.byModel.map((m) => [m.label, m.tools, m.totals.requests])).toEqual([
      ["claude-opus-5", ["claude-code"], 1],
      ["gpt-5-codex", ["codex"], 1],
      ["claude-sonnet-5", ["claude-code"], 1],
      ["Unknown model", ["gemini-cli"], 1],
    ]);
  });

  it("by day, including days with nothing", () => {
    expect(report.byDay).toHaveLength(7);
    expect(report.byDay.find((d) => d.day === "2026-09-15")?.totals.requests).toBe(1);
    expect(report.byDay.find((d) => d.day === "2026-09-17")?.totals.requests).toBe(3);
    expect(report.byDay.find((d) => d.day === "2026-09-16")?.totals.requests).toBe(0);
  });

  it("by token category", () => {
    expect(report.byCategory.map((c) => [c.label, c.value])).toEqual([
      ["Input", 1_014],
      ["Output", 137],
      ["Cache read", 29_226],
      ["Cache write", 33_033],
      ["Reasoning", null],
    ]);
  });
});

describe("no economic weight", () => {
  const ECONOMIC = /reward|eligib|claim|point|economic|score|mining|earn|payout/i;

  function economicEntries(value: unknown, path = "$"): Array<[string, unknown]> {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) => [
      ...(ECONOMIC.test(key) ? ([[`${path}.${key}`, child]] as Array<[string, unknown]>) : []),
      ...economicEntries(child, `${path}.${key}`),
    ]);
  }

  it("carries only the lane constants: reward 0, not claimable, no economic compute", () => {
    const report = summarizeLocalAiUsage({
      observations: [obs({ estimated_cost_micros: 1_000_000 }), obs({ tool_id: "codex", provider: "openai", model: null, input_tokens: 50_000_000 })],
      range: "30d",
      now: NOW,
    });
    expect(economicEntries(report)).toEqual([
      ["$.lane.economicCompute", "none"],
      ["$.lane.rewardPoints", 0],
      ["$.lane.claimable", false],
    ]);
    expect(report.lane).toEqual({
      source: LOCAL_USAGE_LANE.source,
      verification: LOCAL_USAGE_LANE.verification,
      economicCompute: LOCAL_USAGE_LANE.economicAuthority,
      rewardPoints: LOCAL_USAGE_LANE.reward,
      claimable: LOCAL_USAGE_LANE.claimable,
    });
  });

  it("every per-row view is local_only with reward 0", () => {
    const row = normalizeObservation(obs({ input_tokens: 99_000_000 }));
    expect(economicEntries(row)).toEqual([
      ["$.economicCompute", "none"],
      ["$.rewardPoints", 0],
      ["$.claimable", false],
    ]);
    expect(row.source).toBe("local_telemetry");
    expect(row.verification).toBe("local_only");
  });

  it("says what it is, in words that never claim mining or verification", () => {
    expect(LOCAL_AI_USAGE_COPY.note).toBe("Tracked on your device. Not independently verified for billing and does not earn Usage Points.");
    expect(LOCAL_AI_USAGE_COPY.costLabel).toBe("Tool-reported estimate (API-equivalent), not spend");
    expect(LOCAL_AI_USAGE_COPY.badge).toBe("LOCAL ONLY · REWARD 0");
    for (const text of Object.values(LOCAL_AI_USAGE_COPY)) expect(text).not.toMatch(/mining|mined|\bmine\b/i);
    for (const text of [LOCAL_AI_USAGE_COPY.title, LOCAL_AI_USAGE_COPY.chip, LOCAL_AI_USAGE_COPY.badge, LOCAL_AI_USAGE_COPY.live]) {
      expect(text).not.toMatch(/verified/i);
    }
  });

  it("selects no economic column from the observations table", () => {
    expect(LOCAL_OBSERVATION_COLUMNS).not.toMatch(ECONOMIC);
    expect(LOCAL_OBSERVATION_COLUMNS).not.toMatch(/prompt|response|signature|device_id|user_id/);
  });
});

describe("loader", () => {
  function fakeSupabase(total: number) {
    const calls: Array<{ table: string; columns: string; filters: Array<[string, string, unknown]>; range: [number, number] }> = [];
    const client = {
      from(table: string) {
        const call = { table, columns: "", filters: [] as Array<[string, string, unknown]>, range: [0, 0] as [number, number] };
        const builder = {
          select(columns: string) { call.columns = columns; return builder; },
          eq(column: string, value: unknown) { call.filters.push(["eq", column, value]); return builder; },
          gte(column: string, value: unknown) { call.filters.push(["gte", column, value]); return builder; },
          order() { return builder; },
          range(from: number, to: number) {
            call.range = [from, to];
            calls.push(call);
            const count = Math.max(0, Math.min(to, total - 1) - from + 1);
            return Promise.resolve({ data: Array.from({ length: count }, () => obs()), error: null });
          },
        };
        return builder;
      },
    };
    return { client: client as never, calls };
  }

  it("reads as the user, only the lane's columns, bounded to 30 days", async () => {
    const { client, calls } = fakeSupabase(3);
    const result = await loadLocalAiUsage(client, "user-1", "2020-01-01", NOW);
    expect(result).toMatchObject({ truncated: false });
    expect(result.observations).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("local_usage_observations");
    expect(calls[0].columns).toBe(LOCAL_OBSERVATION_COLUMNS);
    expect(calls[0].filters).toEqual([["eq", "user_id", "user-1"], ["gte", "occurred_at", "2026-08-19T00:00:00Z"]]);
  });

  it("paginates past PostgREST's 1000-row page", async () => {
    const { client, calls } = fakeSupabase(2_500);
    const result = await loadLocalAiUsage(client, "user-1", "2026-09-17", NOW);
    expect(result.observations).toHaveLength(2_500);
    expect(calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("stops at the row bound and says so", async () => {
    const { client, calls } = fakeSupabase(MAX_ROWS + 5);
    const result = await loadLocalAiUsage(client, "user-1", "2026-09-17", NOW);
    expect(result.truncated).toBe(true);
    expect(result.observations).toHaveLength(MAX_ROWS);
    expect(calls).toHaveLength(MAX_ROWS / PAGE_SIZE);
  });
});
