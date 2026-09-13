import { describe, expect, it, vi } from "vitest";

// The store is server-only; the guard package throws outside a server bundle.
vi.mock("server-only", () => ({}));
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fundedSpend } from "./store";

/**
 * Spend is summed over EVERY funded row, however many there are.
 *
 * PostgREST caps a response at 1,000 rows. The query used to take whatever the
 * first response held, so an account past a thousand funded requests stopped
 * seeing its balance fall and its daily cap close.
 */

type Row = { id: string; actual_cost_micros: number | null; occurred_at: string };

function fakeAdmin(rows: Row[], options: { failOnPage?: number } = {}) {
  let calls = 0;
  const chain = {
    range(from: number, to: number) {
      calls += 1;
      if (options.failOnPage === calls) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    },
  };
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order"]) builder[method] = () => builder;
  builder.range = chain.range;
  return { admin: { from: () => builder } as unknown as SupabaseClient<Database>, calls: () => calls };
}

const today = new Date().toISOString();
const old = "2026-01-01T00:00:00.000Z";

describe("fundedSpend", () => {
  it("adds up every row past the 1,000-row response limit", async () => {
    const rows: Row[] = Array.from({ length: 2_350 }, (_, i) => ({ id: String(i).padStart(6, "0"), actual_cost_micros: 10, occurred_at: old }));
    const { admin, calls } = fakeAdmin(rows);
    const spend = await fundedSpend(admin, "user-1");
    expect(spend.lifetimeMicros).toBe(23_500);
    expect(calls()).toBe(3);
  });

  it("still separates today from before", async () => {
    const rows: Row[] = [
      { id: "1", actual_cost_micros: 100, occurred_at: old },
      { id: "2", actual_cost_micros: 40, occurred_at: today },
      { id: "3", actual_cost_micros: null, occurred_at: today },
    ];
    const spend = await fundedSpend(fakeAdmin(rows).admin, "user-1");
    expect(spend.lifetimeMicros).toBe(140);
    expect(spend.todayMicros).toBe(40);
    expect(spend.requestsToday).toBe(2);
  });

  it("refuses to report zero when a page could not be read, because zero would reopen the route", async () => {
    const rows: Row[] = Array.from({ length: 1_500 }, (_, i) => ({ id: String(i), actual_cost_micros: 1, occurred_at: old }));
    await expect(fundedSpend(fakeAdmin(rows, { failOnPage: 2 }).admin, "user-1")).rejects.toThrow(/fundedSpend/);
  });
});
