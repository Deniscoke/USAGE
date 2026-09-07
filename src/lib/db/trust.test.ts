import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { MICROS_PER_USD } from "@/lib/domain/money";
import { buildMiningSession } from "@/lib/pipeline/session";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import { generateSigningKeyPair } from "@/lib/domain/signing";

// The production signing key a laptop does not have.
const TEST_KEY = generateSigningKeyPair("test-key-1");
const ISSUANCE = {
  issuer: "usage://issuer/production",
  keyId: TEST_KEY.keyId,
  privateKeyBase64: TEST_KEY.privateKeyBase64,
};

/**
 * Economic trust boundaries, end to end against a real Postgres.
 *
 * The question these answer: which observed compute is allowed to earn?
 */

const DAY = "2026-05-05";

let db: TestDb;
let store: IngestStore;

beforeAll(async () => {
  db = await createTestDb();
  store = createSqlIngestStore(db);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function observation(overrides: Partial<GatewayObservation> = {}): GatewayObservation {
  return {
    environment: "live",
    generationId: "gen_1",
    model: "anthropic/claude-haiku-4.5",
    clientType: "claude-code",
    servedByProvider: "anthropic",
    occurredAt: `${DAY}T10:00:00.000Z`,
    usage: { inputTokens: 1_000, outputTokens: 200 },
    cost: { value: "4.00", currency: "USD" },
    ...overrides,
  };
}

async function scoreFor(userId: string): Promise<{
  points: number;
  weighted: number;
  pending: number;
  excluded: number;
}> {
  const rows = await db.asServiceRole<{
    points: string;
    weighted_cost_micros: string;
    pending_cost_micros: string;
    excluded_cost_micros: string;
  }>(
    `select points::text, weighted_cost_micros::text, pending_cost_micros::text,
            excluded_cost_micros::text
     from score_records where user_id = $1 and day = $2`,
    [userId, DAY],
  );
  return {
    points: Number(rows[0]?.points ?? 0),
    weighted: Number(rows[0]?.weighted_cost_micros ?? 0),
    pending: Number(rows[0]?.pending_cost_micros ?? 0),
    excluded: Number(rows[0]?.excluded_cost_micros ?? 0),
  };
}

describe("only trusted, costed evidence earns", () => {
  it("scores production-observed routed usage", async () => {
    const user = await db.createUser("hosted@example.com");
    await ingestGatewayObservations(store, user, [observation()], { issuance: ISSUANCE });

    const score = await scoreFor(user);
    expect(score.points).toBe(2_000); // sqrt($4) * 1000
    expect(score.weighted).toBe(4 * MICROS_PER_USD);
    expect(score.pending).toBe(0);
  });

  it("gives a locally observed request zero economic weight", async () => {
    const user = await db.createUser("laptop@example.com");
    // Even handed an issuance, a development observation cannot be confirmed:
    // the adapter requires the production trust environment as well.
    await ingestGatewayObservations(
      store,
      user,
      [observation({ environment: "development", generationId: "gen_dev_1" })],
      { issuance: ISSUANCE },
    );

    const [event] = await db.asServiceRole<{
      verification_type: string;
      verification_status: string;
    }>(`select verification_type, verification_status from usage_events where user_id = $1`, [user]);

    // It really was routed -- it just was not observed by a trust anchor.
    expect(event.verification_type).toBe("routed");
    expect(event.verification_status).toBe("pending");

    const score = await scoreFor(user);
    expect(score.points).toBe(0);
    expect(score.weighted).toBe(0);
    expect(score.pending).toBe(4 * MICROS_PER_USD);
  });

  it("holds usage with unknown cost as pending rather than scoring it as zero dollars", async () => {
    const user = await db.createUser("nocost@example.com");
    await ingestGatewayObservations(
      store,
      user,
      [observation({ generationId: "gen_nocost_1", cost: null })],
      { issuance: ISSUANCE },
    );

    const [event] = await db.asServiceRole<{
      verification_status: string;
      normalized_cost_micros: string;
      raw_metadata: Record<string, unknown>;
    }>(
      `select verification_status, normalized_cost_micros::text, raw_metadata
       from usage_events where user_id = $1`,
      [user],
    );

    expect(event.verification_status).toBe("pending");
    expect(event.raw_metadata.cost_basis).toBe("unavailable");
    expect(await scoreFor(user)).toMatchObject({ points: 0, weighted: 0 });
  });

  it("gives fixture evidence zero economic weight", async () => {
    const user = await db.createUser("fixture-trust@example.com");
    await ingestGatewayObservations(
      store,
      user,
      [observation({ environment: "fixture", generationId: "gen_fix_1" })],
      { issuance: ISSUANCE },
    );

    const score = await scoreFor(user);
    expect(score.points).toBe(0);
    expect(score.excluded).toBe(4 * MICROS_PER_USD);
  });

  it("keeps the same generation from earning twice", async () => {
    const user = await db.createUser("dedupe-trust@example.com");
    const first = await ingestGatewayObservations(
      store,
      user,
      [observation({ generationId: "gen_once" })],
      { issuance: ISSUANCE },
    );
    const second = await ingestGatewayObservations(
      store,
      user,
      [observation({ generationId: "gen_once" })],
      { issuance: ISSUANCE },
    );

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    // Re-ingesting must not double the score either.
    expect((await scoreFor(user)).points).toBe(2_000);
  });

  it("stores a proof hash alongside every gateway event", async () => {
    const user = await db.createUser("hashed@example.com");
    await ingestGatewayObservations(store, user, [observation({ generationId: "gen_hash_1" })], {
      issuance: ISSUANCE,
    });

    const [proof] = await db.asServiceRole<{ proof_hash: string; trust_environment: string }>(
      `select proof_hash, trust_environment from proof_records where user_id = $1`,
      [user],
    );
    expect(proof.proof_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proof.trust_environment).toBe("production");
  });
});

describe("mining session summary", () => {
  it("derives from persisted usage and reuses the one scoring engine", async () => {
    const user = await db.createUser("session@example.com");
    await ingestGatewayObservations(
      store,
      user,
      [
        observation({ generationId: "gen_session_1" }),
        observation({
          generationId: "gen_session_2",
          environment: "development",
          occurredAt: `${DAY}T11:00:00.000Z`,
          cost: { value: "1.00", currency: "USD" },
        }),
      ],
      { issuance: ISSUANCE },
    );

    const stored = await store.loadEventsForDays(user, [DAY]);
    const session = buildMiningSession(stored, new Date(`${DAY}T12:00:00.000Z`));

    expect(session.requests).toBe(2);
    expect(session.totals.outputTokens).toBe(400);
    expect(session.routedCostMicros).toBe(4 * MICROS_PER_USD);
    expect(session.pendingCostMicros).toBe(1 * MICROS_PER_USD);
    expect(session.miningScore).toBe(2_000);
    expect(session.networkIsSimulated).toBe(true);
    expect(session.estimatedPoints).toBeGreaterThan(0);
  });
});
