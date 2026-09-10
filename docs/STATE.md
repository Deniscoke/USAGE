# STATE

## Current milestone

M16C0 — Claude Code real mining route. **Server deployed 2026-09-11; Miner
0.4.5 tagged, owner must install it.** Root cause proved from source: the
OpenRouter OAuth connection is stored `protocol = openai_compatible`, and
`/api/miner/config` built Claude Code routes only from
`anthropic_compatible`, so the owner's eligible connection was never offered
to Claude Code and the miner fell back to the USAGE-funded gateway (HELD) —
exactly the screenshot. Fix: wire surfaces (`src/lib/providers/surfaces.ts`)
— one OpenRouter connection is offered on both surfaces with the same id,
secret, funding context and verdict; new route
`/api/gateway/provider/<id>/anthropic` forwards the Anthropic Messages format
to `openrouter.ai/api/v1/messages` with the privacy baseline in the body and
the client's OAuth beta dropped; stated `usage.cost` is read on the Anthropic
shape; one `msg_…` generation → one economic unit. Route sessions
(`/api/miner/route-session`, `usgr_` HMAC tokens bound to one connection +
surface + tool, 8 h, parent-credential re-authenticated, `miner:route` only;
`USAGE_ROUTE_SESSION_SECRET` set on Vercel production) replace the
header-only launch. MEASURED: Claude Code 2.1.268 with a saved claude.ai
login ignores `ANTHROPIC_AUTH_TOKEN` and keeps its OAuth header, so Miner
0.4.5 launches Claude Code in a USAGE profile (`%APPDATA%\USAGE\claude-profile`,
plugins/skills/rules/projects shared by junction, no saved login) — the
user's own login is untouched. Miner route selection now prefers
`rewardStatus === "eligible"` (was `miningEligibility === "eligible_route"`).
Python hook errors are from the official `hookify` and `security-guidance`
plugins (bare `python3` = Store stub), not USAGE; not touched. No paid
request, no settlement, no economic change, no migration. Next: owner
installs 0.4.5, presses Start with USAGE, checks `/status`, sends a
screenshot; then ONE approved streaming request. See docs/M15-ECONOMICS.md
→ M16C0.

M16B.1 — production dashboard crash fix. **Deployed 2026-09-10 (commit
2fbef95).** Root cause: production defines only
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, the browser client read
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, so `@supabase/ssr` threw inside the
LiveMining effect and unmounted the whole route (Next's generic "This page
couldn't load"). Fix: the browser client reads both names and returns null
instead of throwing; LiveMining treats a missing client or any transport
failure as DISCONNECTED (5 s fallback), never as a thrown error; a narrow
error boundary around the live card and a `/dashboard` route boundary with
Retry; hydration-safe clock; safe client diagnostics (no secrets, no
network); stale-build recovery reloads exactly once per 5-minute window.
Stability gate on the deployed build: 50/50 direct loads, 50/50 soft
navigations, 20/20 hard reloads, 10/10 back/forward, stale-build
recovery exactly one reload, Realtime blocked → RECONNECTING · 5 s FALLBACK
with the dashboard fully usable, slow network 5/5, `?live=0` 10/10;
0 unhandled pageerrors, 0 generic error screens. Economics unchanged
(7 usage events, ledger 1 row / 100,000, epochs -07 and -10 settled,
beta-v2 draft). Not an economic change; no migration.

M16B — live mining proof. **Deployed 2026-09-10.** Private per-user
Realtime channel (migration 0021_realtime_mining_channel: one RLS policy on
realtime.messages, nothing economic), server-emitted started / progress /
verifying / verified events, `GET /api/mining/summary`, MINING PATH card with
local 1 s tick, 5 s fallback only while Realtime is down, settled epochs show
their persisted reward. One live request observed on the channel:
started → verifying → verified with no refresh; VERIFIED reached the
subscriber 162 ms after the economic commit. **The live unit (`66346da1`,
eligible, 1 micro-USD) was carried forward into epoch-2026-09-11** because
epoch-2026-09-10 is settled: an owner disposition is required before
mining-beta-v2 is scheduled. Ledger unchanged; v2 inactive; 0022 pending.
Pending cutover migration renumbered to `supabase/pending/0022_beta_v2_cutover.sql`.

M16A — beta-v2 cutover preparation. **Prepared, not activated.** Target first
mining-beta-v2 epoch: epoch-2026-09-14 (2026-09-14T00:00:00Z), valid only if
the inert activation package (this code) is deployed and verified by
2026-09-11T23:59:59Z. Epoch-aware resolver (`src/lib/protocol/schedule.ts`,
`protocol_for_epoch()` in pending 0021) replaces global "current version"
assumptions on every economic write path; pricing v3 freshly audited
(5 first-party-priced models; claude-3-haiku, nemotron and ling excluded);
pico ingestion, exact BigInt v2 scoring, atomic `settle_beta_v2_epoch()`
in `supabase/pending/0022_beta_v2_cutover.sql` (NOT applied). Shadow mode:
`npm run usage:m16a:shadow`. See docs/M15-ECONOMICS.md → M16A.

Current production state (2026-09-10): 0018, 0019, 0020 applied;
epoch-2026-09-07 settled v1 development (100,000 points); epoch-2026-09-10
settled calibration (0 points); ledger 1 row / 100,000; mining-dev-v1 the
sole active network protocol; mining-beta-v2 draft; v2 NOT active; no units
in epochs 2026-09-11 to -13.

epoch-2026-09-10 — **CLOSED / SETTLED DEVELOPMENT CALIBRATION, 2026-09-10 19:06 UTC**,
by exactly one call to `close_development_calibration_epoch` (M15E atomic
close: complete). Real M14C compute preserved (event `c75acc2e`, key
`ecu1:cf605dfe…`, 1 micro-USD, proof `b60f5602`, score 1.0000); reward 0;
allocation row with 0 points; ledger delta 0 (still 1 row / 100,000);
claimable false; UTC boundaries 2026-09-10T00:00Z to 2026-09-11T00:00Z;
`audit_epoch` explains it from persisted data. v2 is NOT active:
mining-dev-v1 remains the sole active network protocol, mining-beta-v2 draft.

0020 — atomic calibration close function. **Applied to production
2026-09-10 with explicit owner approval (function only).** UTC-literal
epoch boundaries, SECURITY INVOKER, service_role-only EXECUTE (anon and
authenticated proven denied in production). Invoked exactly once on
2026-09-10 19:06 UTC to close epoch-2026-09-10 (see the current milestone).
Backup: `C:/Users/Admin/USAGE-backups/pre-0020-20260910T190050Z`.

0019 — v2 economics schema. **Applied to production 2026-09-10 with explicit
owner approval (schema only).** Additive: pico columns, protocol binding and
`claimable` on epochs, emission parameters and `role` on protocol versions,
`mining-dev-calibration-v1` (active, calibration, zero emission) and
`mining-beta-v2` (draft) rows, extended immutability, `audit_epoch()`,
`check_v2_epoch_settleable()`. Backup: `C:/Users/Admin/USAGE-backups/pre-0019-20260910T183953Z`.
Nothing activated by 0019 itself; ledger 100,000 unchanged. (Historical
note: at apply time epoch-2026-09-10 was still open; it was closed later the
same day under 0020.)

M14C — First real paid economic compute. **Done 2026-09-10; one unit, no settlement.**

Exactly one real inference (`openai/gpt-5-nano`, prompt "Reply only: OK")
went through the user's OpenRouter OAuth connection `f0f97095`, which
OpenRouter itself reports as `is_free_tier: false` after purchased credit.
Result: `usage_events` row `c75acc2e`, economic key
`ecu1:cf605dfe…`, `dedupe_status = unique`, `economic_verification_status =
verified` under `economic-verification-v1`, source `metered_paid`, reward
`eligible`, `eligible_compute_micros = 1` under `usage-pricing-v2`, proof
`b60f5602` signed by `usage-prod-2026-09-07` and verified against the
published keys. OpenRouter's generation surface agrees (10 native prompt
tokens, 0 completion, cost $0.0000005, `is_byok: false`, served by Azure
under `provider.zdr = true` / `data_collection = "deny"`). Score for
2026-09-10 went 0 → 1.0; the epoch is NOT settled; ledger (100000, 1 row),
allocations (1) and settled balance (0) are unchanged. `npm run
usage:m14c:snapshot` and `usage:m14c:crosscheck` are the read-only evidence
scripts. Fixture regressions (free, promotional, unknown, local-only, replay
x1000, cross-user) all hold.

Found and fixed on the way: `provider_connections` is unique on (user,
provider, label), so reconnecting a revoked provider used to mint and store a
key and then fail on insert (`oauth_connect_failed`). Reconnect now revives
the revoked row; a failed create deletes the secret it just stored.

M14B — Economic foundation hardening. **Deployed; migration 0018 applied to production.**

The M14 key never contained a USAGE user id, but 0018 enforced uniqueness per
user — which would have let one authoritative compute become a unit for two
accounts. Every identity was researched for its real scope (all trusted ones
are global or tenant-scoped; a user-controlled endpoint's ids are now scoped
to the server-issued connection id), dedupe became global, the unique index
became global, and the reward owner is the unit row's `user_id`, immutable at
the database. Settled history — events, epochs, scores, allocations, ledger,
pricing, policies — is frozen by triggers; corrections are append-only records
(see `docs/ARCHITECTURE.md` → *Immutable history*). `npm run
usage:preflight-0018` (read-only) found 0 collisions on production; `npm run
test:chain` runs the entire suite on 0001–0017 **plus** the pending 0018.

M14 — Proof of economic usage. **Live.**

USAGE now has an explicit economic unit: one `usage_events` row per unique,
authoritatively identified AI compute, rewarded at most once. The key is
derived server-side from the provider's request id or the gateway's
generation id, never from anything a device sends; `economic-verification-v1`
decides whether evidence is strong enough to classify a unit, and it calls a
positive cost *paid* only when the provider's account surface says the
account is a paying one. Cross-source duplicates are stored as evidence with
the reward held; conflicting evidence holds the reward; a device signature
verifies nothing economic. See `docs/ARCHITECTURE.md` → *Proof of economic
usage (M14)*.

The paid positive path, blocked at M14 for want of an authoritatively paid
funding source, was exercised for real in M14C (see *Current milestone*).
`npm run usage:funding` (read-only) remains the gate before any further paid
request; nothing is bought by USAGE to unblock a test.

## Production migration 0018 — applied

`supabase/migrations/0018_economic_unit.sql` — **applied 2026-09-10 with explicit
owner approval**, after `migration list` (only 0018 pending), `db push --dry-run`
(only 0018), the read-only preflight (0 collisions), and a logical export of
every touched table outside the repository. Invariants before and after were
identical (usage events 5, settled 2, allocations 1, ledger rows 1 / total
100000, settled epochs 1, settled-period scores 1, pricing v1 frozen / v2
active, 19 live credentials, 2 local observations). `npm run usage:verify-0018`
attempts every forbidden write against production and sees each refused
(30/30); hosted RLS 43/43 and 0017 checks 21/21 unchanged. Ingestion now
writes the economic key, dedupe status and verification columns, so the
global unique index and the settled-row trigger see every new row.

| | |
|---|---|
| Why | Move the economic key, dedupe status and verification verdict from `raw_metadata` into columns so the **database** refuses a second unit for one key — across all users — and refuses any change to settled history. Today ingestion code enforces the first and nothing enforces the second. |
| Tables/columns | `usage_events` + `economic_event_key`, `dedupe_status` (new enum `economic_dedupe_status`), `economic_verification_status`, `economic_verification_policy_version`; `correlation_status` enum + `conflict`. |
| Indexes | `usage_events_one_unit_per_key` UNIQUE `(economic_event_key) where key not null and dedupe_status = 'unique'` — **global**; `usage_events_economic_key_idx` for lookups. |
| Triggers | `usage_events_settled_immutable` (settled economics/identity/owner frozen, DELETE refused, `user_id` frozen on every row); `reward_epochs_settled_immutable`; `score_records_settled_immutable`; append-only on `usage_point_ledger`, `reward_allocations`; `protocol_model_prices_frozen`; `protocol_pricing_versions_frozen` (status only); `reward_policy_versions_frozen` (status/description only). |
| Rows rewritten | Every `usage_events` row: the four new columns backfilled from `raw_metadata` (today: 5 rows, all stay `unkeyed` — every production event predates the key). No economic column, ledger row, epoch or score is read or written. |
| Economic impact | None on any settled value. Prospectively: a second unit per key, or any edit/delete of settled history, becomes a database error for every role. |
| Locking | One `db push` transaction. ADD COLUMN with constant defaults is a catalog change; the unique index is a plain CREATE INDEX (SHARE lock for the build — 5 rows; CONCURRENTLY cannot run in a transaction and would be ceremony); backfill UPDATE touches every row once under ROW EXCLUSIVE; triggers are catalog changes. |
| Preflight | `npm run usage:preflight-0018` (read-only), 2026-09-10: 5 events, 0 would carry a key, 0 invalid shapes, 0 keys with >1 unit, 0 cross-user, 0 settled rows missing reward policy or pricing version; 2 settled rows predate economic-verification-v1 (left as they are). Snapshot: settled events 2, allocations 1, ledger 100000, settled epochs 1, settled-period score records 1, pricing v1 frozen / v2 active, 18 live credentials. |
| Rollback | Drop the eight triggers and five functions, the two indexes, the four columns and the enum type; `raw_metadata` still holds everything. The enum value `conflict` stays (Postgres cannot drop one) and is harmless once unused. |

After approval: copy it into `supabase/migrations/`, `npx supabase db push --linked`, then deploy.

## Previous milestone

M13 — Universal local metering. **Live in production.**

## Production migration awaiting approval

**Applied 2026-09-09, with explicit approval and the preflight below.** Only
0017 was pending (dry-run confirmed). Economic invariants before and after,
and again after the first real upload: usage events 5, settled allocations 1,
Usage Point ledger total 100000, settled epochs 1 — identical. Live
credentials 17 → 18 (the acceptance device). Post-migration verification
`npm run usage:verify-0017`: 21/21. Hosted RLS/security: 43/43. A JSON
logical export of every rollback-relevant table was taken beforehand, outside
the repository (Docker is absent here, so `supabase db dump` was not an option;
note that for the future).

| | |
|---|---|
| File | `supabase/migrations/0017_local_metering.sql` |
| Tables created | `miner_tool_mappings`, `local_usage_observations`, `wallet_connections` |
| Tables altered | `miner_devices` (+7 nullable/defaulted columns), `usage_events` (+5 defaulted columns), `usage_miner_credentials` (scope check widened; two scopes added to live rows; default widened) |
| Types created | `metering_method`, `mapping_status`, `verification_level`, `correlation_status` |
| Destructive | **No.** No column dropped, renamed or retyped; no row deleted. |
| Backfill | `usage_events.verification_level` and `provenance_sources` set from the existing `verification_type` (routed → `routed_confirmed`/`usage_gateway`, verified → `provider_verified_import`/`provider_import`). Live credentials gain `miner:telemetry` and `miner:mappings`. Nothing economic changes: `eligible_compute_micros`, `reward_status`, the ledger and every epoch are untouched, and the test suite asserts the ledger total before and after correlation. |
| Rollback | Drop the three new tables and four types; drop the added columns from `miner_devices` and `usage_events`; restore the previous scope check and default on `usage_miner_credentials` (0016's list). Nothing pre-existing was modified, so rollback loses only what 0017 created. |
| Exercised | Every PGlite test runs it (`src/lib/db/local-metering.test.ts` targets it directly: RLS, grants, dedupe constraint, scope check, wallet unreachability, ledger immutability). |

After approval: `npx supabase db push --linked`, then `npx vercel --prod --yes`.

## Beta readiness checklist

USAGE Miner now ships as a standalone Windows application: download, install,
sign in through the browser, click to enable mining, use AI. No Node, no npm,
no terminal, no copied token, no base URL, no headers. See `docs/MINER.md` for
the build, the trust story and the signing plan.

The first real end-to-end request through a user's own OpenRouter connection
ran on production and produced a signed, independently verifiable proof that
earns nothing, because it was free compute. The Windows beta is published as a
GitHub prerelease and the download page links the real assets.

M12 closed the two things that made handing this to a stranger uncomfortable.
**No credential is written to any configuration file:** Claude Code is now
started by USAGE with routing in the child process's environment, the persistent
path is removed rather than documented, and upgrading cleans up and rotates the
credential 0.2.x left on disk. **Unknown is no longer zero:** an unpriced model
stores `NULL` with `pricing_status = pending_pricing`, so "we have no price" and
"priced at nothing" stopped sharing a representation.

M13 turned the miner from a routing launcher into the local AI usage meter
for the account. A paired computer detects supported AI apps, the user opts
each one in, and the app's own official OpenTelemetry stream is pointed at a
loopback receiver inside the miner for that session. The receiver flattens
OTLP/JSON, an allowlist keeps compute metadata and nothing else, the device
signs each observation with a DPAPI-held Ed25519 key, and the result is
uploaded to a table that nothing economic reads.

**The verification ladder is now explicit:** `local_observed` →
`device_attested` → `provider_correlated` → `routed_confirmed` →
`provider_verified_import`. A device upload can reach the second rung at most.
The third requires the server to find its own record with the same provider
request id — exact equality, no fuzzy matching — and even then only the
existing record's provenance improves; no reward is created.

The rules it does not break: **the miner is not a trusted usage reporter**,
**connectable is not mining eligible**, **free compute is provable but never
rewarded**, and now **tracked ≠ verified ≠ reward-eligible** — three numbers
the dashboard, the device page and the desktop window all compute with one
function.

What the research settled, against current official sources:

| Tool | Surface | Yields | Ceiling |
|---|---|---|---|
| Claude Code | OTLP logs `api_request` (docs say `claude_code.api_request`; wire says `api_request` — both accepted) | model, 4 token counts, `cost_usd_micros`, **`request_id`** | `provider_correlated` |
| Gemini CLI | OTLP logs `gemini_cli.api_response` | model, 5 token counts; **no request id**; `logPrompts` defaults **true** (forced false) | `device_attested` |
| Codex | OTLP logs `codex.sse_event(response.completed)` | 5 token counts + shared `model` (real wire, 0.153.3); **no request/response id**; `tool_token_count` is a total (not read); `user.email`/`user.account_id` on every event (never read); `tool_result` carries `arguments`/`output` (never parsed) | `device_attested`, experimental |
| Cursor | Enterprise-only, **server-side**, admin-configured | nothing locally | unsupported; future Enterprise connector |

## Beta readiness checklist

Mandatory items must all pass before anyone outside the project is invited.

- [ ] **signed binary** — no certificate yet. The public repository now exists
      (github.com/Deniscoke/USAGE-Miner, Apache-2.0), release builds run on a
      GitHub-hosted runner, and both executables carry a real version resource.
      What remains is a SignPath application, MFA, and a code-signing policy
      page — all owner actions. See `docs/MINER-OSS.md` §5.
- [x] **no plaintext persistent Claude miner credential** — removed in 0.3.0,
      enforced at three surfaces, migration rotates what 0.2.x left behind
- [x] **download checksum matches** — generated by the build, verified against
      the bytes served from the release
- [x] **pairing works** — driven end to end against the installed app
- [x] **revoke works** — a revoked device stops authenticating; scopes are
      checked on every request
- [x] **config rollback works** — byte-for-byte, verified through install,
      upgrade and uninstall
- [x] **one-click OpenRouter works** — connected via OAuth, carried a real
      routed proof
- [x] **free inference earns zero** — `ineligible` / `free_inference`, and
      terminal classes are decided before pricing
- [x] **privacy claims verified** — no provider secret in the shipped bundle, no
      credential in logs or shortcuts, loopback guards hold; local telemetry
      allowlist proven against a real Claude Code run (prompt, email, account
      and organisation ids on the wire, none in the upload)
- [x] **local metering live** — 0017 applied, platform deployed, one real
      Claude Code request metered through the installed 0.4.0 miner into the
      production account: `device_attested`, model + tokens + request id
      present, prompt/email/account ids absent, tracked 6 / verified 0 /
      eligible 0, ledger unchanged

Earlier milestones, still true: M9 separated proof of usage from reward
eligibility (a CONFIRMED proof can exist without earning); M10 replaced manual
miner configuration with browser device pairing and DPAPI credential storage.

## Verification status

| Item | Status |
| --- | --- |
| Hosted Vercel gateway | **YES** — migrations 0001-0010 applied |
| GoTrue / RLS runtime | **YES** — 31/31 hosted checks |
| Production receipt signing | **YES** — Ed25519, `usage.receipt.v4` |
| Built-in compute gateways | **2** — `vercel-ai-gateway` (live), `openrouter` (tested) |
| Custom provider connections | **YES** — universal route, deployed |
| Routable protocols | **2** — OpenAI compatible, Anthropic compatible |
| Verified importers | **1** — OpenAI Organization Usage API (tested) |
| Credential encryption | **YES** — AES-256-GCM, key configured in production |
| SSRF protection | **YES** — 21 tests, DNS-resolved, redirect-rechecked |
| Capability discovery | **YES** — probed, never inferred from a name |
| Unknown model behaviour | confirmed proof, `pending_pricing`, earns nothing |
| Network | development epoch only; **Usage Points — Beta** |
| Live provider-connection proof | **YES** — OpenRouter, routed + confirmed, signature verified |
| Published Windows beta | **YES** — `v0.3.0-beta.1`, GitHub prerelease |
| Credential in a tool config file | **NO** — Claude Code is launched, Codex names it |
| Device credential scopes | 4, explicit; no account/secret/proof/reward ability exists |
| Unknown protocol compute | **NULL**, never 0 (`pricing_status`) |
| Miner licence | Apache-2.0, public at github.com/Deniscoke/USAGE-Miner |
| Miner build origin | GitHub-hosted Windows runner, CI green on the split repo |
| Cross-machine reproducibility | **YES** — local and CI produce the same standalone hash |
| Binary identity | `USAGE Miner 0.3.1` (was `Node.js / node.exe`) |
| Miner distribution | standalone Windows exe + per-user installer, 0.2.0 |
| Miner runtime dependency | **none** — Node is embedded in the artifact |
| Miner build reproducibility | **YES** for the exe; installer wrapper is not |
| Executable signing | **NO** — unsigned, and the download page says so |
| Release manifest | `/api/miner/release`, SHA-256 generated by the build |

## How a provider gets connected

```
/providers/add  →  name + protocol + base URL + API key
                →  SSRF guard validates the destination
                →  models probe authenticates and discovers models
                     (no inference request: testing cannot cost provider credit)
                →  credential encrypted, connection stored with a discovered
                   capability set and an honest mining outcome
```

Four honest outcomes, all of them valid:

```
eligible_route    usage + request identity + an approved price → earns
pending_pricing   provable compute, no approved price          → earns nothing
analytics_only    no usage, or no request identity             → earns nothing
unsupported       cannot be observed at all                    → earns nothing
```

## The universal route

```
/api/gateway/provider/[connectionId]/[...path]
```

One route for every provider a user connects. The client names a connection id,
never a URL: the server resolves it scoped to the authenticated user, checks
revocation, re-validates the destination, and decrypts the credential for that
one call. Deployed and verified — unauthenticated is 401 before any lookup, and
a connection belonging to someone else is 404, indistinguishable from one that
does not exist.

Everything after the observation is the pipeline that already existed. The
mining engine never learns which provider a request came from.

## Security posture changes

- `provider_connections` is now **server-written**. 0002 granted clients full
  write access, which was harmless when a connection was a label; it is not
  harmless now that a row carries a base URL and a mining eligibility. Clients
  keep read access and may rename their own connection.
- `provider_secrets` has **no client grant at all** — not even for the user who
  supplied the credential.
- `protocol_model_key` is server-only, so a custom provider cannot price itself
  into rewards.

## Known limitations

- Development epoch only. No public network exists; the UI says Beta.
- No live OpenRouter proof and no live OpenAI import — neither credential
  exists (`OPENROUTER_API_KEY`, `OPENAI_ADMIN_KEY`), and no paid request was
  made. No live custom-provider proof either, for the same reason.
- Credentials are encrypted with a server key rather than Supabase Vault. The
  schema is shaped for Vault; `secret_id` is opaque, so the swap is one module.
  Rotating `USAGE_SECRET_ENCRYPTION_KEY` orphans stored credentials.
- Capability discovery reads what a protocol documents plus what the models
  endpoint proves. Cache, reasoning and cost support are confirmed only when a
  real generation reports them; until then they show as unavailable.
- Model selection is discovered and stored, but there is no per-model
  enable/disable UI yet.
- Reconciliation is coarse: a same-day, same-provider overlap holds the whole
  aggregate. Nothing resolves a hold yet.
- Vercel OIDC deployment identity is not configured, so the signing key alone is
  the trust root.
- The Vercel project is not connected to GitHub; deploys are manual.
- `.usage/hosted-miner.json` holds a plaintext test miner token (gitignored).
- **The miner is unsigned.** SmartScreen warns, correctly. Azure Artifact
  Signing needs an EU-registered organization for a Slovak developer; SignPath
  Foundation is the free fallback once the build pipeline is public.
- Miner artifacts are ~87 MB and are not in git. They are published as release
  assets under `MINER_RELEASE_TAG`; `USAGE_MINER_DOWNLOAD_BASE` repoints the
  links for a fork or a staging build.
- **The binaries are still unsigned.** Everything a project can do without a
  certificate is done; the rest needs a SignPath application to be accepted.
  This is the only mandatory checklist item outstanding.
- `miner/` still exists in this repository as the fallback and is kept in step
  by hand. It is not deleted until the public repository has cut a signed
  release. The download page's manifest still comes from
  `src/lib/miner/release.generated.ts`; the public build now publishes
  `release.json` as a release asset instead, and the site should read that.
- Version 0.3.1 exists only in the public repository and is unreleased: it is
  the build waiting to be signed. `v0.3.0-beta.1` remains the current download
  and keeps its original bytes.
- **Product coherence (M13C, 0.4.2):** the desktop window now shows the
  SERVER's mapping for the CURRENT device (`/api/miner/config` returns
  `device`, `mappings`, a masked account identity and a network label);
  `mappings.json` is keyed by device id and reconciled to the server on every
  config fetch (a 0.4.1 file, keyed by tool alone, is ignored — that was the
  bug: consent from device `fabf7fb0` showed as "mapping ON" on `e0505fa7`).
  The desktop usage figures are per device, like the website's card. Every
  metering session writes `telemetry-status.json` (active / last event / last
  sync outcome as one safe word) so a rejected upload is shown, never logged
  away. The home screen separates account, this PC, mapping, tracking,
  verification and reward, names the real AI route (a fallback is called a
  fallback) and says why USAGE is zero. "Track only" starts Claude Code on
  its own account with telemetry only (`run claude-code --no-route`).
  A random `installation.json` id is minted and sent at pairing; the server
  does not yet store it (a nullable `miner_devices.installation_id` plus a
  reuse rule in `approve` is the designed, un-applied follow-up), so a
  re-pair still creates a new device row; the website labels older live
  pairings "Offline · previous pairing".
- **Windows first run (M14B fix, 0.4.1):** 0.4.0's window stayed on "Loading…"
  forever because a raw newline inside a JS string literal broke the inline
  page script; 0.4.1 fixes it, bounds every startup operation (3 s per tool
  detection, 8 s per USAGE request, page-side timeouts with a Retry screen),
  renders offline and per-tool "Detection unavailable" states, installs a
  5 KB GUI launcher (`USAGE Miner.exe`, no console window) beside the console
  executable the CLI still uses, and gives the installer and launcher a proper
  application manifest (asInvoker, Windows 10/11) with real exit codes
  (0 / 1223 cancelled / 1 failed, after verifying every artifact). The UI is
  still the loopback page in the default browser; a WebView2 shell is the
  recommended next step, not this one.
- Codex remains **experimental**: a real local wire capture (0.153.3) confirmed
  model and token counts but no request identity, so its ceiling stays
  `device_attested`. The packaged-miner detection bug (npm `.cmd` shim needs a
  shell) is fixed in 0.4.0. No live Codex session has run *through* USAGE.
- `economic_event_key`, `dedupe_status` and the verification verdict live in
  `usage_events.raw_metadata` until migration 0018 is approved; the at-most-one
  rule is enforced by ingestion code and asserted by tests, not yet by an index.
- Funding evidence exists only for OpenRouter OAuth connections
  (`is_free_tier`), read at connection time and not refreshed. API-key
  connections are funding-unknown and therefore held. No surface USAGE uses can
  prove a BYOK upstream account is paid, so `byok` is always held.
- Vercel AI Gateway's API cannot distinguish purchased credit from the free
  monthly allowance, so USAGE's own gateway key is always `usage_credit`.
- Migration 0015 marks records that predate the metadata as `unknown_legacy`
  rather than guessing what their zero meant. They are flagged for audit, not
  rewritten.
- macOS and Linux are unsupported: the miner refuses to store a credential
  rather than write one in plaintext.
- Windows only. macOS and Linux have no secure credential store implemented, and
  the miner refuses to write a credential in plaintext rather than degrade.
- The installer's interactive dialogs are verified by hand, not by a test.

## Next recommended milestone

**M15 — mining economics and Sybil resistance**, now that the economic unit is
sound and one real `metered_paid`, `verified`, `eligible` unit exists on
production. `epoch-2026-09-10` has since been settled as a zero-reward
development calibration epoch (M15D/M15E); the first positive-reward v2 settlement is
an explicit owner decision, not background work.

Then, before inviting anyone outside a small beta:

1. A licence, then SignPath Foundation (see `docs/MINER.md` §5). Asking
   strangers to run an unsigned executable does not scale past people who
   already trust you.
2. A per-tool miner credential, so enabling Claude Code stops putting a
   plaintext token in a config file.

## Important local commands

```bash
npm run dev
npm run usage:verify-hosted                # 31 runtime checks against hosted Supabase
npm run usage:pricing:snapshot -- <v>      # capture a new pricing snapshot
npm run usage:pricing:publish -- <v>       # mirror it into the database
npm run usage:providers:publish            # mirror the provider registry and routes
npm run usage:settle-epoch [YYYY-MM-DD]    # finalize, then settle, an epoch
npm run usage:connections                  # what is connected, in production
npm run usage:e2e:openrouter -- --connection <id> --confirm
npm run usage:e2e:openrouter -- --verify <usage-event-id>
npm run usage:verify-receipt -- <file>     # verify a receipt with a public key
npm run miner:token                        # mint a miner credential
npm run miner:claude                       # Claude Code via USAGE Gateway
cd miner && npm run package                # build the Windows exe + installer
npm test && npm run typecheck && npm run lint && npm run build
```
