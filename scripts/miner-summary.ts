/**
 * Mining session summary from locally observed gateway traffic.
 *
 *   npm run miner:summary
 *
 * Reads the development observation log written by the USAGE Gateway, runs the
 * observations through the real adapter and the real scorer, and prints what
 * they are worth. Nothing here is production proof storage.
 */
import { readFile } from "node:fs/promises";
import { normalizeGatewayObservation } from "../src/lib/providers/vercel-gateway/adapter";
import type { GatewayObservation } from "../src/lib/providers/vercel-gateway/observation";
import { dedupeUsageRecords } from "../src/lib/domain/normalize";
import { buildMiningSession } from "../src/lib/pipeline/session";
import { formatNumber, formatTokens, formatUsd } from "../src/lib/domain/money";
import { devObservationLogPath } from "../src/lib/gateway/observability";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<number> {
  const target = devObservationLogPath();

  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    line("No local observations yet.");
    line();
    line("Start the dev server, run Claude Code through the USAGE Gateway");
    line("(npm run miner:claude), then re-run this command.");
    return 0;
  }

  const observations = raw
    .split("\n")
    .filter(Boolean)
    .map((entry) => JSON.parse(entry) as GatewayObservation);

  const records = observations.map((observation) => normalizeGatewayObservation(observation).record);
  // The same generation must never count twice, here as anywhere else.
  const { accepted, duplicates } = dedupeUsageRecords(records);
  const session = buildMiningSession(accepted);

  line("USAGE MINER");
  line("===========");
  line();
  line(`Requests:      ${formatNumber(session.requests)}`);
  line(`Input tokens:  ${formatTokens(session.totals.inputTokens)}`);
  line(`Cached:        ${formatTokens(session.totals.cachedInputTokens)}`);
  line(`Output:        ${formatTokens(session.totals.outputTokens)}`);
  line();
  line(`Routed compute (scored):  ${formatUsd(session.routedCostMicros, { maximumFractionDigits: 6 })}`);
  line(`Pending (unconfirmed):    ${formatUsd(session.pendingCostMicros, { maximumFractionDigits: 6 })}`);
  line();
  line(`Mining score:  ${formatNumber(session.miningScore, 2)}`);
  line(`Network share: ${(session.networkShare * 100).toFixed(4)}%  (network denominator simulated)`);
  line();
  line(`Estimated epoch reward: ${formatNumber(session.estimatedPoints)} Usage Points`);
  line();
  line(
    `${observations.length} observation(s), ${duplicates} duplicate(s) ignored, epoch ${session.epoch.id}.`,
  );
  line("Usage Points are off-chain, non-transferable and carry no monetary value.");

  if (session.pendingCostMicros > 0 || session.routedCostMicros === 0) {
    line();
    line("Locally observed traffic is economically PENDING: a gateway running on");
    line("your own machine is not a trust anchor, so it earns nothing.");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
