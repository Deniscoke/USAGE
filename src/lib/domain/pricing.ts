import { microsPerMillionTokens } from "./money";

/**
 * Fallback pricing used only when a source reports usage without cost
 * (e.g. a local CLI). Rates are micro-USD per 1M tokens and are ESTIMATES:
 * anything priced from this table is never treated as authoritative money.
 */
export interface ModelRate {
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}

const RATES: Record<string, ModelRate> = {
  "demo-large": { inputMicrosPerMillion: 3_000_000, cachedInputMicrosPerMillion: 300_000, outputMicrosPerMillion: 15_000_000 },
  "demo-medium": { inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 100_000, outputMicrosPerMillion: 5_000_000 },
  "demo-small": { inputMicrosPerMillion: 250_000, cachedInputMicrosPerMillion: 30_000, outputMicrosPerMillion: 1_250_000 },
};

const FALLBACK: ModelRate = RATES["demo-medium"];

export function rateForModel(model: string): ModelRate {
  return RATES[model] ?? FALLBACK;
}

export function estimateCostMicros(input: {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const rate = rateForModel(input.model);
  return (
    microsPerMillionTokens(rate.inputMicrosPerMillion, input.inputTokens) +
    microsPerMillionTokens(rate.cachedInputMicrosPerMillion, input.cachedInputTokens) +
    microsPerMillionTokens(rate.outputMicrosPerMillion, input.outputTokens)
  );
}
