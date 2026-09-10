/**
 * M15B — emission candidates and whale tables for docs/M15-ECONOMICS.md.
 *
 *   npm run usage:m15b:emission
 *
 * Deterministic, network-free, touches no database.
 */
import { FIXED_FULL_POOL, baselineUtilisation, difficultyTarget, epochEconomics, farmingEquilibrium, hybrid, minimumActivity, type EmissionCandidate } from "../src/lib/domain/tokenomics/emission";
import { LINEAR_RULE, actorUnits, honestPopulation, scoreEpoch } from "../src/lib/domain/tokenomics/simulator";

const USD = 1_000_000;
const POOL = 100_000;
const out = (s = "") => process.stdout.write(`${s}\n`);
const money = (micros: number) => (micros < USD ? `$${(micros / USD).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}` : `$${(micros / USD).toLocaleString("en-US")}`);
function table(headers: string[], rows: (string | number)[][]): void {
  out(`| ${headers.join(" | ")} |`);
  out(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out(`| ${r.join(" | ")} |`);
  out();
}

const LEVELS = [1, 1_000, 10_000, 100_000, 1 * USD, 10 * USD, 100 * USD, 1_000 * USD, 10_000 * USD, 100_000 * USD];
const B = 100 * USD;
const candidates: EmissionCandidate[] = [FIXED_FULL_POOL, baselineUtilisation(B), difficultyTarget(B), hybrid(1_000, B), minimumActivity(1 * USD, B)];

out("# M15B emission results (pool 100,000 / epoch, linear scoring)\n");

out("## §6 fixed pool (candidate A) across network compute levels, ONE miner");
table(["network compute", "network score (micro)", "effective pool", "points / protocol $", "sole miner gets", "break-even $/point"],
  LEVELS.map((n) => { const e = epochEconomics(FIXED_FULL_POOL, POOL, n); return [money(n), n, e.effectivePool, e.pointsPerUsd.toExponential(2), e.effectivePool, e.breakEvenValuePerPoint.toExponential(2)]; }));

out("## §7 effective pool by candidate (B = T = $100/epoch, floor 1,000, M = $1)");
table(["network compute", ...candidates.map((c) => c.id)],
  LEVELS.map((n) => [money(n), ...candidates.map((c) => c.effectivePool({ scheduledPool: POOL, networkComputeMicros: n }))]));

out("## §7 points per protocol dollar by candidate");
table(["network compute", ...candidates.map((c) => c.id)],
  LEVELS.map((n) => [money(n), ...candidates.map((c) => epochEconomics(c, POOL, n).pointsPerUsd.toExponential(2))]));

out("## §9 sole tiny miner (1 micro-USD, the M14C day): points captured of the 100,000 scheduled");
table(["candidate", "points to the sole miner", "fraction of epoch schedule"],
  candidates.map((c) => { const p = c.effectivePool({ scheduledPool: POOL, networkComputeMicros: 1 }); return [c.name, p, `${((p / POOL) * 100).toFixed(4)}%`]; }));

out("## §10 farming equilibrium: honest network $10, hypothetical value per point P (normalised, not a price)");
{
  const rows: (string | number)[][] = [];
  for (const P of [1e-5, 1e-4, 1e-3, 2e-3, 1e-2, 1e-1]) {
    for (const c of candidates.slice(0, 4)) {
      const r = farmingEquilibrium(c, POOL, P, 10 * USD);
      rows.push([P.toExponential(0), c.id, r.entry ? "yes" : "no", money(r.equilibriumMicros), money(r.washMicros), r.pointsPerUsdAtEquilibrium.toExponential(2)]);
    }
  }
  table(["P", "candidate", "wash entry?", "equilibrium network", "wash compute", "points/$ at equilibrium"], rows);
}

out("## §11 whales under linear: compute share → reward share (100 honest at $1)");
{
  const rows: (string | number)[][] = [];
  for (const share of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9]) {
    const whale = Math.round((share / (1 - share)) * 100 * USD);
    const o = scoreEpoch([...honestPopulation(100, 1 * USD, 7, 0), ...actorUnits({ principalId: "whale", computeMicros: whale })], LINEAR_RULE, POOL);
    const w = o.principals.find((p) => p.principalId === "whale")!;
    rows.push([`${(share * 100).toFixed(0)}%`, money(whale), `${(w.share * 100).toFixed(2)}%`, w.points, o.gini.toFixed(3)]);
  }
  table(["whale compute share", "whale spend", "whale reward share", "whale points", "gini"], rows);
}
out("Done.");
