/**
 * M15 — run every red-team scenario and print the tables that go into
 * docs/M15-ECONOMICS.md.
 *
 *   npm run usage:m15:simulate
 *
 * Deterministic (seeded), network-free, touches no database.
 */
import {
  CONCAVE,
  LINEAR_RULE,
  V1_RULE,
  actorUnits,
  analyticSplitMultiplier,
  cappedLinear,
  honestPopulation,
  kneeSqrt,
  paidFarm,
  principalRule,
  scoreEpoch,
  splitExperiment,
  type ScoringRule,
  type SimUnit,
} from "../src/lib/domain/tokenomics/simulator";
import { USAGE_PRICING_V2 } from "../src/lib/pricing/usage-pricing-v2";
import { protocolComputeValue } from "../src/lib/pricing/compute";

const POOL = 100_000;
const USD = 1_000_000;
const out = (s = "") => process.stdout.write(`${s}\n`);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const f = (x: number, d = 2) => x.toFixed(d);

function table(headers: string[], rows: (string | number)[][]): void {
  out(`| ${headers.join(" | ")} |`);
  out(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out(`| ${r.join(" | ")} |`);
  out();
}

const BG = honestPopulation(99, 1 * USD, 42);

out("# M15 simulation results (seed 42, pool 100,000 points/epoch)\n");

// §4A / §4B / §4D populations under v1
out("## §4 baseline populations under usage_score_v1");
{
  const a = scoreEpoch(honestPopulation(100, 1 * USD, 7, 0), V1_RULE, POOL);
  const b = scoreEpoch([...BG, ...actorUnits({ principalId: "whale", computeMicros: 100 * USD })], V1_RULE, POOL);
  const d = scoreEpoch([...honestPopulation(990, 0.2 * USD, 9), ...Array.from({ length: 10 }, (_, i) => actorUnits({ principalId: `whale${i}`, computeMicros: 50 * USD })).flat()], V1_RULE, POOL);
  const whale = b.principals.find((p) => p.principalId === "whale")!;
  const whales = d.principals.filter((p) => p.principalId.startsWith("whale")).reduce((s, p) => s + p.share, 0);
  const whaleCompute = d.principals.filter((p) => p.principalId.startsWith("whale")).reduce((s, p) => s + p.computeMicros, 0) / d.principals.reduce((s, p) => s + p.computeMicros, 0);
  table(["population", "gini(points)", "note"], [
    ["A: 100 equal honest", f(a.gini, 3), "each gets 1,000 points"],
    ["B: 99 normal + 1 whale 100×", f(b.gini, 3), `whale has ${pct(whale.computeMicros / b.principals.reduce((s, p) => s + p.computeMicros, 0))} of compute, ${pct(whale.share)} of reward`],
    ["D: 990 small + 10 whales 250×", f(d.gini, 3), `whales have ${pct(whaleCompute)} of compute, ${pct(whales)} of reward`],
  ]);
}

// §2 §6 account splitting
out("## §2 §6 account splitting (attacker $10 vs 99 honest ≈ $1 each)");
{
  const rows = splitExperiment(BG, 10 * USD, [1, 2, 5, 10, 100, 1000], V1_RULE, POOL);
  table(["accounts", "analytic √n", "attacker score", "attacker share", "attacker points", "reward ×", "honest points ×"],
    rows.map((r) => [r.n, f(Math.sqrt(r.n), 3), f(r.attackerScore, 1), pct(r.attackerShare), r.attackerPoints, f(r.multiplier, 3), f(r.honestDilution, 3)]));
}

// §5 §7 §8 §12 representation dimensions
out("## §5 §7 §8 §12 representation dimensions under v1 (attacker $5, 99 honest)");
{
  const dims: ["requests" | "devices" | "connections" | "days", number[]][] = [["requests", [10, 100, 10_000]], ["devices", [100]], ["connections", [100]], ["days", [2, 7, 30]]];
  const rows: (string | number)[][] = [];
  for (const [dim, ns] of dims) {
    for (const r of splitExperiment(dim === "days" ? honestPopulation(99, 1 * USD, 42, 0.5, 30) : BG, 5 * USD, ns, V1_RULE, POOL, dim)) rows.push([dim, r.n, f(r.multiplier, 4), dim === "days" ? `score ×${f(r.attackerScore / 2236.068, 3)} (√d=${f(Math.sqrt(r.n), 3)})` : ""]);
  }
  table(["dimension", "n", "reward ×", "note"], rows);
}

// §9 paid farm
out("## §9 paid Sybil farm under v1: same $10 real spend, more identities");
{
  const rows = [1, 10, 100, 1000].map((n) => paidFarm(BG, n, 10 / n, V1_RULE, POOL));
  const lin = [1, 10, 100, 1000].map((n) => paidFarm(BG, n, 10 / n, LINEAR_RULE, POOL));
  table(["identities", "v1 points", "v1 share", "v1 break-even $/point", "linear points", "linear break-even $/point"],
    rows.map((r, i) => [r.identities, r.points, pct(r.share), r.breakEvenValuePerPoint.toExponential(2), lin[i].points, lin[i].breakEvenValuePerPoint.toExponential(2)]));
  out("Break-even: wash farming is rational when the value the market assigns to one point exceeds the break-even column. Under v1 that threshold falls ~√n with identity count; under linear it is flat.\n");
}

// §10 §11 pricing arbitrage
out("## §10 §11 protocol value per token class, usage-pricing-v2 (micro-USD per 1M tokens)");
{
  const rows: (string | number)[][] = [];
  for (const p of USAGE_PRICING_V2.prices) {
    const per = (t: Partial<Parameters<typeof protocolComputeValue>[2]>) => protocolComputeValue(USAGE_PRICING_V2.version, p.model, { inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0, ...t })!.micros;
    rows.push([p.model, per({ inputTokens: 1_000_000 }), per({ cachedReadTokens: 1_000_000 }), per({ cachedWriteTokens: 1_000_000 }), per({ outputTokens: 1_000_000 }), per({ outputTokens: 1_000_000, reasoningTokens: 1_000_000 }) - per({ outputTokens: 1_000_000 }), p.cacheReadMicrosPerMillion === null ? "fallback=input" : ""]);
  }
  table(["model", "input", "cache read", "cache write", "output", "reasoning extra", "note"], rows);
  out("Score per real dollar = protocol value ÷ actual charge. Where the provider bills list price, the ratio is 1 for every class: no cross-model arbitrage exists in protocol value itself. It exists only where actual ≠ list: provider discounts (batch, committed use, promotions), sub-micro rounding, and cache-read fallback on models without a cache-read price.\n");
}

// §18 §19 families
out("## §18 §19 score families: whale dampening vs splitting multiplier (analytic, $100 actor)");
{
  const fns: Record<string, (x: number) => number> = { ...CONCAVE, "capped $10/day": cappedLinear(10), "knee $1 then sqrt": kneeSqrt(1) };
  table(["function", "100× whale scores ×", "2-way split ×", "10-way split ×", "100-way split ×", "1000-way split ×"],
    Object.entries(fns).map(([n, fn]) => [n, f(fn(100) / fn(1), 2), f(analyticSplitMultiplier(fn, 100, 2), 3), f(analyticSplitMultiplier(fn, 100, 10), 3), f(analyticSplitMultiplier(fn, 100, 100), 3), f(analyticSplitMultiplier(fn, 100, 1000), 3)]));
}

out("## §18 the three families under the 100-account attack ($10 attacker, 99 honest)");
{
  const rules: ScoringRule[] = [LINEAR_RULE, V1_RULE, principalRule(CONCAVE.sqrt, "principal-concave sqrt (principal known)")];
  const rows: (string | number)[][] = [];
  for (const rule of rules) {
    const r = splitExperiment(BG, 10 * USD, [100], rule, POOL)[0];
    const whale = scoreEpoch([...BG, ...actorUnits({ principalId: "w", computeMicros: 100 * USD })], rule, POOL).principals.find((p) => p.principalId === "w")!;
    rows.push([rule.name, f(r.multiplier, 3), pct(r.attackerShare), pct(whale.share)]);
  }
  // Principal-concave when the principal CANNOT be linked: 100 separate principals.
  const unlinked: SimUnit[] = Array.from({ length: 100 }, (_, i) => actorUnits({ principalId: `att${i}`, computeMicros: (10 * USD) / 100 })).flat();
  const pr = principalRule(CONCAVE.sqrt);
  const u = scoreEpoch([...BG, ...unlinked], pr, POOL);
  const one = scoreEpoch([...BG, ...actorUnits({ principalId: "att", computeMicros: 10 * USD })], pr, POOL);
  const uPts = u.principals.filter((p) => p.principalId.startsWith("att")).reduce((s, p) => s + p.points, 0);
  rows.push(["principal-concave sqrt (principal UNKNOWN → 100 principals)", f(uPts / one.principals.find((p) => p.principalId === "att")!.points, 3), pct(uPts / POOL), "= v1"]);
  table(["rule", "100-way split reward ×", "attacker share after split", "100× whale share"], rows);
}

out("Done.");
