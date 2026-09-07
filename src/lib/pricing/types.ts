/**
 * Protocol pricing.
 *
 * The economic basis for mining is PROTOCOL COMPUTE VALUE, not what anyone was
 * billed. Two identical requests must mine identically, whether one was paid at
 * list price and the other covered by BYOK, promotional credits, an enterprise
 * discount or free-tier credit. Actual cost is analytics; this is the protocol.
 *
 * All values are integer micro-USD per million tokens. No floats anywhere in
 * the economic path.
 */

export interface ProtocolModelPrice {
  model: string;
  providerFamily: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  /** null means the provider does not price this separately. */
  cacheReadMicrosPerMillion: number | null;
  cacheWriteMicrosPerMillion: number | null;
  /** Reasoning tokens are billed as output unless a provider says otherwise. */
  reasoningMicrosPerMillion?: number | null;
}

export interface ProtocolPricingSnapshot {
  version: string;
  source: string;
  /** ISO date the snapshot takes effect from. */
  effectiveFrom: string;
  capturedAt: string;
  prices: readonly ProtocolModelPrice[];
}
