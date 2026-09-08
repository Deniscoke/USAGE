import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { gatewayFixtures, malformedGatewayFixtures } from "@/lib/providers/vercel-gateway/fixtures";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import { MICROS_PER_USD } from "@/lib/domain/money";
import { generateSigningKeyPair } from "@/lib/domain/signing";

// Stands in for the production signing key that only hosted USAGE holds.
const TEST_KEY = generateSigningKeyPair("test-key-1");
const ISSUANCE = {
  issuer: "usage://issuer/production",
  keyId: TEST_KEY.keyId,
  privateKeyBase64: TEST_KEY.privateKeyBase64,
};

/**
 * The routed-proof path, end to end, against a real Postgres:
 *
 *   observation -> adapter -> normalize -> ingest -> dedupe -> aggregate -> score
 */

const NOW = new Date("2026-04-10T12:00:00.000Z");
const DAY = "2026-04-10";

let db: TestDb;
let store: IngestStore;
let user: string;

beforeAll(async () => {
  db = await createTestDb();
  store = createSqlIngestStore(db);
  user = await db.createUser("gateway@example.com");
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function liveObservation(overrides: Partial<GatewayObservation> = {}): GatewayObservation {
  return {
    environment: "live",
    generationId: "gen_live_1",
    model: "openai/gpt-5.4",
    servedByProvider: "openai",
    // The user's own provider account, billed at a real rate: what
    // usage-reward-policy-v1 makes eligible.
    gatewayId: "connection:11111111-1111-4111-8111-111111111111",
    endpointTrusted: true,
    occurredAt: `${DAY}T10:00:00.000Z`,
    usage: {
      inputTokens: 1_000,
      outputTokens: 250,
      inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200 },
      outputTokenDetails: { textTokens: 250, reasoningTokens: 0 },
    },
    cost: { value: "4.00", currency: "USD" },
    finishReason: "stop",
    ...overrides,
  };
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return db.asServiceRole<T>(sql, params);
}

describe("fixture observations", () => {
  it("flows through the whole pipeline and lands as stored usage", async () => {
    const summary = await ingestGatewayObservations(store, user, gatewayFixtures(NOW));

    expect(summary.inserted).toBe(3);
    expect(summary.rejected).toEqual([]);

    const events = await rows<{ provider: string; source: string; verification_type: string }>(
      `select provider, source, verification_type from usage_events where user_id = $1`,
      [user],
    );
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.provider).toBe("vercel-ai-gateway");
      expect(event.source).toBe("vercel_ai_gateway");
      // Fixtures are not routed evidence and must never be rewardable.
      expect(event.verification_type).toBe("reported");
    }

    const aggregates = await rows<{ n: string }>(
      `select count(*)::text as n from usage_daily_aggregates where user_id = $1`,
      [user],
    );
    expect(Number(aggregates[0].n)).toBeGreaterThan(0);
  });

  it("earns zero economic weight", async () => {
    const scores = await rows<{ points: string; excluded_cost_micros: string }>(
      `select points::text, excluded_cost_micros::text from score_records where user_id = $1`,
      [user],
    );
    for (const score of scores) {
      expect(Number(score.points)).toBe(0);
      expect(Number(score.excluded_cost_micros)).toBeGreaterThan(0);
    }
  });

  it("is idempotent on the gateway generation id", async () => {
    const before = await rows<{ n: string }>(
      `select count(*)::text as n from usage_events where user_id = $1`,
      [user],
    );
    const summary = await ingestGatewayObservations(store, user, gatewayFixtures(NOW));

    expect(summary.inserted).toBe(0);
    expect(summary.duplicates).toBe(3);

    const after = await rows<{ n: string }>(
      `select count(*)::text as n from usage_events where user_id = $1`,
      [user],
    );
    expect(after[0].n).toBe(before[0].n);
  });

  it("records the gateway cost exactly, and an absent cost as unknown", async () => {
    const priced = await rows<{ actual_cost_micros: string | null; normalized_cost_micros: string }>(
      `select actual_cost_micros::text, normalized_cost_micros::text from usage_events
       where user_id = $1 and external_reference = 'fixture:gen_fixture_0002'`,
      [user],
    );
    // 0.0512347891 USD, rounded half-up at the micro boundary.
    expect(priced[0].normalized_cost_micros).toBe("51235");

    const unpriced = await rows<{ actual_cost_micros: string | null; normalized_cost_micros: string }>(
      `select actual_cost_micros::text, normalized_cost_micros::text from usage_events
       where user_id = $1 and external_reference = 'fixture:gen_fixture_0003'`,
      [user],
    );
    expect(unpriced[0].actual_cost_micros).toBeNull();
    expect(unpriced[0].normalized_cost_micros).toBe("0");
  });
});

describe("live routed observations", () => {
  let routedUser: string;

  beforeAll(async () => {
    routedUser = await db.createUser("routed@example.com");
    await ingestGatewayObservations(store, routedUser, [liveObservation()], {
      issuance: ISSUANCE,
    });
  });

  it("stores ROUTED evidence with confirmed status", async () => {
    const [event] = await rows<{
      verification_type: string;
      verification_status: string;
      external_reference: string;
      input_tokens: string;
      cached_input_tokens: string;
      output_tokens: string;
      requests: number;
    }>(
      `select verification_type, verification_status, external_reference,
              input_tokens::text, cached_input_tokens::text, output_tokens::text, requests
       from usage_events where user_id = $1`,
      [routedUser],
    );

    expect(event.verification_type).toBe("routed");
    expect(event.verification_status).toBe("confirmed");
    expect(event.external_reference).toBe("live:gen_live_1");
    expect(event.input_tokens).toBe("800");
    expect(event.cached_input_tokens).toBe("200");
    expect(event.output_tokens).toBe("250");
    expect(event.requests).toBe(1);
  });

  it("carries economic weight from the protocol pricing snapshot", async () => {
    const [event] = await rows<{ protocol_compute_micros: string; economic_status: string }>(
      `select protocol_compute_micros::text, economic_status from usage_events
       where user_id = $1`,
      [routedUser],
    );
    const [score] = await rows<{ points: string; weighted_cost_micros: string }>(
      `select points::text, weighted_cost_micros::text from score_records
       where user_id = $1 and day = $2`,
      [routedUser, DAY],
    );

    // openai/gpt-5.4 under usage-pricing-v1: input $2.50/1M, output $15.00/1M.
    // 800 uncached + 200 cached input, 250 output.
    expect(Number(event.protocol_compute_micros)).toBeGreaterThan(0);
    expect(event.economic_status).toBe("eligible");
    expect(score.weighted_cost_micros).toBe(event.protocol_compute_micros);
    expect(Number(score.points)).toBeCloseTo(
      Math.sqrt(Number(event.protocol_compute_micros) / MICROS_PER_USD) * 1000,
      3,
    );
  });

  it("writes provenance explaining the event", async () => {
    const [proof] = await rows<{
      proof_kind: string;
      proof_source: string;
      external_reference: string;
      adapter_version: string;
      verification_type: string;
      observed_at: string;
      ingested_at: string;
      proof_metadata: Record<string, unknown>;
    }>(
      `select p.proof_kind, p.proof_source, p.external_reference, p.adapter_version,
              p.verification_type, p.observed_at, p.ingested_at, p.proof_metadata
       from proof_records p where p.user_id = $1`,
      [routedUser],
    );

    expect(proof.proof_kind).toBe("gateway_observation");
    expect(proof.proof_source).toBe("vercel-ai-gateway");
    expect(proof.external_reference).toBe("live:gen_live_1");
    expect(proof.adapter_version).toBe("vercel-gateway@1");
    expect(proof.verification_type).toBe("routed");
    expect(proof.observed_at).toBeTruthy();
    expect(proof.ingested_at).toBeTruthy();
    expect(proof.proof_metadata.gateway_generation_id).toBe("gen_live_1");
    expect(proof.proof_metadata.served_by_provider).toBe("openai");
  });

  it("links the event to a connection that references the credential, never stores it", async () => {
    const [connection] = await rows<{ provider: string; secret_ref: string; last_synced_at: string }>(
      `select provider, secret_ref, last_synced_at from provider_connections
       where user_id = $1 and provider = 'vercel-ai-gateway'`,
      [routedUser],
    );
    expect(connection.secret_ref).toBe("env:AI_GATEWAY_API_KEY");
    expect(connection.last_synced_at).toBeTruthy();

    const [event] = await rows<{ connection_id: string | null }>(
      `select connection_id from usage_events where user_id = $1`,
      [routedUser],
    );
    expect(event.connection_id).not.toBeNull();
  });

  it("does not accumulate duplicate provenance when re-ingested", async () => {
    await ingestGatewayObservations(store, routedUser, [liveObservation()], {
      issuance: ISSUANCE,
    });
    const [count] = await rows<{ n: string }>(
      `select count(*)::text as n from proof_records where user_id = $1`,
      [routedUser],
    );
    expect(count.n).toBe("1");
  });

  it("stores no prompt or completion content anywhere", async () => {
    const [event] = await rows<{ raw_metadata: Record<string, unknown> }>(
      `select raw_metadata from usage_events where user_id = $1`,
      [routedUser],
    );
    const keys = Object.keys(event.raw_metadata).join(" ").toLowerCase();
    for (const forbidden of ["prompt", "completion", "message", "content", "api_key", "token_value"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("malformed evidence", () => {
  it("is rejected as an operational error and creates no usage", async () => {
    const rejectUser = await db.createUser("reject@example.com");
    const summary = await ingestGatewayObservations(
      store,
      rejectUser,
      malformedGatewayFixtures(NOW),
    );

    expect(summary.inserted).toBe(0);
    expect(summary.rejected).toHaveLength(3);
    expect(summary.rejected.map((r) => r.code).sort()).toEqual([
      "invalid_usage",
      "missing_generation_id",
      "missing_usage",
    ]);

    const [count] = await rows<{ n: string }>(
      `select count(*)::text as n from usage_events where user_id = $1`,
      [rejectUser],
    );
    expect(count.n).toBe("0");
  });

  it("still ingests the valid observations alongside a rejected one", async () => {
    const mixedUser = await db.createUser("mixed@example.com");
    const summary = await ingestGatewayObservations(store, mixedUser, [
      liveObservation({ generationId: "gen_mixed_ok" }),
      malformedGatewayFixtures(NOW)[1],
    ]);

    expect(summary.inserted).toBe(1);
    expect(summary.rejected).toHaveLength(1);
  });
});

describe("routed evidence cannot be forged by a client", () => {
  it("refuses a client insert of a gateway usage event", async () => {
    const attacker = await db.createUser("attacker@example.com");
    await expect(
      db.asUser(
        attacker,
        `insert into usage_events
           (user_id, provider, source, external_reference, model, occurred_at,
            normalized_cost_micros, verification_type, verification_status)
         values ($1, 'vercel-ai-gateway', 'vercel_ai_gateway', 'live:forged', 'openai/gpt-5.4',
                 now(), $2, 'routed', 'confirmed')`,
        [attacker, 1_000 * MICROS_PER_USD],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client attempt to fabricate provenance", async () => {
    const attacker = await db.createUser("attacker2@example.com");
    await expect(
      db.asUser(
        attacker,
        `insert into proof_records (user_id, usage_event_id, verification_type, proof_kind)
         values ($1, gen_random_uuid(), 'routed', 'gateway_observation')`,
        [attacker],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client attempt to upgrade fixture evidence to routed", async () => {
    await expect(
      db.asUser(user, `update usage_events set verification_type = 'routed'`),
    ).rejects.toThrow(/permission denied/i);
  });
});
