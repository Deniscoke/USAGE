import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { after } from "next/server";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * Operational logging and the development observation sink.
 *
 * WHAT MAY BE LOGGED: request id, internal user id, model, status, latency,
 * generation id, token totals, cost.
 * WHAT MAY NEVER BE LOGGED: prompts, responses, tool arguments, file contents,
 * API keys, miner tokens. Nothing here ever touches a request or response body,
 * which is the only reliable way to keep that promise.
 */

/**
 * Run work after the response has been sent.
 *
 * A serverless function is frozen the moment its response completes, so a plain
 * fire-and-forget promise is never finished -- the usage write silently
 * disappears. `after()` keeps the invocation alive until the work lands.
 *
 * Outside a request scope (unit tests, scripts) `after()` throws; there the
 * plain promise is correct, because nothing is about to freeze.
 */
export function scheduleAfterResponse(work: Promise<unknown>): void {
  try {
    after(work);
  } catch {
    void work;
  }
}

export interface GatewayLogFields {
  requestId: string;
  userId?: string;
  path: string;
  status: number;
  latencyMs: number;
  streaming?: boolean;
  model?: string | null;
  generationId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costMicroUsd?: number | null;
  outcome: string;
}

export function logGatewayRequest(fields: GatewayLogFields): void {
  // One structured line. No body, no headers, no credentials.
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`);
}

/**
 * Development sink.
 *
 * Without a hosted database there is nowhere trustworthy to persist proofs, so
 * local observations are appended to a gitignored JSONL file. This is an
 * inspection artifact, NOT production proof storage: everything written here is
 * development-trust evidence and earns nothing.
 */
export function devObservationLogPath(): string {
  return (
    process.env.USAGE_DEV_OBSERVATION_LOG ||
    path.join(process.cwd(), ".usage", "observations.jsonl")
  );
}

export async function appendDevObservation(observation: GatewayObservation): Promise<void> {
  const target = devObservationLogPath();
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(observation)}\n`, "utf8");
}

/**
 * Per-credential rate limiting, in memory.
 *
 * Deliberately simple: one process, one map. A distributed limiter is a real
 * requirement for hosted USAGE and a distraction here -- what matters now is
 * that the shape exists and abuse of a single miner credential is bounded.
 */
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = Number(process.env.USAGE_MINER_RPM ?? 120);

const windows = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  credentialId: string,
  limit = DEFAULT_LIMIT,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = windows.get(credentialId);

  if (!existing || existing.resetAt <= now) {
    windows.set(credentialId, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetRateLimits(): void {
  windows.clear();
}
