import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { ingestImportedUsage } from "./import-ingest";
import { normalizeOpenAiOrgUsage } from "@/lib/imports/openai-org/adapter";
import { openRouterComputeGateway } from "@/lib/compute/openrouter-gateway";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { scoreRecords } from "@/lib/domain/scoring";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * Multi-provider ingestion against a real Postgres.
 *
 * Three claims under test:
 *
 *   1. an OpenRouter proof and a Vercel proof travel the same pipeline;
 *   2. re-importing a provider window creates zero duplicates;
 *   3. the same compute arriving twice, from two sources, is never rewarded
 *      twice.
 */

const DAY = "2026-08-01";
const BUCKET_START = Math.floor(new Date(`${DAY}T00:00:00.000Z`).getTime() / 1000);
const KEY = generateSigningKeyPair("multi-provider-key");
const ISSUANCE = {
  issuer: "usage://issuer/production",
  keyId: KEY.keyId,
  privateKeyBase64: KEY.privateKeyBase64,
};

let db: TestDb;
let store: IngestStore;

beforeAll(async () => {
  db = await createTestDb();
  store = createSqlIngestStore(db);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function openRouterObservation(generationId: string, model: string): GatewayObservation {
  return openRouterComputeGateway.toObservation({
    observed: openRouterComputeGateway.observe(
      {
        id: generationId,
        model,
        provider: model.split("/")[0],
        choices: [{ finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1_200,
          completion_tokens: 400,
          cost: 0.00042,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      },
      new Headers(),
    ),
    requestedModel: null,
    environment: "live",
    clientType: "openrouter-miner",
    occurredAt: new Date(`${DAY}T09:00:00.000Z`),
    latencyMs: 20,
  })!;
}

function openAiImportRecords(organizationId = "org-multi") {
  return normalizeOpenAiOrgUsage({
    organizationId,
    window: {
      since: new Date(BUCKET_START * 1000),
      until: new Date((BUCKET_START + 86_400) * 1000),
    },
    bucketWidth: "1d",
    usage: [
      {
        object: "bucket",
        start_time: BUCKET_START,
        end_time: BUCKET_START + 86_400,
        results: [
          {
            object: "organization.usage.completions.result",
            input_tokens: 50_000,
            output_tokens: 8_000,
            input_cached_tokens: 10_000,
            num_model_requests: 120,
            project_id: "proj_1",
            model: "gpt-5.4",
          },
        ],
      },
    ],
    costs: [],
  });
}

describe("an OpenRouter proof travels the shared pipeline", () => {
  let user: string;

  beforeAll(async () => {
    user = await db.createUser("openrouter@example.com");
    await ingestGatewayObservations(
      store,
      user,
      [openRouterObservation("gen-or-1", "anthropic/claude-haiku-4.5")],
      { issuance: ISSUANCE, minerCredentialId: "cred-or" },
    );
  });

  it("records which gateway executed it", async () => {
    const [row] = await db.asServiceRole<{
      gateway_id: string;
      verification_type: string;
      economic_status: string;
      actual_cost_micros: string | null;
      actual_cost_basis: string | null;
    }>(
      `select gateway_id, verification_type, economic_status,
              actual_cost_micros::text, actual_cost_basis
       from usage_events where user_id = $1`,
      [user],
    );

    expect(row.gateway_id).toBe("openrouter");
    expect(row.verification_type).toBe("routed");
    expect(row.economic_status).toBe("eligible");
    // OpenRouter states an authoritative cost. It is stored for audit only.
    expect(Number(row.actual_cost_micros)).toBe(420);
    expect(row.actual_cost_basis).toBe("gateway_reported");
  });

  it("is signed by the same production key as any other proof", async () => {
    const [proof] = await db.asServiceRole<{
      proof_status: string;
      signature: string | null;
      issuer_key_id: string | null;
    }>(`select proof_status, signature, issuer_key_id from proof_records where user_id = $1`, [
      user,
    ]);

    expect(proof.proof_status).toBe("confirmed");
    expect(proof.signature).toBeTruthy();
    expect(proof.issuer_key_id).toBe(KEY.keyId);
  });

  it("mines on protocol compute value, not on the reported bill", async () => {
    const [row] = await db.asServiceRole<{ protocol_compute_micros: string }>(
      `select protocol_compute_micros::text from usage_events where user_id = $1`,
      [user],
    );
    // The bill was 420 micro-USD; the protocol values the compute independently.
    expect(Number(row.protocol_compute_micros)).toBeGreaterThan(0);
    expect(Number(row.protocol_compute_micros)).not.toBe(420);
  });

  it("dedupes a replayed generation", async () => {
    const again = await ingestGatewayObservations(
      store,
      user,
      [openRouterObservation("gen-or-1", "anthropic/claude-haiku-4.5")],
      { issuance: ISSUANCE, minerCredentialId: "cred-or" },
    );
    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(1);
  });
});

describe("verified import", () => {
  let user: string;

  beforeAll(async () => {
    user = await db.createUser("import@example.com");
  });

  it("stores an authoritative aggregate as VERIFIED and CONFIRMED", async () => {
    const result = await ingestImportedUsage(store, user, openAiImportRecords(), {
      issuance: ISSUANCE,
    });
    expect(result.inserted).toBe(1);
    expect(result.held).toBe(0);

    const [row] = await db.asServiceRole<{
      verification_type: string;
      economic_status: string;
      gateway_id: string | null;
      reconciliation_status: string;
    }>(
      `select verification_type, economic_status, gateway_id, reconciliation_status
       from usage_events where user_id = $1`,
      [user],
    );

    expect(row.verification_type).toBe("verified");
    expect(row.economic_status).toBe("eligible");
    // An import has no gateway: nobody executed it on the user's behalf.
    expect(row.gateway_id).toBeNull();
    expect(row.reconciliation_status).toBe("clear");

    const [proof] = await db.asServiceRole<{ proof_kind: string; signature: string | null }>(
      `select proof_kind, signature from proof_records where user_id = $1`,
      [user],
    );
    expect(proof.proof_kind).toBe("provider_usage_import");
    expect(proof.signature).toBeTruthy();
  });

  it("creates zero duplicates when the same window is imported again", async () => {
    const first = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_events where user_id = $1`,
      [user],
    );

    const again = await ingestImportedUsage(store, user, openAiImportRecords(), {
      issuance: ISSUANCE,
    });
    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(1);

    const after = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_events where user_id = $1`,
      [user],
    );
    expect(after[0].n).toBe(first[0].n);
  });

  it("is OBSERVED and earns nothing without a production signature", async () => {
    const unsigned = await db.createUser("import-unsigned@example.com");
    await ingestImportedUsage(store, unsigned, openAiImportRecords("org-unsigned"), {
      issuance: null,
    });

    const [row] = await db.asServiceRole<{ economic_status: string }>(
      `select economic_status from usage_events where user_id = $1`,
      [unsigned],
    );
    expect(row.economic_status).toBe("ineligible");
  });
});

describe("cross-source reconciliation", () => {
  let user: string;

  beforeAll(async () => {
    user = await db.createUser("overlap@example.com");

    // Routed OpenAI compute USAGE observed first-hand...
    await ingestGatewayObservations(
      store,
      user,
      [openRouterObservation("gen-openai-routed", "openai/gpt-5.4")],
      { issuance: ISSUANCE, minerCredentialId: "cred-overlap" },
    );

    // ...then the provider's own daily total, which necessarily includes it.
    await ingestImportedUsage(store, user, openAiImportRecords("org-overlap"), {
      issuance: ISSUANCE,
    });
  });

  it("holds the overlapping import instead of rewarding it twice", async () => {
    const rows = await db.asServiceRole<{
      verification_type: string;
      reconciliation_status: string;
      reward_hold: boolean;
      economic_status: string;
    }>(
      `select verification_type, reconciliation_status, reward_hold, economic_status
       from usage_events where user_id = $1 order by verification_type`,
      [user],
    );

    const routed = rows.find((row) => row.verification_type === "routed")!;
    const imported = rows.find((row) => row.verification_type === "verified")!;

    // The routed proof is untouched: it was counted first and is not in doubt.
    expect(routed.reward_hold).toBe(false);
    expect(routed.economic_status).toBe("eligible");

    // The aggregate certainly contains that request and cannot be split, so its
    // reward waits rather than being paid on top.
    expect(imported.reconciliation_status).toBe("held");
    expect(imported.reward_hold).toBe(true);
  });

  it("keeps the held proof valid — a withheld reward is not a rejected proof", async () => {
    const [proof] = await db.asServiceRole<{ proof_status: string; signature: string | null }>(
      `select p.proof_status, p.signature from proof_records p
       join usage_events e on e.id = p.usage_event_id
       where e.user_id = $1 and e.verification_type = 'verified'`,
      [user],
    );
    expect(proof.proof_status).toBe("confirmed");
    expect(proof.signature).toBeTruthy();
  });

  it("excludes held compute from the score", async () => {
    const events = await store.loadEventsForDays(user, [DAY]);
    const held = events.find((event) => event.rewardHold);
    const routed = events.find((event) => !event.rewardHold)!;

    expect(held).toBeDefined();

    const scored = scoreRecords(events);
    const routedOnly = scoreRecords([routed]);
    // Identical scores: the held record contributed nothing.
    expect(scored.points).toBe(routedOnly.points);
    expect(scored.weightedCostMicros).toBe(routedOnly.weightedCostMicros);
    // ...and it is not silently discarded either; it is reported as pending.
    expect(scored.pendingCostMicros).toBeGreaterThan(0);
  });

  it("records why the reward is held", async () => {
    const [row] = await db.asServiceRole<{ raw_metadata: { reconciliation_reason?: string } }>(
      `select raw_metadata from usage_events
       where user_id = $1 and verification_type = 'verified'`,
      [user],
    );
    expect(row.raw_metadata.reconciliation_reason).toContain("overlaps routed");
  });
});

describe("a client cannot forge either kind of proof", () => {
  it("refuses a client-written routed event", async () => {
    const attacker = await db.createUser("forge-routed@example.com");
    await expect(
      db.asUser(
        attacker,
        `insert into usage_events
           (user_id, provider, source, external_reference, model, occurred_at,
            verification_type, gateway_id, economic_status)
         values ($1, 'openrouter', 'gateway', 'forged', 'openai/gpt-5.4', now(),
                 'routed'::verification_type, 'openrouter', 'eligible')`,
        [attacker],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client-uploaded verified import", async () => {
    // The rule that makes VERIFIED mean anything: a user cannot declare it.
    const attacker = await db.createUser("forge-import@example.com");
    await expect(
      db.asUser(
        attacker,
        `insert into usage_events
           (user_id, provider, source, external_reference, model, occurred_at,
            verification_type, economic_status)
         values ($1, 'openai', 'org_analytics_api', 'openai_org:forged',
                 'openai/gpt-5.4', now(), 'verified'::verification_type, 'eligible')`,
        [attacker],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client lifting its own reward hold", async () => {
    const attacker = await db.createUser("forge-hold@example.com");
    await expect(
      db.asUser(attacker, `update usage_events set reward_hold = false, economic_status = 'eligible'`),
    ).rejects.toThrow(/permission denied/i);
  });
});
