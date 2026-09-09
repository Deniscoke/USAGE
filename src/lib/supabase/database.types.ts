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

/**
 * What a device credential may do. There is deliberately no scope for account
 * settings, provider secrets, proof creation, reward changes, settlement, or
 * another user's data -- those abilities are not expressible here at all.
 */
export type MinerScope =
  | "miner:route"
  | "miner:config"
  | "miner:heartbeat"
  | "miner:rotate"
  | "miner:telemetry"
  | "miner:mappings";

export type VerificationLevelRow =
  | "local_observed"
  | "device_attested"
  | "provider_correlated"
  | "routed_confirmed"
  | "provider_verified_import";
export type CorrelationStatusRow = "none" | "pending" | "matched" | "unmatched";
export type MeteringMethodRow = "native_otel" | "routed" | "provider_import" | "local_observed" | "unsupported";
export type MappingStatusRow = "enabled" | "disabled";

export type MinerToolMappingRow = {
  id: string;
  device_id: string;
  user_id: string;
  tool_id: string;
  tool_version: string | null;
  metering_method: MeteringMethodRow;
  status: MappingStatusRow;
  verification_capability: VerificationLevelRow;
  enabled_at: string;
  disabled_at: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * What a paired device reported. Analytics and provenance only: this row has
 * no proof, economic, pricing or reward columns, and never will.
 */
export type LocalUsageObservationRow = {
  id: string;
  user_id: string;
  device_id: string;
  mapping_id: string | null;
  schema_version: string;
  adapter: string;
  tool_id: string;
  tool_version: string | null;
  source_type: string;
  provider: string;
  model: string | null;
  upstream_request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  tool_tokens: number | null;
  estimated_cost_micros: number | null;
  occurred_at: string;
  local_session_id: string;
  local_event_id: string;
  device_signature: string | null;
  signature_verified: boolean;
  verification_level: VerificationLevelRow;
  correlation_status: CorrelationStatusRow;
  correlated_event_id: string | null;
  provider_identity_hash: string | null;
  received_at: string;
};

/** Schema readiness only. No route writes it and nothing economic reads it. */
export type WalletConnectionRow = {
  id: string;
  user_id: string;
  chain_namespace: string;
  chain_id: string;
  address: string;
  verified_at: string | null;
  verification_method: string | null;
  created_at: string;
  revoked_at: string | null;
};

export type MinerCredentialRow = {
  device_id?: string | null;
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes: MinerScope[];
  rotated_to: string | null;
  rotated_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type MinerCredentialInsertRow = {
  user_id: string;
  name?: string;
  token_hash: string;
  token_prefix: string;
  scopes?: MinerScope[];
};

export type ProfileRow = {
  id: string;
  handle: string | null;
  display_name: string | null;
  /** Nullable label only. USAGE holds no keys and takes no custody. */
  wallet_address: string | null;
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
  method: "routed_mining" | "verified_import" | "byok" | "subscription";
  definition_id: string | null;
  protocol: ProviderProtocolRow | null;
  base_url: string | null;
  /** Handle into provider_secrets. Never a credential. */
  secret_id: string | null;
  connection_status: ConnectionStatusDetailRow;
  /** How the connection was authorized: a pasted key, or one-click OAuth. */
  auth_method: "api_key" | "oauth";
  /** Non-secret account context from the provider, e.g. tier and spend. */
  account_context: Record<string, unknown> | null;
  capabilities: Record<string, boolean>;
  mining_eligibility: MiningEligibilityRow;
  validated_at: string | null;
  revoked_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

/**
 * Whether `protocol_compute_micros` is a price, the absence of one, or a record
 * too old to tell the two apart.
 */
export type PricingStatusRow = "priced" | "pending_pricing" | "unknown_legacy";

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
  actual_cost_micros: number | null;
  actual_cost_basis: string | null;
  normalized_cost_micros: number;
  verification_type: VerificationTypeRow;
  verification_status: VerificationStatusRow;
  economic_status: EconomicStatusRow;
  /** NULL means no approved price exists. A real 0 means priced at zero. */
  protocol_compute_micros: number | null;
  pricing_status: PricingStatusRow;
  protocol_pricing_version: string | null;
  protocol_pricing_basis: string | null;
  epoch_id: string | null;
  carried_forward: boolean;
  gateway_id: string | null;
  economic_source_class: EconomicSourceClassRow;
  eligible_compute_micros: number;
  reward_status: RewardStatusRow;
  reward_reason: string | null;
  reward_policy_version: string | null;
  reconciliation_status: ReconciliationStatusRow;
  fraud_status: string;
  reward_hold: boolean;
  raw_metadata: Record<string, string | number | boolean | null>;
  /** Where the evidence came from, e.g. ["usage_gateway", "local_telemetry"]. */
  provenance_sources: string[];
  verification_level: VerificationLevelRow | null;
  correlation_status: CorrelationStatusRow;
  identity_trust_level: string;
  provider_identity_hash: string | null;
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

export type ProviderProtocolRow =
  | "openai_compatible"
  | "anthropic_compatible"
  | "usage_import"
  | "custom_unsupported";

export type ConnectionStatusDetailRow =
  | "validating"
  | "active"
  | "limited"
  | "invalid_credentials"
  | "unsupported_usage"
  | "pending_pricing"
  | "error"
  | "revoked";

export type MiningEligibilityRow =
  | "eligible_route"
  | "pending_pricing"
  | "analytics_only"
  | "unsupported";

export type ProviderDefinitionRow = {
  id: string;
  slug: string;
  display_name: string;
  provider_family: string | null;
  protocol: ProviderProtocolRow;
  origin: "official" | "community_supported" | "custom";
  default_base_url: string | null;
  owner_user_id: string | null;
  supports_models: boolean;
  supports_streaming: boolean;
  supports_usage: boolean;
  supports_request_identity: boolean;
  supports_cost: boolean;
  supports_cache_usage: boolean;
  supports_reasoning_usage: boolean;
  verification_capability: VerificationTypeRow;
  status: "active" | "deprecated" | "blocked";
  created_at: string;
  updated_at: string;
}

/** Ciphertext only. No client role can select from this table. */
export type ProviderSecretRow = {
  id: string;
  user_id: string;
  /** Null when the value lives in Vault rather than in this column. */
  ciphertext: string | null;
  hint: string | null;
  backend: "aes" | "vault";
  created_at: string;
  rotated_at: string | null;
}

export type MinerDeviceRow = {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  app_version: string;
  credential_id: string | null;
  enabled_tools: string[];
  public_key: string | null;
  public_key_algorithm: string | null;
  public_key_registered_at: string | null;
  os: string | null;
  /** Safe state from the heartbeat: [{tool, version, detected, mapped}]. */
  tool_state: { tool: string; version: string | null; detected: boolean; mapped: boolean }[];
  last_usage_event_at: string | null;
  device_trust_level: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export type MinerPairingRequestRow = {
  id: string;
  user_code: string;
  poll_token_hash: string;
  device_name: string;
  platform: string;
  app_version: string;
  approved_by: string | null;
  approved_at: string | null;
  credential_id: string | null;
  device_id: string | null;
  /** Held for one collection only. Never returned to a browser. */
  pending_token: string | null;
  collected_at: string | null;
  denied_at: string | null;
  created_at: string;
  expires_at: string;
}

export type MinerProtocolVersionRow = {
  version: string;
  minimum_supported: string;
  released_at: string;
  notes: string | null;
  created_at: string;
}

export type ProviderOAuthRequestRow = {
  state: string;
  user_id: string;
  provider_slug: string;
  /** Server-only PKCE verifier. No client role can read this table. */
  code_verifier: string;
  redirect_to: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export type ProviderModelRow = {
  id: string;
  definition_id: string;
  upstream_model_id: string;
  display_name: string | null;
  protocol_model_key: string | null;
  enabled: boolean;
  status: "discovered" | "enabled" | "disabled" | "unsupported";
  discovered_at: string;
}

export type EconomicSourceClassRow =
  | "metered_paid"
  | "byok"
  | "subscription"
  | "free"
  | "promotional"
  | "unknown";

export type RewardStatusRow = "eligible" | "held" | "ineligible";

export type RewardPolicyVersionRow = {
  version: string;
  effective_from: string;
  status: "active" | "superseded";
  description: string;
  created_at: string;
}

export type ReconciliationStatusRow =
  | "clear"
  | "matched"
  | "possible_overlap"
  | "held"
  | "resolved";

export type RouteStatusRow =
  | "live"
  | "tested"
  | "configured"
  | "available"
  | "coming_soon"
  | "unsupported";

export type ProviderRouteRow = {
  provider_slug: string;
  gateway: string;
  status: RouteStatusRow;
  auth_requirement: string;
  cost_availability: "authoritative" | "unavailable";
  note: string | null;
  updated_at: string;
}

export type MethodAvailabilityRow = "available" | "experimental" | "coming_soon" | "unsupported";

export type ProviderRow = {
  slug: string;
  name: string;
  category: string;
  status: string;
  integration_version: string;
  byok: MethodAvailabilityRow;
  subscription: MethodAvailabilityRow;
  import_status: RouteStatusRow;
  import_source: string | null;
  import_account_requirement: string | null;
  import_granularity: "per_generation" | "provider_aggregate" | null;
  import_cost_availability: string | null;
  usage_fields: string[];
  cost_fields: string[];
  updated_at: string;
}

export type MiningProtocolVersionRow = {
  version: string;
  epoch_duration_seconds: number;
  epoch_emission_points: number;
  scoring_version: string;
  pricing_version: string;
  effective_from: string;
  network: "development" | "production";
  status: "active" | "superseded";
  created_at: string;
}

export type PointBalanceSnapshotRow = {
  user_id: string;
  epoch_id: string;
  points_credited: number;
  balance_after: number;
  created_at: string;
}

/** Aggregate-only view: totals for an epoch, never per-user rows. */
export type EpochNetworkTotalsRow = {
  day: string;
  algorithm_version: string;
  network_score: string | number;
  participants: number;
}

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
  protocol_version: string | null;
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
  pricing_status?: PricingStatusRow;
  provenance_sources?: string[];
  verification_level?: VerificationLevelRow | null;
  correlation_status?: CorrelationStatusRow;
  identity_trust_level?: string;
  provider_identity_hash?: string | null;
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
  actual_cost_micros?: number | null;
  actual_cost_basis?: string | null;
  normalized_cost_micros?: number;
  verification_type: VerificationTypeRow;
  verification_status?: VerificationStatusRow;
  economic_status?: EconomicStatusRow;
  protocol_compute_micros?: number | null;
  protocol_pricing_version?: string | null;
  protocol_pricing_basis?: string | null;
  epoch_id?: string | null;
  carried_forward?: boolean;
  gateway_id?: string | null;
  economic_source_class?: EconomicSourceClassRow;
  eligible_compute_micros?: number;
  reward_status?: RewardStatusRow;
  reward_reason?: string | null;
  reward_policy_version?: string | null;
  reconciliation_status?: ReconciliationStatusRow;
  reward_hold?: boolean;
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
      providers: {
        Row: ProviderRow;
        Insert: Partial<ProviderRow> & { slug: string; name: string; category: string; status: string; integration_version: string };
        Update: Partial<ProviderRow>;
        Relationships: [];
      };
      mining_protocol_versions: {
        Row: MiningProtocolVersionRow;
        Insert: MiningProtocolVersionRow;
        Update: Partial<MiningProtocolVersionRow>;
        Relationships: [];
      };
      reward_policy_versions: {
        Row: RewardPolicyVersionRow;
        Insert: RewardPolicyVersionRow;
        Update: Partial<RewardPolicyVersionRow>;
        Relationships: [];
      };
      provider_definitions: {
        Row: ProviderDefinitionRow;
        Insert: Partial<ProviderDefinitionRow> & { slug: string; display_name: string; protocol: ProviderProtocolRow };
        Update: Partial<ProviderDefinitionRow>;
        Relationships: [];
      };
      provider_secrets: {
        Row: ProviderSecretRow;
        Insert: Partial<ProviderSecretRow> & { user_id: string; ciphertext: string };
        Update: Partial<ProviderSecretRow>;
        Relationships: [];
      };
      miner_devices: {
        Row: MinerDeviceRow;
        Insert: Partial<MinerDeviceRow> & { user_id: string; name: string; platform: string; app_version: string };
        Update: Partial<MinerDeviceRow>;
        Relationships: [];
      };
      miner_tool_mappings: {
        Row: MinerToolMappingRow;
        Insert: Partial<MinerToolMappingRow> & {
          device_id: string;
          user_id: string;
          tool_id: string;
          metering_method: MeteringMethodRow;
          verification_capability: VerificationLevelRow;
        };
        Update: Partial<MinerToolMappingRow>;
        Relationships: [];
      };
      local_usage_observations: {
        Row: LocalUsageObservationRow;
        Insert: Partial<LocalUsageObservationRow> & {
          user_id: string;
          device_id: string;
          schema_version: string;
          adapter: string;
          tool_id: string;
          source_type: string;
          provider: string;
          occurred_at: string;
          local_session_id: string;
          local_event_id: string;
        };
        Update: Partial<LocalUsageObservationRow>;
        Relationships: [];
      };
      wallet_connections: {
        Row: WalletConnectionRow;
        Insert: Partial<WalletConnectionRow> & { user_id: string; chain_namespace: string; chain_id: string; address: string };
        Update: Partial<WalletConnectionRow>;
        Relationships: [];
      };
      miner_pairing_requests: {
        Row: MinerPairingRequestRow;
        Insert: Partial<MinerPairingRequestRow> & { user_code: string; poll_token_hash: string; device_name: string; platform: string; app_version: string };
        Update: Partial<MinerPairingRequestRow>;
        Relationships: [];
      };
      miner_protocol_versions: {
        Row: MinerProtocolVersionRow;
        Insert: MinerProtocolVersionRow;
        Update: Partial<MinerProtocolVersionRow>;
        Relationships: [];
      };
      provider_oauth_requests: {
        Row: ProviderOAuthRequestRow;
        Insert: Partial<ProviderOAuthRequestRow> & { state: string; user_id: string; provider_slug: string; code_verifier: string };
        Update: Partial<ProviderOAuthRequestRow>;
        Relationships: [];
      };
      provider_models: {
        Row: ProviderModelRow;
        Insert: Partial<ProviderModelRow> & { definition_id: string; upstream_model_id: string };
        Update: Partial<ProviderModelRow>;
        Relationships: [];
      };
      provider_routes: {
        Row: ProviderRouteRow;
        Insert: Partial<ProviderRouteRow> & { provider_slug: string; gateway: string; status: RouteStatusRow; auth_requirement: string; cost_availability: "authoritative" | "unavailable" };
        Update: Partial<ProviderRouteRow>;
        Relationships: [];
      };
      point_balance_snapshots: {
        Row: PointBalanceSnapshotRow;
        Insert: PointBalanceSnapshotRow;
        Update: Partial<PointBalanceSnapshotRow>;
        Relationships: [];
      };
    };
    // `{ [_ in never]: never }` (not Record<string, never>) — the client
    // intersects Tables & Views, and an index signature would poison every row
    // type with `never`.
    Views: {
      epoch_network_totals: {
        Row: EpochNetworkTotalsRow;
        Relationships: [];
      };
    };
    Functions: {
      usage_vault_available: { Args: Record<string, never>; Returns: boolean };
      usage_vault_create_secret: {
        Args: { p_user_id: string; p_secret: string; p_label: string };
        Returns: string;
      };
      usage_vault_read_secret: {
        Args: { p_user_id: string; p_secret_id: string };
        Returns: string | null;
      };
      usage_vault_update_secret: {
        Args: { p_user_id: string; p_secret_id: string; p_secret: string };
        Returns: undefined;
      };
      usage_vault_delete_secret: {
        Args: { p_user_id: string; p_secret_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      verification_type: VerificationTypeRow;
      verification_status: VerificationStatusRow;
      usage_source: UsageSourceRow;
      connection_status: ConnectionStatusRow;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
