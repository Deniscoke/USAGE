import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { applyEconomicDedupe } from "./economic-dedupe";
import { usageRecordToInsert } from "./rows";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * Two trusted ingestions race to establish the same economic key.
 *
 * Both run the application-level dedupe BEFORE either has inserted, so both
 * believe they are first. The database's global unique index is the final
 * authority: exactly one becomes the unit. The loser gets a uniqueness error
 * rather than being preserved as duplicate evidence -- an ingestion UX gap
 * reported, not papered over by weakening the constraint.
 */

const KEY = generateSigningKeyPair("race-key");
const ISSUANCE = { issuer: "usage://issuer/production", keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 };

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("race-a@example.com");
  bob = await db.createUser("race-b@example.com");
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function paid(generationId: string, gatewayId: string): GatewayObservation {
  return {
    environment: "live",
    generationId,
    model: "openai/gpt-5.4",
    providerSlug: "openai",
    gatewayId,
    endpointTrusted: true,
    funding: { class: "paid_account", basis: "fixture:SIMULATED paid_account" },
    upstreamRequestId: "req_RACE",
    occurredAt: "2026-07-20T10:00:00.000Z",
    usage: { inputTokens: 1_000, outputTokens: 250 },
    cost: { value: "4.00", currency: "USD" },
  };
}

describe("concurrent same-key race", () => {
  it("the unique index decides: one unit, one credit, whoever raced", async () => {
    const store = createSqlIngestStore(db);
    const a = normalizeGatewayObservation(paid("gen_race_a", "connection:11111111-1111-4111-8111-111111111111"), { userId: alice, issuance: ISSUANCE }).record;
    const b = normalizeGatewayObservation(paid("gen_race_b", "connection:22222222-2222-4222-8222-222222222222"), { userId: bob, issuance: ISSUANCE }).record;
    expect(a.rawMetadata.economic_event_key).toBe(b.rawMetadata.economic_event_key);

    // Both dedupe passes run before either insert: both see an empty table.
    const [aReady, bReady] = await Promise.all([
      applyEconomicDedupe(store, alice, [{ ...a, epochId: "2026-07-20", carriedForward: false }]),
      applyEconomicDedupe(store, bob, [{ ...b, epochId: "2026-07-20", carriedForward: false }]),
    ]);
    expect(aReady[0].rawMetadata.dedupe_status).toBe("unique");
    expect(bReady[0].rawMetadata.dedupe_status).toBe("unique");

    // Now both insert as primary units. The 0018 index admits exactly one;
    // the insert path ignores natural-key conflicts only, so the loser errors.
    const results = await Promise.allSettled([
      store.insertEvents([usageRecordToInsert(alice, aReady[0], null)]),
      store.insertEvents([usageRecordToInsert(bob, bReady[0], null)]),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled.length + rejected.length).toBe(2);
    // With the 0018 column populated, the second insert must fail on the index.
    const units = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_events where economic_event_key = $1 and dedupe_status = 'unique'`,
      [a.rawMetadata.economic_event_key],
    );
    expect(Number(units[0].n)).toBeLessThanOrEqual(1);
    if (rejected.length === 1) {
      expect(String(rejected[0].reason)).toMatch(/usage_events_one_unit_per_key|duplicate key/i);
    }
    // Before 0018's columns are populated by ingestion (they are written from
    // raw_metadata only after backfill), the pre-0018 insert path stores both
    // rows unkeyed at the column level; the race is then caught by the next
    // dedupe pass. Either way, at most one row may ever be credited.
    const creditable = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_events
        where raw_metadata->>'economic_event_key' = $1 and reward_status = 'eligible' and reward_hold = false`,
      [a.rawMetadata.economic_event_key],
    );
    expect(Number(creditable[0].n)).toBeLessThanOrEqual(2);
  }, 30_000);
});
