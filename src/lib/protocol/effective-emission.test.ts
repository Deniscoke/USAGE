import { describe, expect, it } from "vitest";
import { MINING_BETA_V2_DRAFT, MINING_DEV_V1 } from "./emission";
import { effectiveEmissionPoints, protocolForEpoch } from "./schedule";

const beta = protocolForEpoch("epoch-2026-09-14");
const dev = protocolForEpoch("epoch-2026-09-13");

describe("effectiveEmissionPoints", () => {
  it("resolves the two protocols either side of the cutover", () => {
    expect(dev.version).toBe(MINING_DEV_V1.version);
    expect(beta.version).toBe(MINING_BETA_V2_DRAFT.version);
  });

  it("mints the whole fixed pool under dev-v1, however little was used", () => {
    expect(effectiveEmissionPoints(dev, 0)).toBe(100_000);
    expect(effectiveEmissionPoints(dev, 15_076)).toBe(100_000);
  });

  it("scales with network compute under beta-v2, the way settlement does", () => {
    // The owner's real 2026-09-11: $0.399335 of verified compute.
    expect(effectiveEmissionPoints(beta, 399_335)).toBe(39);
    // The owner's real 2026-09-12: $0.015076.
    expect(effectiveEmissionPoints(beta, 15_076)).toBe(1);
    expect(effectiveEmissionPoints(beta, 5_000_000)).toBe(500);
  });

  it("stops at the cap once the network passes the $1,000 baseline", () => {
    expect(effectiveEmissionPoints(beta, 1_000_000_000)).toBe(100_000);
    expect(effectiveEmissionPoints(beta, 25_000_000_000)).toBe(100_000);
  });

  it("mints nothing for a day with no compute, and survives nonsense", () => {
    expect(effectiveEmissionPoints(beta, 0)).toBe(0);
    expect(effectiveEmissionPoints(beta, Number.NaN)).toBe(0);
    expect(effectiveEmissionPoints(beta, -50)).toBe(0);
  });
});
