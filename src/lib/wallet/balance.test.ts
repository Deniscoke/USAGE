import { describe, expect, it } from "vitest";
import {
  FREE_DAILY_CAP_MICROS,
  PAID_DAILY_CAP_MICROS,
  STARTING_GRANT_MICROS,
  walletBalance,
  walletDailyCapMicros,
  walletDecision,
  walletRefusalMessage,
  type WalletEntry,
} from "./balance";

const at = "2026-09-12T10:00:00.000Z";
const grant = (amountMicros = STARTING_GRANT_MICROS): WalletEntry => ({
  kind: "grant",
  amountMicros,
  createdAt: at,
  reference: "starting-credit-v1",
});
const topup = (amountMicros: number, reference = "pi_1"): WalletEntry => ({
  kind: "topup",
  amountMicros,
  createdAt: at,
  reference,
});

describe("walletBalance", () => {
  it("is the grant minus what the account's traffic actually cost", () => {
    const balance = walletBalance({ entries: [grant()], fundedSpentMicros: 120_000 });
    expect(balance.creditedMicros).toBe(500_000);
    expect(balance.spentMicros).toBe(120_000);
    expect(balance.balanceMicros).toBe(380_000);
    expect(balance.funded).toBe(false);
  });

  it("keeps given money and paid money apart", () => {
    const balance = walletBalance({ entries: [grant(), topup(10_000_000)], fundedSpentMicros: 0 });
    expect(balance.grantedMicros).toBe(500_000);
    expect(balance.paidMicros).toBe(10_000_000);
    expect(balance.creditedMicros).toBe(10_500_000);
    expect(balance.funded).toBe(true);
  });

  it("reports an overdraft rather than hiding it in a negative balance", () => {
    // The last reply of a balance costs more than was left. The books say so;
    // the displayed balance is still zero, not minus something.
    const balance = walletBalance({ entries: [grant()], fundedSpentMicros: 512_000 });
    expect(balance.balanceMicros).toBe(0);
    expect(balance.overdrawnMicros).toBe(12_000);
  });

  it("takes the money back out when a top-up is refunded", () => {
    const refund: WalletEntry = { kind: "refund", amountMicros: -10_000_000, createdAt: at, reference: "pi_1" };
    const balance = walletBalance({ entries: [grant(), topup(10_000_000), refund], fundedSpentMicros: 0 });
    expect(balance.paidMicros).toBe(0);
    expect(balance.balanceMicros).toBe(500_000);
    // No money left in, so the generous daily rail goes away with it.
    expect(balance.funded).toBe(false);
  });

  it("treats an operator's goodwill as a grant, not as money paid", () => {
    const goodwill: WalletEntry = { kind: "adjustment", amountMicros: 250_000, createdAt: at, note: "sorry" };
    const balance = walletBalance({ entries: [goodwill], fundedSpentMicros: 0 });
    expect(balance.grantedMicros).toBe(250_000);
    expect(balance.funded).toBe(false);
  });

  it("ignores nonsense amounts instead of poisoning the balance", () => {
    const broken: WalletEntry = { kind: "grant", amountMicros: Number.NaN, createdAt: at };
    const balance = walletBalance({ entries: [grant(), broken], fundedSpentMicros: 0 });
    expect(balance.balanceMicros).toBe(500_000);
  });

  it("survives an empty ledger", () => {
    const balance = walletBalance({ entries: [], fundedSpentMicros: 0 });
    expect(balance.balanceMicros).toBe(0);
    expect(balance.funded).toBe(false);
  });
});

describe("walletDailyCapMicros", () => {
  it("rations USAGE's own money by the day", () => {
    expect(walletDailyCapMicros({ funded: false }, {})).toBe(FREE_DAILY_CAP_MICROS);
  });

  it("lifts the ceiling once somebody has paid in", () => {
    expect(walletDailyCapMicros({ funded: true }, {})).toBe(PAID_DAILY_CAP_MICROS);
  });

  it("takes a configured ceiling, and ignores a nonsensical one", () => {
    expect(walletDailyCapMicros({ funded: false }, { USAGE_CHAT_FUNDED_DAILY_CAP_MICROS: "1000" })).toBe(1000);
    expect(walletDailyCapMicros({ funded: true }, { USAGE_WALLET_PAID_DAILY_CAP_MICROS: "nope" })).toBe(PAID_DAILY_CAP_MICROS);
  });
});

describe("walletDecision", () => {
  const full = walletBalance({ entries: [grant()], fundedSpentMicros: 0 });

  it("allows a message when there is money, allowance and headroom", () => {
    const decision = walletDecision({ balance: full, spentTodayMicros: 0, requestsToday: 0, requestLimit: 60, env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.refusal).toBe(null);
  });

  it("refuses an empty wallet before anything else", () => {
    const empty = walletBalance({ entries: [grant()], fundedSpentMicros: 500_000 });
    const decision = walletDecision({ balance: empty, spentTodayMicros: 0, requestsToday: 0, requestLimit: 60, env: {} });
    expect(decision.refusal).toBe("empty");
  });

  it("closes the day at exactly the cap, not one message past it", () => {
    const decision = walletDecision({
      balance: full,
      spentTodayMicros: FREE_DAILY_CAP_MICROS,
      requestsToday: 0,
      requestLimit: 60,
      env: {},
    });
    expect(decision.refusal).toBe("daily_cap");
    expect(decision.remainingTodayMicros).toBe(0);
  });

  it("still counts messages, because a provider that reports no cost never fills the money cap", () => {
    const decision = walletDecision({ balance: full, spentTodayMicros: 0, requestsToday: 60, requestLimit: 60, env: {} });
    expect(decision.refusal).toBe("daily_requests");
  });

  it("gives a paid wallet the whole day", () => {
    const paid = walletBalance({ entries: [topup(10_000_000)], fundedSpentMicros: 0 });
    const decision = walletDecision({ balance: paid, spentTodayMicros: 1_000_000, requestsToday: 0, requestLimit: 60, env: {} });
    expect(decision.allowed).toBe(true);
    expect(decision.capMicros).toBe(PAID_DAILY_CAP_MICROS);
  });
});

describe("walletRefusalMessage", () => {
  it("tells a new account to connect a provider, not to buy something that is not for sale", () => {
    expect(walletRefusalMessage("empty", false)).toContain("Connect a paid provider");
    expect(walletRefusalMessage("empty", false)).not.toContain("Top it up");
  });

  it("tells somebody who has paid before that they can pay again", () => {
    expect(walletRefusalMessage("empty", true)).toContain("Top it up");
  });
});
