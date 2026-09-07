/**
 * Runtime verification against a real hosted Supabase project.
 *
 *   npm run usage:verify-hosted
 *
 * PGlite proves the SQL and the policies; it cannot prove GoTrue, PostgREST or
 * the grants as the platform actually applies them. This does, using real
 * sign-up, real JWTs and real REST requests.
 *
 * It creates two throwaway users, exercises the boundaries, and deletes them
 * again. It never prints a key.
 */
import { createClient } from "@supabase/supabase-js";
import { createSupabaseIngestStore } from "../src/lib/db/supabase-store";
import { ingestGatewayObservations } from "../src/lib/db/ingest";
import type { Database } from "../src/lib/supabase/database.types";
import type { GatewayObservation } from "../src/lib/providers/vercel-gateway/observation";
import { CURRENT_PRICING_VERSION } from "../src/lib/pricing/compute";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${"-".repeat(title.length)}\n`);
}

/** A client that behaves exactly like the browser: publishable key + user JWT. */
function asUser(accessToken: string) {
  return createClient<Database>(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function observation(generationId: string, day: string): GatewayObservation {
  return {
    environment: "live",
    generationId,
    model: "anthropic/claude-haiku-4.5",
    clientType: "claude-code",
    servedByProvider: "anthropic",
    occurredAt: `${day}T10:00:00.000Z`,
    usage: {
      inputTokens: 1_000,
      outputTokens: 200,
      inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 },
    },
    cost: { value: "4.00", currency: "USD" },
    finishReason: "end_turn",
  };
}

async function main(): Promise<number> {
  const stamp = Date.now();
  const alice = { email: `verify-a-${stamp}@usage.test`, password: `Aa1!${stamp}xyz` };
  const bob = { email: `verify-b-${stamp}@usage.test`, password: `Bb1!${stamp}xyz` };
  const created: string[] = [];

  try {
    section("GoTrue: sign-up and sign-in");

    const signUps = await Promise.all(
      [alice, bob].map((user) =>
        admin.auth.admin.createUser({
          email: user.email,
          password: user.password,
          email_confirm: true,
        }),
      ),
    );
    for (const result of signUps) {
      if (result.data.user) created.push(result.data.user.id);
    }
    check("auth users created", created.length === 2, signUps[0].error?.message ?? "");

    const anon = createClient<Database>(url, publishable, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const aliceSession = await anon.auth.signInWithPassword(alice);
    const bobSession = await anon.auth.signInWithPassword(bob);
    check(
      "password sign-in returns a session",
      Boolean(aliceSession.data.session && bobSession.data.session),
      aliceSession.error?.message ?? "",
    );

    const aliceId = aliceSession.data.user!.id;
    const bobId = bobSession.data.user!.id;
    const aliceClient = asUser(aliceSession.data.session!.access_token);
    const bobClient = asUser(bobSession.data.session!.access_token);

    const whoami = await aliceClient.auth.getUser();
    check("getUser() resolves the signed-in user", whoami.data.user?.id === aliceId);

    section("Profile creation trigger");

    const profile = await admin.from("profiles").select("id").eq("id", aliceId).maybeSingle();
    check("on_auth_user_created created a profile row", Boolean(profile.data));

    section("Trusted server-side ingestion");

    const store = createSupabaseIngestStore(admin);
    const day = new Date().toISOString().slice(0, 10);

    const first = await ingestGatewayObservations(store, aliceId, [
      observation(`gen_hosted_${stamp}`, day),
    ]);
    check("service role can write usage", first.inserted === 1, `inserted=${first.inserted}`);

    const second = await ingestGatewayObservations(store, aliceId, [
      observation(`gen_hosted_${stamp}`, day),
    ]);
    const stored = await admin
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", aliceId);

    check("first ingest inserted exactly one event", first.inserted === 1, `inserted=${first.inserted}`);
    check("second ingest inserted nothing", second.inserted === 0, `inserted=${second.inserted}`);
    check("exactly one record total", stored.count === 1, `total=${stored.count}`);

    const proofs = await admin.from("proof_records").select("proof_status").eq("user_id", aliceId);
    check("exactly one proof record exists", proofs.data?.length === 1);
    check(
      "unsigned ingestion stays OBSERVED",
      proofs.data?.[0]?.proof_status === "observed",
      `proof_status=${proofs.data?.[0]?.proof_status}`,
    );

    const events = await admin
      .from("usage_events")
      .select("economic_status")
      .eq("user_id", aliceId);
    check(
      "unsigned usage is not economically eligible",
      events.data?.[0]?.economic_status !== "eligible",
      `economic_status=${events.data?.[0]?.economic_status}`,
    );

    section("Row level security, through PostgREST");

    const ownEvents = await aliceClient.from("usage_events").select("id");
    check("a user reads their own usage", (ownEvents.data?.length ?? 0) === 1);

    const crossEvents = await bobClient.from("usage_events").select("id");
    check("a user cannot read another user's usage", (crossEvents.data?.length ?? 0) === 0);

    const crossTargeted = await bobClient.from("usage_events").select("id").eq("user_id", aliceId);
    check(
      "naming the other user's id changes nothing",
      (crossTargeted.data?.length ?? 0) === 0,
    );

    const crossAggregates = await bobClient.from("usage_daily_aggregates").select("day");
    const crossScores = await bobClient.from("score_records").select("day");
    const crossProofs = await bobClient.from("proof_records").select("id");
    check(
      "aggregates, scores and proofs are equally private",
      (crossAggregates.data?.length ?? 0) === 0 &&
        (crossScores.data?.length ?? 0) === 0 &&
        (crossProofs.data?.length ?? 0) === 0,
    );

    const crossProfile = await bobClient.from("profiles").select("id");
    check(
      "a user sees only their own profile",
      crossProfile.data?.length === 1 && crossProfile.data[0].id === bobId,
    );

    section("Clients cannot forge economic evidence");

    const forgeEvent = await bobClient.from("usage_events").insert({
      user_id: bobId,
      provider: "vercel-ai-gateway",
      source: "vercel_ai_gateway",
      external_reference: `live:forged_${stamp}`,
      model: "anthropic/claude-opus-5",
      occurred_at: new Date().toISOString(),
      normalized_cost_micros: 999_000_000,
      verification_type: "routed",
      verification_status: "confirmed",
      economic_status: "eligible",
    });
    check("client cannot insert a usage event", Boolean(forgeEvent.error), forgeEvent.error?.code);

    const forgeProof = await bobClient.from("proof_records").insert({
      user_id: bobId,
      usage_event_id: crypto.randomUUID(),
      verification_type: "routed",
      proof_kind: "gateway_observation",
      proof_status: "confirmed",
      issuer: "usage://issuer/production",
      signature: "forged",
    });
    check("client cannot insert a proof record", Boolean(forgeProof.error), forgeProof.error?.code);

    const forgeUpgrade = await aliceClient
      .from("usage_events")
      .update({ economic_status: "eligible", verification_status: "confirmed" })
      .eq("user_id", aliceId);
    check(
      "client cannot promote their own usage",
      Boolean(forgeUpgrade.error),
      forgeUpgrade.error?.code,
    );

    const forgeScore = await bobClient
      .from("score_records")
      .insert({ user_id: bobId, day, algorithm_version: "usage_score_v1", points: 999_999 });
    check("client cannot write a score", Boolean(forgeScore.error), forgeScore.error?.code);

    const forgeAllocation = await bobClient
      .from("reward_allocations")
      .insert({ epoch_id: "epoch-forged", user_id: bobId, points: 999_999 });
    check(
      "client cannot write a reward allocation",
      Boolean(forgeAllocation.error),
      forgeAllocation.error?.code,
    );

    section("Economic fields are server-only");

    const [event] = (
      await admin.from("usage_events").select("*").eq("user_id", aliceId)
    ).data!;
    check(
      "protocol compute value was computed server-side",
      event.protocol_pricing_version === CURRENT_PRICING_VERSION && event.protocol_compute_micros > 0,
      `${event.protocol_compute_micros} micro-USD @ ${event.protocol_pricing_version}`,
    );

    const forgeCompute = await aliceClient
      .from("usage_events")
      .update({ protocol_compute_micros: 999_000_000, economic_status: "eligible" })
      .eq("user_id", aliceId);
    check(
      "client cannot set a protocol compute value",
      Boolean(forgeCompute.error),
      forgeCompute.error?.code,
    );

    const forgePrice = await bobClient.from("protocol_model_prices").insert({
      pricing_version: "usage-pricing-v1",
      model: "acme/free-money",
      provider_family: "acme",
      input_micros_per_million: 999_000_000,
      output_micros_per_million: 999_000_000,
      cache_read_micros_per_million: null,
      cache_write_micros_per_million: null,
      reasoning_micros_per_million: null,
    });
    check("client cannot publish a price", Boolean(forgePrice.error), forgePrice.error?.code);

    const forgeLedger = await bobClient.from("usage_point_ledger").insert({
      user_id: bobId,
      epoch_id: `epoch-${day}`,
      allocation_id: `forged-${stamp}`,
      amount: 999_999,
      reason: "self_credit",
    });
    check("client cannot credit itself points", Boolean(forgeLedger.error), forgeLedger.error?.code);

    const readPrices = await bobClient.from("protocol_model_prices").select("model").limit(1);
    check("prices are publicly readable", (readPrices.data?.length ?? 0) === 1);

    const crossLedger = await bobClient.from("usage_point_ledger").select("amount");
    check("a user sees only their own points", (crossLedger.data?.length ?? 0) === 0);

    section("Miner credential secrecy");

    const credential = await admin
      .from("usage_miner_credentials")
      .insert({
        user_id: aliceId,
        name: "verification",
        token_hash: "a".repeat(64),
        token_prefix: "usgm_verify",
      })
      .select("id")
      .single();
    check("service role can create a credential", Boolean(credential.data));

    const readHash = await aliceClient.from("usage_miner_credentials").select("token_hash");
    check(
      "a user cannot read the stored token hash",
      Boolean(readHash.error),
      readHash.error?.code ?? "no error",
    );

    const readOwn = await aliceClient
      .from("usage_miner_credentials")
      .select("id, name, token_prefix, revoked_at");
    check("a user can list their own credentials", readOwn.data?.length === 1);

    const readOthers = await bobClient
      .from("usage_miner_credentials")
      .select("id, name, token_prefix");
    check("a user cannot see another user's credentials", (readOthers.data?.length ?? 0) === 0);
  } finally {
    for (const id of created) await admin.auth.admin.deleteUser(id);
    process.stdout.write(`\nCleaned up ${created.length} test user(s) and their data.\n`);
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stdout.write(`\nCrashed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
