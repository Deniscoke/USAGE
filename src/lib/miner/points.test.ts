import { describe, expect, it } from "vitest";
import { protocolForEpoch } from "@/lib/protocol/schedule";
import { minerPointsView } from "./points";

const dev = protocolForEpoch("epoch-2026-09-13");
const beta = protocolForEpoch("epoch-2026-09-14");

// The owner's real ledger on 2026-09-13.
const LEDGER = [
  { epochId: "epoch-2026-09-11", amount: 100_000, createdAt: "2026-09-12T00:52:19.805Z" },
  { epochId: "epoch-2026-09-12", amount: 100_000, createdAt: "2026-09-13T00:52:21.110Z" },
];

describe("minerPointsView", () => {
  it("shows the settled balance on a day nothing has been mined yet", () => {
    const view = minerPointsView({ ledger: LEDGER, userScoreToday: 0, networkScoreToday: 0, todayProtocol: dev, todayEpochOpen: true });
    expect(view.balance).toBe(200_000);
    expect(view.estimatedPoints).toBe(0);
  });

  it("names the most recent settled day and what it paid", () => {
    const view = minerPointsView({ ledger: LEDGER, userScoreToday: 0, networkScoreToday: 0, todayProtocol: dev, todayEpochOpen: true });
    expect(view.lastCredit).toEqual({ day: "2026-09-12", points: 100_000, creditedAt: "2026-09-13T00:52:21.110Z" });
  });

  it("estimates the whole fixed pool for a lone dev-v1 miner", () => {
    const view = minerPointsView({ ledger: [], userScoreToday: 12, networkScoreToday: 12, todayProtocol: dev, todayEpochOpen: true });
    expect(view.estimatedPoints).toBe(100_000);
  });

  it("estimates the scaled beta-v2 pool, not the cap", () => {
    // $5 of verified compute, alone on the network.
    const view = minerPointsView({ ledger: [], userScoreToday: 5_000_000, networkScoreToday: 5_000_000, todayProtocol: beta, todayEpochOpen: true });
    expect(view.estimatedPoints).toBe(500);
  });

  it("splits by share when others mined too", () => {
    const view = minerPointsView({ ledger: [], userScoreToday: 1_000_000, networkScoreToday: 4_000_000, todayProtocol: beta, todayEpochOpen: true });
    // Pool 400 for $4 of network compute; a quarter of it.
    expect(view.estimatedPoints).toBe(100);
  });

  it("never shows more than a whole share when the network total lags", () => {
    const view = minerPointsView({ ledger: [], userScoreToday: 2_000_000, networkScoreToday: 1_000_000, todayProtocol: beta, todayEpochOpen: true });
    expect(view.estimatedPoints).toBe(200);
  });

  it("stops estimating once the epoch has closed", () => {
    const view = minerPointsView({ ledger: LEDGER, userScoreToday: 5_000_000, networkScoreToday: 5_000_000, todayProtocol: beta, todayEpochOpen: false });
    expect(view.estimatedPoints).toBe(0);
    expect(view.balance).toBe(200_000);
  });

  it("has nothing to say about credits for a brand-new account", () => {
    const view = minerPointsView({ ledger: [], userScoreToday: 0, networkScoreToday: 0, todayProtocol: beta, todayEpochOpen: true });
    expect(view.balance).toBe(0);
    expect(view.lastCredit).toBeNull();
  });
});
