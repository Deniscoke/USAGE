import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { ingestDemoUsage, ingestRecords, type IngestStore } from "./ingest";
import { MICROS_PER_USD, usdStringToMicros } from "@/lib/domain/money";
import { CURRENT_SCORING_VERSION } from "@/lib/domain/scoring";
import type { NormalizedUsageRecord } from "@/lib/domain/types";

/**
 * Integration tests against a real Postgres (PGlite) running the project's
 * actual migrations. These cover the claims that unit tests cannot: that the
 * schema enforces idempotency, that money survives a round trip exactly, and
 * that aggregation and scoring are derived from stored rows.
 */

const NOW = new Date("2026-03-15T12:00:00.000Z");

let db: TestDb;
let store: IngestStore;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  store = createSqlIngestStore(db);
  userId = await db.createUser("owner@example.com");
}, 90_000);

afterAll(async () => {
  await db?.close();
});

async function count(table: string, id: string = userId): Promise<number> {
  const rows = await db.asServiceRole<{ n: string }>(
    `select count(*)::text as n from ${table} where user_id = $1`,
    [id],
  );
  return Number(rows[0].n);
}

describe("demo ingestion through the real pipeline", () => {
  it("persists normalized events, aggregates and scores", async () => {
    const summary = await ingestDemoUsage(store, { userId, now: NOW, historyDays: 10 });

    expect(summary.fetched).toBeGreaterThan(0);
    expect(summary.inserted).toBe(summary.fetched);
    expect(summary.failures).toEqual([]);

    expect(await count("usage_events")).toBe(summary.inserted);
    expect(await count("usage_daily_aggregates")).toBeGreaterThan(0);
    expect(await count("score_records")).toBe(summary.daysRecomputed);

    const providers = await db.asServiceRole<{ provider: string }>(
      `select distinct provider from usage_events where user_id = $1 order by provider`,
      [userId],
    );
    expect(providers.map((row) => row.provider)).toEqual([
      "demo-cli",
      "demo-gateway",
      "demo-provider",
    ]);
  });

  it("is idempotent: re-importing the same window stores no duplicates", async () => {
    const before = await count("usage_events");
    const summary = await ingestDemoUsage(store, { userId, now: NOW, historyDays: 10 });

    expect(summary.inserted).toBe(0);
    expect(summary.duplicates).toBe(summary.fetched);
    expect(await count("usage_events")).toBe(before);
  });

  it("keeps each connection's events linked to a provider_connection row", async () => {
    const rows = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_events
       where user_id = $1 and connection_id is null`,
      [userId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("derives aggregates that match the stored events exactly", async () => {
    const [aggregate] = await db.asServiceRole<{ cost: string; requests: string }>(
      `select sum(cost_micros)::text as cost, sum(requests)::text as requests
       from usage_daily_aggregates where user_id = $1`,
      [userId],
    );
    const [events] = await db.asServiceRole<{ cost: string; requests: string }>(
      `select sum(normalized_cost_micros)::text as cost, sum(requests)::text as requests
       from usage_events where user_id = $1`,
      [userId],
    );
    expect(aggregate.cost).toBe(events.cost);
    expect(aggregate.requests).toBe(events.requests);
  });

  it("stores the algorithm version alongside every score", async () => {
    const versions = await db.asServiceRole<{ algorithm_version: string }>(
      `select distinct algorithm_version from score_records where user_id = $1`,
      [userId],
    );
    expect(versions).toEqual([{ algorithm_version: CURRENT_SCORING_VERSION }]);
  });
});

describe("money precision", () => {
  function record(overrides: Partial<NormalizedUsageRecord>): NormalizedUsageRecord {
    return {
      provider: "demo-provider",
      source: "provider_usage_api",
      externalReference: "money-1",
      model: "demo-large",
      occurredAt: "2026-02-01T09:00:00.000Z",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      requests: 1,
      actualCostMicros: 1,
      normalizedCostMicros: 1,
      verificationType: "verified",
      verificationStatus: "confirmed",
      rawMetadata: {},
      ...overrides,
    };
  }

  it("round-trips exact micro-USD values through the database", async () => {
    const precisionUser = await db.createUser("precision@example.com");
    const amounts = [
      usdStringToMicros("0.000001"),
      usdStringToMicros("0.1"),
      usdStringToMicros("1234.567891"),
      9_007_199_254_740, // ~9M USD in micros, still an exact integer
    ];

    await ingestRecords(
      store,
      precisionUser,
      amounts.map((micros, index) =>
        record({
          externalReference: `money-${index}`,
          actualCostMicros: micros,
          normalizedCostMicros: micros,
        }),
      ),
    );

    const rows = await db.asServiceRole<{ normalized_cost_micros: string }>(
      `select normalized_cost_micros::text from usage_events
       where user_id = $1 order by external_reference`,
      [precisionUser],
    );
    expect(rows.map((row) => row.normalized_cost_micros)).toEqual(amounts.map(String));

    // Summing in the database must equal summing the integers in JS.
    const [total] = await db.asServiceRole<{ total: string }>(
      `select sum(normalized_cost_micros)::text as total from usage_events where user_id = $1`,
      [precisionUser],
    );
    expect(total.total).toBe(String(amounts.reduce((acc, value) => acc + value, 0)));
  });

  it("stores three tenths of a dollar as exactly 300000 micros", async () => {
    const driftUser = await db.createUser("drift@example.com");
    const tenth = usdStringToMicros("0.1");

    await ingestRecords(
      store,
      driftUser,
      [0, 1, 2].map((index) =>
        record({
          externalReference: `drift-${index}`,
          actualCostMicros: tenth,
          normalizedCostMicros: tenth,
        }),
      ),
    );

    const [row] = await db.asServiceRole<{ total: string }>(
      `select sum(normalized_cost_micros)::text as total from usage_events where user_id = $1`,
      [driftUser],
    );
    expect(row.total).toBe(String(0.3 * MICROS_PER_USD));
    expect(Number(row.total)).toBe(300_000);
  });
});

describe("scoring over persisted usage", () => {
  it("scores verified usage and ignores reported usage economically", async () => {
    const scoreUser = await db.createUser("scores@example.com");
    const day = "2026-02-10";

    await ingestRecords(store, scoreUser, [
      {
        provider: "demo-provider",
        source: "provider_usage_api",
        externalReference: "v-1",
        model: "demo-large",
        occurredAt: `${day}T10:00:00.000Z`,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        requests: 1,
        actualCostMicros: 100 * MICROS_PER_USD,
        normalizedCostMicros: 100 * MICROS_PER_USD,
        verificationType: "verified",
        verificationStatus: "confirmed",
        rawMetadata: {},
      },
      {
        provider: "demo-cli",
        source: "local_client",
        externalReference: "r-1",
        model: "demo-large",
        occurredAt: `${day}T11:00:00.000Z`,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        requests: 1,
        actualCostMicros: null,
        normalizedCostMicros: 900 * MICROS_PER_USD,
        verificationType: "reported",
        verificationStatus: "unverifiable",
        rawMetadata: {},
      },
    ]);

    const [score] = await db.asServiceRole<{
      points: string;
      weighted_cost_micros: string;
      excluded_cost_micros: string;
    }>(
      `select points::text, weighted_cost_micros::text, excluded_cost_micros::text
       from score_records where user_id = $1 and day = $2`,
      [scoreUser, day],
    );

    // sqrt(100) * 1000 — the $900 of reported usage contributes nothing.
    expect(Number(score.points)).toBe(10_000);
    expect(score.weighted_cost_micros).toBe(String(100 * MICROS_PER_USD));
    expect(score.excluded_cost_micros).toBe(String(900 * MICROS_PER_USD));
  });

  it("cannot be gamed by splitting one day into many small events", async () => {
    const splitter = await db.createUser("splitter@example.com");
    const whole = await db.createUser("whole@example.com");
    const day = "2026-02-11";

    const base = {
      provider: "demo-provider" as const,
      source: "provider_usage_api" as const,
      model: "demo-large",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      requests: 1,
      verificationType: "verified" as const,
      verificationStatus: "confirmed" as const,
      rawMetadata: {},
    };

    await ingestRecords(
      store,
      splitter,
      Array.from({ length: 64 }, (_, index) => ({
        ...base,
        externalReference: `split-${index}`,
        occurredAt: `${day}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        actualCostMicros: MICROS_PER_USD,
        normalizedCostMicros: MICROS_PER_USD,
      })),
    );

    await ingestRecords(store, whole, [
      {
        ...base,
        externalReference: "whole-1",
        occurredAt: `${day}T10:00:00.000Z`,
        actualCostMicros: 64 * MICROS_PER_USD,
        normalizedCostMicros: 64 * MICROS_PER_USD,
      },
    ]);

    const points = async (id: string) => {
      const rows = await db.asServiceRole<{ points: string }>(
        `select points::text from score_records where user_id = $1 and day = $2`,
        [id, day],
      );
      return Number(rows[0].points);
    };

    expect(await points(splitter)).toBe(await points(whole));
    expect(await points(whole)).toBe(8_000); // sqrt(64) * 1000
  });
});
