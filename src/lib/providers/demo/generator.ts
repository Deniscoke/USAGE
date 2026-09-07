import { estimateCostMicros } from "@/lib/domain/pricing";
import { hashSeed, intBetween, mulberry32, pick } from "../random";
import type { UsageWindow } from "../adapter";

/**
 * Deterministic synthetic activity shared by the demo adapters.
 *
 * Shaped to look like real agentic workloads: weekday-heavy, bursty, dominated
 * by cached input reads, with a mild upward trend over time.
 */

export interface DemoProfile {
  provider: string;
  models: readonly { model: string; share: number }[];
  /** Rough number of hourly buckets emitted per day. */
  bucketsPerDay: [min: number, max: number];
  requestsPerBucket: [min: number, max: number];
  inputTokensPerRequest: [min: number, max: number];
  cacheHitRatio: number;
  outputTokensPerRequest: [min: number, max: number];
  /** Multiplier applied to estimated cost to mimic provider list pricing. */
  costMultiplier: number;
}

export interface DemoBucket {
  occurredAt: string;
  model: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicros: number;
}

function weekdayFactor(date: Date): number {
  const day = date.getUTCDay();
  if (day === 0) return 0.35;
  if (day === 6) return 0.45;
  return 1;
}

function pickModel(rng: () => number, models: DemoProfile["models"]): string {
  const total = models.reduce((acc, m) => acc + m.share, 0);
  let roll = rng() * total;
  for (const m of models) {
    roll -= m.share;
    if (roll <= 0) return m.model;
  }
  return models[models.length - 1].model;
}

export function generateDemoBuckets(profile: DemoProfile, window: UsageWindow): DemoBucket[] {
  const buckets: DemoBucket[] = [];
  const dayMs = 24 * 60 * 60 * 1000;

  const firstDay = Date.UTC(
    window.since.getUTCFullYear(),
    window.since.getUTCMonth(),
    window.since.getUTCDate(),
  );

  for (let ts = firstDay; ts < window.until.getTime(); ts += dayMs) {
    const date = new Date(ts);
    const day = date.toISOString().slice(0, 10);
    const rng = mulberry32(hashSeed(profile.provider, day));

    // Slow ramp: usage roughly doubles across a 90-day history.
    const ageDays = Math.max(0, (window.until.getTime() - ts) / dayMs);
    const trend = 1.15 - Math.min(0.5, ageDays / 260);
    const intensity = weekdayFactor(date) * trend * (0.75 + rng() * 0.5);

    const bucketCount = Math.max(
      1,
      Math.round(intBetween(rng, profile.bucketsPerDay[0], profile.bucketsPerDay[1]) * intensity),
    );

    const hours = new Set<number>();
    for (let i = 0; i < bucketCount; i++) {
      // Working-hours-weighted, still deterministic.
      hours.add(Math.min(23, Math.max(0, Math.round(8 + (rng() - 0.5) * 22))));
    }

    for (const hour of [...hours].sort((a, b) => a - b)) {
      const occurredAt = new Date(ts + hour * 60 * 60 * 1000).toISOString();
      const model = pickModel(rng, profile.models);
      const requests = Math.max(
        1,
        Math.round(
          intBetween(rng, profile.requestsPerBucket[0], profile.requestsPerBucket[1]) * intensity,
        ),
      );

      const rawInput =
        requests * intBetween(rng, profile.inputTokensPerRequest[0], profile.inputTokensPerRequest[1]);
      const cachedInputTokens = Math.round(rawInput * profile.cacheHitRatio);
      const inputTokens = rawInput - cachedInputTokens;
      const outputTokens =
        requests *
        intBetween(rng, profile.outputTokensPerRequest[0], profile.outputTokensPerRequest[1]);

      const costMicros = Math.round(
        estimateCostMicros({ model, inputTokens, cachedInputTokens, outputTokens }) *
          profile.costMultiplier,
      );

      buckets.push({
        occurredAt,
        model,
        requests,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costMicros,
      });
    }
  }

  return buckets.filter((b) => {
    const at = new Date(b.occurredAt).getTime();
    return at >= window.since.getTime() && at < window.until.getTime();
  });
}

export { pick };
