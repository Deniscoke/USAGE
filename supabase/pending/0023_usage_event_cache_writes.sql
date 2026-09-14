-- 0023 — record the tokens a request wrote to a provider's prompt cache.
--
-- WHY. On 2026-09-11 one Claude Code message produced this row:
--
--     model                anthropic/claude-sonnet-4.6
--     input_tokens         10
--     cached_input_tokens  0
--     output_tokens        61
--     actual_cost_micros   267566
--
-- Seventy-one tokens, twenty-seven cents. The cost is right -- the provider
-- reported it and the provider is authoritative -- but the token columns are
-- missing the roughly seventy thousand tokens the request wrote into the
-- prompt cache, which is what it actually paid for. One row told two
-- irreconcilable stories, and the one a person reads is the wrong one.
--
-- NOTHING WAS LOST. The number is already recorded: that row's raw_metadata
-- carries cache_write_tokens = 71099, and 71099 cache writes plus 10 input and
-- 61 output tokens price out to 267566 micro-USD, matching the provider's own
-- figure to five decimal places. So this migration promotes a field from JSON
-- metadata into a column that a dashboard can read and sum, rather than
-- recovering anything. local_usage_observations has had a cache_write_tokens
-- column since local metering; this gives the authoritative table the same one.
--
-- NOT APPLIED. Written 2026-09-11 and deliberately left pending: the display
-- gap it closes is real but not urgent, and no deployed code writes this
-- column. Apply it, THEN deploy the code that writes it -- the other order
-- makes every gateway insert fail against a column that does not exist.
--
-- NULLABLE ON PURPOSE. A provider that reported no cache fields has not told
-- us they were zero, and a fabricated zero is indistinguishable from a measured
-- one. Unknown stays unknown, as everywhere else in this schema.
--
-- ECONOMICS ARE UNCHANGED BY THIS MIGRATION. Mining is weighed on
-- protocol_compute_micros, which is derived from cost, not from token counts.
-- Existing rows keep NULL: their cache writes were never recorded and cannot
-- be recovered, and back-filling a guess would be worse than an honest gap.
--
-- Additive, nullable, no default, no rewrite, no index. Safe to run while the
-- gateway is serving traffic, and safe for the currently deployed code, which
-- simply never writes it.

alter table public.usage_events
  add column if not exists cache_write_tokens integer;

comment on column public.usage_events.cache_write_tokens is
  'Tokens written to the provider prompt cache, as reported by the provider. NULL means the provider reported no cache fields -- never assume zero. Display and audit only; mining is weighed on protocol_compute_micros.';
