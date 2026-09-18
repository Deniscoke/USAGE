import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Provider billing evidence is written ONLY by server code after its own
 * authenticated GitHub fetch. This proves it at the source level:
 *
 *   - exactly these route handlers touch the provider-billing lane;
 *   - none of them reads a request body, so there is no way to submit billing
 *     JSON from a browser, a script or the miner;
 *   - no miner or gateway route imports the lane, so a miner token (usgm_)
 *     cannot reach a provider-billing write.
 */

const API_DIR = path.resolve(process.cwd(), "src/app/api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

const rel = (file: string) => path.relative(API_DIR, file).split(path.sep).join("/");
const ALLOWED = new Set([
  "providers/github/start/route.ts",
  "providers/github/callback/route.ts",
  "providers/github/refresh/route.ts",
  "providers/github/disconnect/route.ts",
  "cron/provider-billing-sync/route.ts",
]);
const TOUCHES_LANE = /provider-billing|provider_billing/;
const READS_BODY = /\.(json|text|formData|arrayBuffer|blob)\(\s*\)|request\.body|req\.body/;

describe("provider billing routes", () => {
  const files = routeFiles(API_DIR);

  it("only the GitHub connector routes and the cron touch the lane", () => {
    const touching = files.filter((f) => TOUCHES_LANE.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(touching).toEqual([...ALLOWED].sort());
  });

  it("none of them accepts a request body, so no billing JSON can be submitted", () => {
    for (const file of files.filter((f) => ALLOWED.has(rel(f)))) {
      expect(READS_BODY.test(readFileSync(file, "utf8")), rel(file)).toBe(false);
    }
  });

  it("no miner or gateway route can reach a provider-billing write", () => {
    const minerSide = files.filter((f) => /^(miner|gateway|mining)\//.test(rel(f)));
    expect(minerSide.length).toBeGreaterThan(0);
    for (const file of minerSide) {
      expect(TOUCHES_LANE.test(readFileSync(file, "utf8")), rel(file)).toBe(false);
    }
  });

  it("the user-facing routes check the session and the second factor", () => {
    for (const name of ["start", "callback", "refresh", "disconnect"]) {
      const source = readFileSync(path.join(API_DIR, "providers/github", name, "route.ts"), "utf8");
      expect(source, name).toMatch(/auth\.getUser\(\)/);
      expect(source, name).toMatch(/sessionSatisfiesSecondFactor/);
    }
    const cron = readFileSync(path.join(API_DIR, "cron/provider-billing-sync/route.ts"), "utf8");
    expect(cron).toMatch(/CRON_SECRET/);
  });

  it("the cron entry exists", () => {
    const vercel = JSON.parse(readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string }[] };
    expect(vercel.crons.map((c) => c.path)).toContain("/api/cron/provider-billing-sync");
  });
});
