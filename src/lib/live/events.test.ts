import { describe, expect, it } from "vitest";
import { EMPTY_LIVE, applyLiveEvent, deriveMiningState, formatAge, formatElapsed, liveEstimate, miningTopic, type FailedEvent, type LiveModel, type MiningEvent, type OutcomeEvent, type ProgressEvent, type StartedEvent, type VerifyingEvent } from "./events";
import { LiveController } from "./controller";

/**
 * M16B — the live mining state model, pure. Identical in every tab, testable
 * without a browser, and never a source of economic truth.
 */

const base = { requestId: "req-1", route: "usage-miner → openrouter", provider: "openrouter", model: "openai/gpt-5-nano" };
const started = (seq = 0, at = 1000): StartedEvent => ({ ...base, name: "mining.request.started", seq, at, startedAt: at, eligibleRoute: true });
const progress = (seq: number, at: number, chars: number): ProgressEvent => ({ ...base, name: "mining.request.progress", seq, at, firstChunkAt: 1500, chunks: seq, streamedChars: chars });
const verifying = (seq: number, at: number): VerifyingEvent => ({ ...base, name: "mining.request.verifying", seq, at, terminalAt: at, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, providerCostMicros: 1 });
const outcome = (name: OutcomeEvent["name"], seq: number, at: number, reward: string): OutcomeEvent => ({
  ...base, name, seq, at, persistedAt: at, occurredAt: new Date(at).toISOString(), epochId: "epoch-2026-09-12", verificationStatus: "confirmed", economicStatus: reward === "eligible" ? "eligible" : "pending_cost",
  rewardStatus: reward, rewardReason: reward === "eligible" ? "metered_paid" : reward, protocolComputeMicros: 1, eligibleComputeMicros: reward === "eligible" ? 1 : 0, protocolComputePico: null, eligibleComputePico: null, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0,
});
const failed = (seq: number, at: number): FailedEvent => ({ ...base, name: "mining.request.failed", seq, at, status: 502, reason: "unreachable" });

function run(events: MiningEvent[], model: LiveModel = EMPTY_LIVE): LiveModel {
  return events.reduce((m, e) => applyLiveEvent(m, e), model);
}

describe("mining states", () => {
  it("connected but idle is READY, never mining; no route is DISCONNECTED", () => {
    expect(deriveMiningState({ ...EMPTY_LIVE, routeEligible: true })).toBe("READY");
    expect(deriveMiningState(EMPTY_LIVE)).toBe("DISCONNECTED");
  });

  it("request start → MINING_LIVE; terminal usage → VERIFYING; persisted eligible unit → VERIFIED", () => {
    const m1 = run([started()], { ...EMPTY_LIVE, routeEligible: true });
    expect(deriveMiningState(m1)).toBe("MINING_LIVE");
    const m2 = run([verifying(3, 5000)], m1);
    expect(deriveMiningState(m2)).toBe("VERIFYING");
    expect(m2.current?.verifying?.providerCostMicros).toBe(1);
    const m3 = run([outcome("mining.request.verified", 4, 6000, "eligible")], m2);
    expect(deriveMiningState(m3, 6500)).toBe("VERIFIED");
    // A completed outcome fades back to READY after 15 s; the route is still eligible.
    expect(deriveMiningState(m3, 6000 + 16_000)).toBe("READY");
    expect(m3.current).toBeNull();
    expect(m3.last?.outcome?.eligibleComputeMicros).toBe(1);
  });

  it("held funding → HELD; free/ineligible → INELIGIBLE; failed request → ERROR", () => {
    expect(deriveMiningState(run([started(), outcome("mining.request.held", 1, 2000, "held")]), 2500)).toBe("HELD");
    expect(deriveMiningState(run([started(), outcome("mining.request.ineligible", 1, 2000, "ineligible")]), 2500)).toBe("INELIGIBLE");
    expect(deriveMiningState(run([started(), failed(1, 2000)]), 2500)).toBe("ERROR");
  });

  it("a duplicate realtime delivery never double-applies, and an older seq never overwrites newer state", () => {
    const m = run([started(), progress(1, 1500, 40), progress(1, 1500, 40), verifying(2, 3000), progress(1, 1500, 40)]);
    expect(m.current?.state).toBe("VERIFYING");
    expect(m.current?.streamedChars).toBe(40);
    expect(Object.keys(m.seen)).toHaveLength(3);
  });

  it("the live estimate is never called verified and only appears from server-observed evidence", () => {
    const live = run([started(), progress(1, 1500, 400)]).current!;
    const est = liveEstimate(live, 400_000);
    expect(est.label).toMatch(/estimated/);
    expect(est.tokensEstimate).toBe(100);
    expect(est.computeMicrosEstimate).toBe(40);
    expect(liveEstimate(run([started()]).current!, 400_000).tokensEstimate).toBeNull();
    expect(liveEstimate(live, null).tokensEstimate).toBeNull();
    const verifyingState = run([started(), verifying(1, 3000)]).current!;
    expect(liveEstimate(verifyingState, 400_000).label).toMatch(/verifying/);
  });

  it("the timer is local: mm:ss from the started instant, and event age formats", () => {
    expect(formatElapsed(1000, 1000)).toBe("00:00");
    expect(formatElapsed(1000, 8400)).toBe("00:07");
    expect(formatElapsed(1000, 61_000)).toBe("01:00");
    expect(formatAge(5000, 5400)).toBe("<1s");
    expect(formatAge(5000, 9000)).toBe("4s");
  });

  it("topics are per user and nothing else", () => {
    expect(miningTopic("a")).toBe("mining:a");
    expect(miningTopic("a")).not.toBe(miningTopic("b"));
  });
});

describe("live controller: transport fallback and visibility", () => {
  it("polls every 5 s only while disconnected and visible; stops when realtime is back", () => {
    const c = new LiveController({ fallbackIntervalMs: 5000 });
    expect(c.pollIntervalMs()).toBe(0); // connected by default? no: unknown → no polling until told
    c.setRealtime("disconnected");
    c.setVisible(true);
    expect(c.pollIntervalMs()).toBe(5000);
    c.setVisible(false);
    expect(c.pollIntervalMs()).toBe(0);
    c.setVisible(true);
    c.setRealtime("connected");
    expect(c.pollIntervalMs()).toBe(0);
    expect(c.banner()).toBeNull();
    c.setRealtime("disconnected");
    expect(c.banner()).toBe("LIVE UPDATES RECONNECTING");
  });

  it("repaints once per second only while a request is live and the tab is visible", () => {
    const c = new LiveController({ fallbackIntervalMs: 5000 });
    c.setRealtime("connected");
    c.setVisible(true);
    expect(c.tickIntervalMs("READY")).toBe(0);
    expect(c.tickIntervalMs("MINING_LIVE")).toBe(1000);
    expect(c.tickIntervalMs("VERIFYING")).toBe(1000);
    c.setVisible(false);
    expect(c.tickIntervalMs("MINING_LIVE")).toBe(0);
  });

  it("a verified event or a visibility restore asks for exactly one authoritative refetch", () => {
    const c = new LiveController({ fallbackIntervalMs: 5000 });
    c.setRealtime("connected");
    expect(c.shouldRefetchAfter("mining.request.verified")).toBe(true);
    expect(c.shouldRefetchAfter("mining.request.progress")).toBe(false);
    expect(c.shouldRefetchAfter("mining.request.held")).toBe(true);
    c.setVisible(false);
    expect(c.onVisibilityRestored()).toBe(true);
  });
});
