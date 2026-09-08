/**
 * Database types.
 *
 * Regenerate from the running local stack with `npm run db:types`
 * (`supabase gen types typescript --local`). This file is the single obvious
 * location for them; it is hand-maintained until a local stack is available,
 * and it must stay in sync with supabase/migrations.
 *
 * Note on numbers: PostgREST returns `bigint` as a JSON number. Every micro-USD
 * and token value passes through `toSafeInteger` in src/lib/db/rows.ts, which
 * rejects anything outside the exact integer range rather than silently
 * losing precision.
 */

/**
 * Row and Insert shapes are `type` aliases, not interfaces, on purpose: the
 * PostgREST generics require `Record<string, unknown>`, and TypeScript only
 * gives implicit index signatures to type aliases. An interface here silently
 * resolves the whole schema to `never`.
 */
export type VerificationTypeRow = "verified" | "routed" | "reported";
export type VerificationStatusRow = "confirmed" | "pending" | "unverifiable";
export type UsageSourceRow =
  | "provider_usage_api"
  | "provider_cost_api"
  | "org_analytics_api"
  | "gateway"
  | "vercel_ai_gateway"
  | "local_client"
  | "imported_report";
export type ConnectionStatusRow = "active" | "error" | "revoked";
export type EconomicStatusRow =
  | "eligible"
  | "pending_pricing"
  | "pending_cost"
  | "settled"
  | "ineligible";
export type ProofStatusRow = "observed" | "confirmed" | "rejected";

export type MinerCredentialRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type MinerCredentialInsertRow = {
  user_id: string;
  name?: string;
  token_hash: string;
  token_prefix: string;
};

export type ProfileRow = {
  id: string;
  handle: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export type ProviderConnectionRow = {
  id: string;
  user_id: string;
  provider: string;
  account_label: string | null;
  status: ConnectionStatusRow;
  config: Record<string, unknown>;
  secret_ref: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

export type UsageEventRow = {
  id: string;
  user_id: string;
  connection_id: string | null;
  provider: string;
  source: UsageSourceRow;
  external_reference: string;
  model: string;
  occurred_at: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  requests: number;
  reported_cost_micros: number | null;
  normalized_cost_micros: number;
  verification_type: VerificationTypeRow;
  verification_status: VerificationStatusRow;
  economic_status: EconomicStatusRow;
  protocol_compute_micros: number;
  protocol_pricing_version: string | null;
  protocol_pricing_basis: string | null;
  epoch_id: string | null;
  carried_forward: boolean;
  fraud_status: string;
  reward_hold: boolean;
  raw_metadata: Record<string, string | number | boolean | null>;
  created_at: string;
}

export type UsageDailyAggregateRow = {
  user_id: string;
  day: string;
  provider: string;
  model: string;
  verification_type: VerificationTypeRow;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  updated_at: string;
}

export type ProofRecordRow = {
  id: string;
  user_id: string;
  usage_event_id: string;
  verification_type: VerificationTypeRow;
  proof_kind: string;
  proof_source: string | null;
  external_reference: string | null;
  observed_at: string | null;
  ingested_at: string;
  adapter_version: string | null;
  proof_hash: string | null;
  trust_environment: string | null;
  proof_status: ProofStatusRow;
  receipt_id: string | null;
  receipt_version: string | null;
  issuer: string | null;
  issuer_key_id: string | null;
  signature: string | null;
  signed_at: string | null;
  proof_metadata: Record<string, string | number | boolean | null>;
  created_at: string;
};

export type ProofRecordInsertRow = {
  user_id: string;
  usage_event_id: string;
  verification_type: VerificationTypeRow;
  proof_kind: string;
  proof_source?: string | null;
  external_reference?: string | null;
  observed_at?: string | null;
  adapter_version?: string | null;
  proof_hash?: string | null;
  trust_environment?: string | null;
  proof_status?: ProofStatusRow;
  receipt_id?: string | null;
  receipt_version?: string | null;
  issuer?: string | null;
  issuer_key_id?: string | null;
  signature?: string | null;
  signed_at?: string | null;
  proof_metadata?: Record<string, string | number | boolean | null>;
};

export type ScoreRecordRow = {
  id: string;
  user_id: string;
  day: string;
  algorithm_version: string;
  weighted_cost_micros: number;
  excluded_cost_micros: number;
  pending_cost_micros: number;
  /** numeric(20,4) — PostgREST returns numeric as a string. */
  points: string | number;
  created_at: string;
}

export type EpochStateRow = "open" | "finalizing" | "settled";

export type RewardEpochRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  reward_pool_points: number;
  scoring_version: string;
  network_score: string | number;
  settled_at: string | null;
  finalizing_at: string | null;
  state: EpochStateRow;
  pricing_version: string | null;
  epoch_kind: string;
}

export type UsagePointLedgerRow = {
  id: string;
  user_id: string;
  epoch_id: string;
  allocation_id: string;
  amount: number;
  reason: string;
  created_at: string;
}

export type UsagePointLedgerInsertRow = {
  user_id: string;
  epoch_id: string;
  allocation_id: string;
  amount: number;
  reason: string;
}

export type ProtocolPricingVersionRow = {
  version: string;
  source: string;
  effective_from: string;
  captured_at: string;
  status: string;
  created_at: string;
}

export type ProtocolModelPriceRow = {
  pricing_version: string;
  model: string;
  provider_family: string;
  input_micros_per_million: number;
  output_micros_per_million: number;
  cache_read_micros_per_million: number | null;
  cache_write_micros_per_million: number | null;
  reasoning_micros_per_million: number | null;
}

export type RewardAllocationRow = {
  epoch_id: string;
  user_id: string;
  score: string | number;
  network_share: string | number;
  points: number;
  created_at: string;
}

/**
 * Insert shapes are written out explicitly rather than derived with `Omit<Row>`:
 * the PostgREST client's excess-property check resolves mapped types like Omit
 * to `never`, which silently turns every insert into a type error.
 */
export type UsageEventInsertRow = {
  id?: string;
  user_id: string;
  connection_id?: string | null;
  provider: string;
  source: UsageSourceRow;
  external_reference: string;
  model: string;
  occurred_at: string;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  requests?: number;
  reported_cost_micros?: number | null;
  normalized_cost_micros?: number;
  verification_type: VerificationTypeRow;
  verification_status?: VerificationStatusRow;
  economic_status?: EconomicStatusRow;
  protocol_compute_micros?: number;
  protocol_pricing_version?: string | null;
  protocol_pricing_basis?: string | null;
  epoch_id?: string | null;
  carried_forward?: boolean;
  raw_metadata?: Record<string, string | number | boolean | null>;
}

export type UsageDailyAggregateInsertRow = {
  user_id: string;
  day: string;
  provider: string;
  model: string;
  verification_type: VerificationTypeRow;
  requests?: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  cost_micros?: number;
  updated_at?: string;
}

export type ScoreRecordInsertRow = {
  id?: string;
  user_id: string;
  day: string;
  algorithm_version: string;
  weighted_cost_micros?: number;
  excluded_cost_micros?: number;
  pending_cost_micros?: number;
  points?: number | string;
}

export type RewardAllocationInsertRow = {
  epoch_id: string;
  user_id: string;
  score?: number | string;
  network_share?: number | string;
  points?: number;
}

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Partial<ProfileRow> & { id: string };
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      provider_connections: {
        Row: ProviderConnectionRow;
        Insert: Partial<ProviderConnectionRow> & { user_id: string; provider: string };
        Update: Partial<ProviderConnectionRow>;
        Relationships: [];
      };
      usage_events: {
        Row: UsageEventRow;
        Insert: UsageEventInsertRow;
        Update: Partial<UsageEventRow>;
        Relationships: [];
      };
      usage_daily_aggregates: {
        Row: UsageDailyAggregateRow;
        Insert: UsageDailyAggregateInsertRow;
        Update: Partial<UsageDailyAggregateRow>;
        Relationships: [];
      };
      usage_miner_credentials: {
        Row: MinerCredentialRow;
        Insert: MinerCredentialInsertRow;
        Update: Partial<MinerCredentialRow>;
        Relationships: [];
      };
      proof_records: {
        Row: ProofRecordRow;
        Insert: ProofRecordInsertRow;
        Update: Partial<ProofRecordRow>;
        Relationships: [];
      };
      score_records: {
        Row: ScoreRecordRow;
        Insert: ScoreRecordInsertRow;
        Update: Partial<ScoreRecordRow>;
        Relationships: [];
      };
      reward_epochs: {
        Row: RewardEpochRow;
        Insert: Partial<RewardEpochRow> & { id: string; starts_at: string; ends_at: string };
        Update: Partial<RewardEpochRow>;
        Relationships: [];
      };
      usage_point_ledger: {
        Row: UsagePointLedgerRow;
        Insert: UsagePointLedgerInsertRow;
        Update: Partial<UsagePointLedgerRow>;
        Relationships: [];
      };
      protocol_pricing_versions: {
        Row: ProtocolPricingVersionRow;
        Insert: Partial<ProtocolPricingVersionRow> & { version: string; source: string; effective_from: string; captured_at: string };
        Update: Partial<ProtocolPricingVersionRow>;
        Relationships: [];
      };
      protocol_model_prices: {
        Row: ProtocolModelPriceRow;
        Insert: ProtocolModelPriceRow;
        Update: Partial<ProtocolModelPriceRow>;
        Relationships: [];
      };
      reward_allocations: {
        Row: RewardAllocationRow;
        Insert: RewardAllocationInsertRow;
        Update: Partial<RewardAllocationRow>;
        Relationships: [];
      };
    };
    // `{ [_ in never]: never }` (not Record<string, never>) — the client
    // intersects Tables & Views, and an index signature would poison every row
    // type with `never`.
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: {
      verification_type: VerificationTypeRow;
      verification_status: VerificationStatusRow;
      usage_source: UsageSourceRow;
      connection_status: ConnectionStatusRow;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
