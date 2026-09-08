import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { MICROS_PER_USD } from "@/lib/domain/money";
import { buildMiningSession } from "@/lib/pipeline/session";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { CURRENT_PRICING_VERSION } from "@/lib/pricing/compute";

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
    // A user's own provider account, billed at a real rate. Under
    // usage-reward-policy-v1 that is the case that earns; USAGE-funded gateway
    // traffic is proven and held.
    gatewayId: "connection:11111111-1111-4111-8111-111111111111",
    endpointTrusted: true,
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

/**
 * anthropic/claude-haiku-4.5 under usage-pricing-v1:
 *   input  $1.00 / 1M  ->  1000 tokens = 1000 micro-USD
 *   output $5.00 / 1M  ->   200 tokens = 1000 micro-USD
 */
const EXPECTED_PROTOCOL_MICROS = 2_000;

describe("only trusted, priced evidence earns", () => {
  it("values production-observed routed usage by protocol compute, not by the bill", async () => {
    const user = await db.createUser("hosted@example.com");
    await ingestGatewayObservations(store, user, [observation()], { issuance: ISSUANCE });

    const [event] = await db.asServiceRole<{
      protocol_compute_micros: string;
      protocol_pricing_version: string;
      economic_status: string;
      actual_cost_micros: string;
    }>(
      `select protocol_compute_micros::text, protocol_pricing_version, economic_status,
              actual_cost_micros::text
       from usage_events where user_id = $1`,
      [user],
    );

    expect(event.protocol_compute_micros).toBe(String(EXPECTED_PROTOCOL_MICROS));
    expect(event.protocol_pricing_version).toBe(CURRENT_PRICING_VERSION);
    expect(event.economic_status).toBe("eligible");
    // The observation claimed a $4.00 bill. Mining ignores it entirely.
    expect(event.actual_cost_micros).toBe(String(4 * MICROS_PER_USD));

    const score = await scoreFor(user);
    expect(score.weighted).toBe(EXPECTED_PROTOCOL_MICROS);
    expect(score.points).toBeCloseTo(Math.sqrt(EXPECTED_PROTOCOL_MICROS / MICROS_PER_USD) * 1000, 3);
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
    expect(score.pending).toBe(EXPECTED_PROTOCOL_MICROS);
  });

  it("proves compute with no reported cost, and holds the reward", async () => {
    const user = await db.createUser("nocost@example.com");
    await ingestGatewayObservations(
      store,
      user,
      [observation({ generationId: "gen_nocost_1", cost: null })],
      { issuance: ISSUANCE },
    );

    const [event] = await db.asServiceRole<{
      economic_status: string;
      reward_status: string;
      reward_reason: string;
      protocol_compute_micros: string;
      eligible_compute_micros: string;
      actual_cost_micros: string | null;
    }>(
      `select economic_status, reward_status, reward_reason,
              protocol_compute_micros::text, eligible_compute_micros::text,
              actual_cost_micros::text
       from usage_events where user_id = $1`,
      [user],
    );

    // The proof is untouched: real compute, really observed, really priced.
    expect(event.actual_cost_micros).toBeNull();
    expect(event.economic_status).toBe("eligible");
    expect(event.protocol_compute_micros).toBe(String(EXPECTED_PROTOCOL_MICROS));

    // But nobody said who paid, so the reward waits rather than being guessed.
    // This is the M9 separation: proof truth and reward eligibility are
    // different questions with different answers.
    expect(event.reward_status).toBe("held");
    expect(event.reward_reason).toBe("source_unknown");
    expect(event.eligible_compute_micros).toBe("0");

    const score = await scoreFor(user);
    expect(score.weighted).toBe(0);
    // Held compute is reported, not discarded.
    expect(score.pending).toBe(EXPECTED_PROTOCOL_MICROS);
  });

  it("waits instead of guessing when the model has no approved price", async () => {
    const user = await db.createUser("unpriced@example.com");
    await ingestGatewayObservations(
      store,
      user,
      [observation({ generationId: "gen_unpriced_1", model: "acme/never-priced-9" })],
      { issuance: ISSUANCE },
    );

    const [event] = await db.asServiceRole<{
      proof_status: string;
      economic_status: string;
      protocol_pricing_version: string | null;
    }>(
      `select p.proof_status, e.economic_status, e.protocol_pricing_version
       from usage_events e join proof_records p on p.usage_event_id = e.id
       where e.user_id = $1`,
      [user],
    );

    // The proof is sound; only its price is unknown.
    expect(event.proof_status).toBe("confirmed");
    expect(event.economic_status).toBe("pending_pricing");
    expect(event.protocol_pricing_version).toBeNull();
    expect((await scoreFor(user)).points).toBe(0);
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
    expect(score.excluded).toBe(EXPECTED_PROTOCOL_MICROS);
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

    const total = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_events where user_id = $1`,
      [user],
    );

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(total[0].n).toBe("1");
    // Re-ingesting must not double the score either.
    expect((await scoreFor(user)).weighted).toBe(EXPECTED_PROTOCOL_MICROS);
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
    expect(session.routedCostMicros).toBe(EXPECTED_PROTOCOL_MICROS);
    expect(session.pendingCostMicros).toBe(EXPECTED_PROTOCOL_MICROS);
    expect(session.miningScore).toBeCloseTo(
      Math.sqrt(EXPECTED_PROTOCOL_MICROS / MICROS_PER_USD) * 1000,
      3,
    );
    expect(session.estimatedPoints).toBeGreaterThan(0);
  });
});
