/**
 * Development command: make ONE real AI request through the Vercel AI Gateway
 * and turn what USAGE observed into a routed proof.
 *
 *   npm run usage:gateway:probe                          # dry run, explains and exits
 *   npm run usage:gateway:probe -- --confirm             # actually spends credits
 *   npm run usage:gateway:probe -- --fixtures --user ID  # free: ingest fixtures
 *
 * This is the only code path in the repository that can spend money, and it
 * refuses to do so without --confirm.
 */
import { normalizeGatewayObservation } from "../src/lib/providers/vercel-gateway/adapter";
import {
  gatewayCredentialPresent,
  resolveProbeModel,
  runGatewayProbe,
} from "../src/lib/providers/vercel-gateway/probe";
import { formatUsd } from "../src/lib/domain/money";

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const fixtureMode = args.includes("--fixtures");
const userId = readFlag("--user");

function readFlag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<number> {
  if (fixtureMode) return runFixtureMode();

  const credentialPresent = gatewayCredentialPresent();
  const model = process.env.USAGE_PROBE_MODEL;

  line("USAGE — Vercel AI Gateway probe");
  line("--------------------------------");
  line(`credential      : ${credentialPresent ? "present (server env)" : "MISSING"}`);
  line(`model           : ${model ?? "(resolved from gateway, cheapest language model)"}`);
  line(`persist to user : ${userId ?? "(none — result printed only)"}`);
  line();

  if (!confirmed) {
    line("DRY RUN. No request was made and nothing was charged.");
    line();
    line("A real run sends one small completion through the AI Gateway and WILL");
    line("consume AI Gateway credits or provider quota on your Vercel team.");
    line("Re-run with --confirm to proceed:");
    line();
    line("  npm run usage:gateway:probe -- --confirm");
    line();
    return 0;
  }

  if (!credentialPresent) {
    line("Refusing to run: set AI_GATEWAY_API_KEY (or pull VERCEL_OIDC_TOKEN) first.");
    return 1;
  }

  const resolvedModel = await resolveProbeModel(model);
  line(`Requesting one completion from ${resolvedModel} ...`);

  const result = await runGatewayProbe({ model: resolvedModel });

  if (!result.ok) {
    // Operational failure. No usage event is created: a failed request is not
    // evidence that billable usage occurred.
    line();
    line(`FAILED (${result.failure.kind}${result.failure.statusCode ? ` ${result.failure.statusCode}` : ""})`);
    line(result.failure.message);
    line();
    line("No usage event was recorded.");
    return 1;
  }

  const { record, proof } = normalizeGatewayObservation(result.observation);

  line();
  line("Observed routed usage");
  line("---------------------");
  line(`generation id   : ${result.observation.generationId}`);
  line(`model           : ${record.model}`);
  line(`served by       : ${result.observation.servedByProvider ?? "(not reported)"}`);
  line(`occurred at     : ${record.occurredAt}`);
  line(`input tokens    : ${record.inputTokens}`);
  line(`cached input    : ${record.cachedInputTokens}`);
  line(`output tokens   : ${record.outputTokens}`);
  line(`cost            : ${
    record.reportedCostMicros === null
      ? "not reported by gateway (recorded as unknown, never estimated)"
      : `${formatUsd(record.normalizedCostMicros, { maximumFractionDigits: 6 })} (${record.normalizedCostMicros} micro-USD)`
  }`);
  line(`verification    : ${record.verificationType} / ${record.verificationStatus}`);
  line(`external ref    : ${record.externalReference}`);
  line(`adapter         : ${proof.adapterVersion}`);
  line();

  if (!userId) {
    line("Not persisted. Pass --user <profile-uuid> with Supabase configured to ingest it.");
    return 0;
  }

  const { createAdminSupabase } = await import("../src/lib/supabase/admin");
  const { createSupabaseIngestStore } = await import("../src/lib/db/supabase-store");
  const { ingestGatewayObservations } = await import("../src/lib/db/ingest");

  const store = createSupabaseIngestStore(createAdminSupabase());
  const summary = await ingestGatewayObservations(store, userId, [result.observation]);

  line(
    `Ingested: ${summary.inserted} new, ${summary.duplicates} already stored, ` +
      `${summary.rejected.length} rejected.`,
  );
  return 0;
}

/**
 * Fixture mode. Costs nothing and touches no network. Fixtures are classified
 * REPORTED by the adapter, so they can never become rewardable routed evidence.
 */
async function runFixtureMode(): Promise<number> {
  line("USAGE — Vercel AI Gateway fixture ingestion (no network, no cost)");
  line();

  const { gatewayFixtures } = await import("../src/lib/providers/vercel-gateway/fixtures");
  const observations = gatewayFixtures();

  for (const observation of observations) {
    const { record } = normalizeGatewayObservation(observation);
    line(
      `${record.externalReference}  ${record.model}  ${record.verificationType}/${record.verificationStatus}  ` +
        `${record.inputTokens}+${record.cachedInputTokens}/${record.outputTokens} tokens  ` +
        `${record.reportedCostMicros === null ? "cost unknown" : `${record.normalizedCostMicros} micro-USD`}`,
    );
  }

  if (!userId) {
    line();
    line("Not persisted. Pass --user <profile-uuid> with Supabase configured to ingest.");
    return 0;
  }

  const { createAdminSupabase } = await import("../src/lib/supabase/admin");
  const { createSupabaseIngestStore } = await import("../src/lib/db/supabase-store");
  const { ingestGatewayObservations } = await import("../src/lib/db/ingest");

  const store = createSupabaseIngestStore(createAdminSupabase());
  const summary = await ingestGatewayObservations(store, userId, observations);
  line();
  line(
    `Ingested: ${summary.inserted} new, ${summary.duplicates} already stored, ` +
      `${summary.rejected.length} rejected.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(`Probe crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
