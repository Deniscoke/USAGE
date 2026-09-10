/**
 * M15C — tables at the owner's parameters (B = $1,000/day, F = 0, cap 100,000).
 *
 *   npm run usage:m15c:simulate
 *
 * Deterministic, network-free, no database.
 */
import { MINING_BETA_V2_PARAMETERS, effectivePoolBaselineLinear, planV2Settlement, previewEffectivePoolFractional } from "../src/lib/domain/tokenomics/settlement-v2";

const POOL = MINING_BETA_V2_PARAMETERS.scheduledPoolPoints;
const B = MINING_BETA_V2_PARAMETERS.baselineComputePico;
const usd = (x: number) => BigInt(Math.round(x * 1_000_000)) * 1_000_000n;
const out = (s = "") => process.stdout.write(`${s}\n`);
function table(headers: string[], rows: (string | number | bigint)[][]): void {
  out(`| ${headers.join(" | ")} |`);
  out(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out(`| ${r.map(String).join(" | ")} |`);
  out();
}

out("# M15C results: linear v2, baseline-linear-v1, B = $1,000/day, F = 0, cap 100,000\n");

out("## §2 parameter table");
table(["network compute N", "effective pool (whole points)", "preview (non-binding)", "points / protocol $"],
  [0, 0.001, 0.01, 0.1, 1, 10, 100, 1000, 10_000, 100_000].map((n) => { const e = effectivePoolBaselineLinear(POOL, usd(n), B); return [`$${n}`, e, previewEffectivePoolFractional(usd(n)), n > 0 ? (Number(e) / n).toFixed(4) : "n/a"]; }));

out("## §13 miners × network compute: effective pool and points per miner");
{
  const rows: (string | number | bigint)[][] = [];
  for (const n of [0.01, 0.1, 1, 10, 100, 1000, 10_000]) {
    for (const miners of [1, 10, 100, 1000]) {
      const plan = planV2Settlement(Array.from({ length: miners }, (_, i) => ({ userId: `m${i}`, eligiblePico: usd(n) / BigInt(miners) })));
      rows.push([`$${n}`, miners, plan.effectivePoints, plan.allocations.length > 0 ? plan.allocations[0].points : 0n, (Number(plan.effectivePoints) / n).toFixed(2), plan.undistributedPoints]);
    }
  }
  table(["N", "miners", "effective pool", "points per miner (≈)", "points / $", "never minted"], rows);
}

out("## §13 hypothetical value per point P (normalised, NOT a price): is a marginal wash dollar profitable?");
{
  const rate = (n: number) => Number(effectivePoolBaselineLinear(POOL, usd(n), B)) / n;
  const rows: (string | number)[][] = [];
  for (const P of [1e-4, 1e-3, 1e-2, 2e-2, 1e-1]) for (const n of [0.01, 1, 100, 1000, 2000, 10_000]) rows.push([P, `$${n}`, rate(n).toFixed(2), (P * rate(n)).toFixed(3), P * rate(n) > 1 ? "yes" : "no"]);
  table(["P", "N", "points / $", "P × points/$", "wash entry rational?"], rows);
  out("Below the baseline points/$ = 100 exactly, so entry needs P > 0.01 per point; above it the equilibrium is N* = P × 100,000 dollars and every extra dollar lowers everyone's rate.\n");
}

out("## §14 whales (100 honest sharing $2,000, above baseline)");
{
  const rows: (string | number | bigint)[][] = [];
  for (const share of [0.01, 0.1, 0.25, 0.5, 0.9]) {
    const whale = BigInt(Math.round((share / (1 - share)) * 2000 * 1e6)) * 1_000_000n;
    const plan = planV2Settlement([...Array.from({ length: 100 }, (_, i) => ({ userId: `h${i}`, eligiblePico: usd(20) })), { userId: "whale", eligiblePico: whale }]);
    const pts = plan.allocations.find((a) => a.userId === "whale")!.points;
    rows.push([`${share * 100}%`, `$${Number(whale / 1_000_000n) / 1e6}`, pts, `${((Number(pts) / Number(plan.effectivePoints)) * 100).toFixed(2)}%`]);
  }
  table(["whale compute share", "whale spend", "whale points", "whale reward share"], rows);
}

out("## M14C calibration under v2 (read-only)");
{
  const p = planV2Settlement([{ userId: "da93cec8", eligiblePico: 500_000n }]);
  table(["eligible pico", "v2 score", "effective pool", "points", "undistributed (never minted)"], [[500_000n, p.allocations[0].score, p.effectivePoints, p.allocations[0].points, p.undistributedPoints]]);
}
out("Done.");
