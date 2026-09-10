/**
 * Live mining state (M16B).
 *
 * One shared, server-derived model of "what is happening with my AI usage
 * right now", carried to the browser as EPHEMERAL Realtime broadcast events.
 * Nothing here is economic authority: the database is the source of truth,
 * every amount below is either a labelled estimate or a copy of a persisted
 * authoritative value, and a live event can never create, move or double a
 * Usage Point.
 *
 * States
 *   DISCONNECTED  no usable economic route
 *   READY         route connected and economically eligible, nothing running
 *   MINING_LIVE   a request is flowing through a USAGE-controlled eligible route
 *   VERIFYING     the provider finished; authoritative economics are being persisted
 *   VERIFIED      the Economic Compute Unit is confirmed and reward-eligible
 *   HELD          compute happened, reward held by policy
 *   INELIGIBLE    compute happened, earns zero
 *   ERROR         the routed request failed
 *
 * CONNECTED never means MINING_LIVE. READY never shows compute being earned.
 */

export type MiningState = "DISCONNECTED" | "READY" | "MINING_LIVE" | "VERIFYING" | "VERIFIED" | "HELD" | "INELIGIBLE" | "ERROR";

/** Private per-user channel. The RLS policy on realtime.messages allows only auth.uid() = this user. */
export function miningTopic(userId: string): string {
  return `mining:${userId}`;
}

export const MINING_EVENT_NAMES = ["mining.request.started", "mining.request.progress", "mining.request.verifying", "mining.request.verified", "mining.request.held", "mining.request.ineligible", "mining.request.failed"] as const;
export type MiningEventName = (typeof MINING_EVENT_NAMES)[number];

/**
 * SAFE fields only. No prompt, no completion, no credential, no header, no
 * economic identity that could be replayed. `requestId` is a server-minted
 * ephemeral id used purely for UI correlation; it is not an economic unit.
 */
export interface MiningEventBase {
  /** Monotonic per request, so a duplicate or late event is recognisable. */
  seq: number;
  requestId: string;
  /** Route label the server derived, e.g. "usage-miner → openrouter". */
  route: string;
  provider: string;
  model: string | null;
  /** Server wall-clock millis when the event was emitted. */
  at: number;
}

export interface StartedEvent extends MiningEventBase { name: "mining.request.started"; startedAt: number; eligibleRoute: boolean }
export interface ProgressEvent extends MiningEventBase { name: "mining.request.progress"; firstChunkAt: number | null; chunks: number; streamedChars: number }
export interface VerifyingEvent extends MiningEventBase {
  name: "mining.request.verifying";
  terminalAt: number;
  /** Provider-reported usage from the terminal response: authoritative for the provider, not yet persisted. */
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; reasoningTokens: number | null;
  providerCostMicros: number | null;
}
export interface OutcomeEvent extends MiningEventBase {
  name: "mining.request.verified" | "mining.request.held" | "mining.request.ineligible";
  persistedAt: number;
  occurredAt: string;
  epochId: string | null;
  verificationStatus: string;
  economicStatus: string;
  rewardStatus: string;
  rewardReason: string | null;
  protocolComputeMicros: number | null;
  eligibleComputeMicros: number;
  protocolComputePico: string | null;
  eligibleComputePico: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
}
export interface FailedEvent extends MiningEventBase { name: "mining.request.failed"; status: number; reason: string }

export type MiningEvent = StartedEvent | ProgressEvent | VerifyingEvent | OutcomeEvent | FailedEvent;

/** What the browser keeps per request. */
export interface LiveRequest {
  requestId: string;
  route: string;
  provider: string;
  model: string | null;
  startedAt: number;
  firstChunkAt: number | null;
  terminalAt: number | null;
  persistedAt: number | null;
  chunks: number;
  streamedChars: number;
  lastSeq: number;
  lastEventAt: number;
  state: Exclude<MiningState, "DISCONNECTED" | "READY">;
  verifying: VerifyingEvent | null;
  outcome: OutcomeEvent | null;
  failure: FailedEvent | null;
}

export interface LiveModel {
  /** Whether any eligible route exists (from the authoritative summary, not from events). */
  routeEligible: boolean;
  current: LiveRequest | null;
  /** Most recent completed request, for the "✓ COMPUTE VERIFIED … 2 seconds ago" line. */
  last: LiveRequest | null;
  /** Ids seen, so a duplicate delivery never double-applies. */
  seen: Record<string, number>;
}

export const EMPTY_LIVE: LiveModel = { routeEligible: false, current: null, last: null, seen: {} };

export function deriveMiningState(model: LiveModel, now: number = Date.now()): MiningState {
  if (model.current) return model.current.state;
  if (model.last && now - (model.last.persistedAt ?? model.last.lastEventAt) < 15_000) return model.last.state;
  return model.routeEligible ? "READY" : "DISCONNECTED";
}

function fresh(e: MiningEvent): LiveRequest {
  return {
    requestId: e.requestId, route: e.route, provider: e.provider, model: e.model,
    startedAt: e.name === "mining.request.started" ? e.startedAt : e.at,
    firstChunkAt: null, terminalAt: null, persistedAt: null, chunks: 0, streamedChars: 0,
    lastSeq: -1, lastEventAt: e.at, state: "MINING_LIVE", verifying: null, outcome: null, failure: null,
  };
}

/**
 * Apply one event. Idempotent: the same (requestId, seq) twice is a no-op,
 * and an older seq never overwrites a newer state. Pure, so it is testable
 * without a browser and identical in every tab.
 */
export function applyLiveEvent(model: LiveModel, e: MiningEvent): LiveModel {
  const key = `${e.requestId}:${e.seq}`;
  if (model.seen[key]) return model;
  const seen = { ...model.seen, [key]: e.at };

  const existing = model.current?.requestId === e.requestId ? model.current : model.last?.requestId === e.requestId ? model.last : null;
  const base = existing ?? fresh(e);
  if (e.seq <= base.lastSeq) return { ...model, seen };
  const next: LiveRequest = { ...base, lastSeq: e.seq, lastEventAt: e.at, model: e.model ?? base.model, route: e.provider === "resolving" ? base.route : e.route, provider: e.provider === "resolving" ? base.provider : e.provider };

  switch (e.name) {
    case "mining.request.started":
      next.startedAt = e.startedAt;
      next.state = "MINING_LIVE";
      break;
    case "mining.request.progress":
      next.firstChunkAt = next.firstChunkAt ?? e.firstChunkAt;
      next.chunks = Math.max(next.chunks, e.chunks);
      next.streamedChars = Math.max(next.streamedChars, e.streamedChars);
      if (next.state === "MINING_LIVE") next.state = "MINING_LIVE";
      break;
    case "mining.request.verifying":
      next.terminalAt = e.terminalAt;
      next.verifying = e;
      if (next.state === "MINING_LIVE" || next.state === "VERIFYING") next.state = "VERIFYING";
      break;
    case "mining.request.verified":
    case "mining.request.held":
    case "mining.request.ineligible":
      next.persistedAt = e.persistedAt;
      next.outcome = e;
      next.state = e.name === "mining.request.verified" ? "VERIFIED" : e.name === "mining.request.held" ? "HELD" : "INELIGIBLE";
      break;
    case "mining.request.failed":
      next.failure = e;
      next.state = "ERROR";
      break;
  }

  const terminal = next.state === "VERIFIED" || next.state === "HELD" || next.state === "INELIGIBLE" || next.state === "ERROR";
  if (terminal) {
    return { ...model, seen, current: model.current?.requestId === e.requestId ? null : model.current, last: next };
  }
  return { ...model, seen, current: next, last: model.last?.requestId === e.requestId ? null : model.last };
}

/** mm:ss for the live timer; purely local, repainted by the browser each second. */
export function formatElapsed(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatAge(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * The live ESTIMATE while a request runs. Honest about its inputs: before the
 * terminal usage arrives, OpenRouter has told us nothing about tokens, so the
 * only server-observed evidence is elapsed time and streamed characters. A
 * rough tokens ≈ chars/4 estimate is offered ONLY when an output price is
 * known and only labelled "~ estimated"; it is never persisted and never
 * called verified. With no streamed text it shows activity, not numbers.
 */
export function liveEstimate(req: LiveRequest, outputMicrosPerMillion: number | null): { label: string; computeMicrosEstimate: number | null; tokensEstimate: number | null } {
  if (req.verifying && req.verifying.providerCostMicros !== null) {
    return { label: "provider usage received, verifying", computeMicrosEstimate: null, tokensEstimate: null };
  }
  if (req.streamedChars > 0 && outputMicrosPerMillion !== null) {
    const tokens = Math.max(1, Math.round(req.streamedChars / 4));
    return { label: "~ estimated from streamed text", computeMicrosEstimate: Math.round((tokens * outputMicrosPerMillion) / 1_000_000), tokensEstimate: tokens };
  }
  return { label: req.firstChunkAt ? "streaming" : "waiting for the model", computeMicrosEstimate: null, tokensEstimate: null };
}
