# Subscription Metering

Status: design proposal (revised after critique and final check), 2026-09-16. Nothing here is implemented or agreed.

- **Scope.** Flat-rate AI subscriptions, as opposed to pay-per-token API keys.
  - **Round 1** (§2.1-2.6): Anthropic Claude, OpenAI ChatGPT/Codex, Google (Gemini, Code Assist, Antigravity, Jules), GitHub Copilot, Cursor, Windsurf/Devin, JetBrains AI, Amazon Q/Kiro, Mistral and Perplexity.
  - **Round 2** (§2.7): coding plans sold as API keys (Z.ai, Moonshot Kimi, MiniMax, Alibaba, Volcengine, Tencent, Baidu, StepFun, OpenCode Go, Cerebras, ClinePass). Key-delivered credit plans (Ollama Cloud, Cline credits, Kilo Pass). App-login subscriptions (xAI SuperGrok and Grok Build, Microsoft Copilot, Zed, Warp, Tabnine, Augment, Amp, Factory, Replit, Roo Code).
  - Everything else is listed as not researched (§2.9). This document asserts nothing about those products' terms or capabilities.
- **Evidence base.** Per-provider research, each part re-checked by an independent skeptic. Where the two disagreed, the skeptic's correction is used unless its evidence was weaker. "Unverified", "docs conflict" and "low confidence" labels are kept on purpose.
- **Revision.** This version applies all 30 findings of an honesty and completeness critique of the first draft, and the round 2 research of 2026-09-16.
- **Decisions.** Owner decisions are in §6.2. One item is **not** a decision: the existing Claude subscription passthrough must stop (§5.7, Phase 0a).

---

## 1. Summary

**No round-1 provider allows USAGE to legitimately see subscription traffic on its own servers.**
- **Anthropic** explicitly prohibits third parties from collecting, storing or intermediating Claude.ai credentials, and from routing requests through Free/Pro/Max credentials on behalf of users.
- **Google.** Google's Gemini CLI docs page says that reaching the services behind Gemini CLI, Code Assist included, through third-party software violates the terms. The Google Cloud ToS contract itself has no routing clause. The Antigravity Additional Terms, which are contractual, call using third-party software to access the Service a breach.
- **Perplexity** explicitly bans software that *intercepts* the Services (§5.2(i)). It has no clause about relaying credentials, and there is no data source to relay anyway.
- **Windsurf/Devin** individual terms *likely* prohibit it (§13.4 bans non-provided tools). No clause names routing.
- **OpenAI, GitHub, Cursor, JetBrains, Mistral and Amazon**: the written terms are unclear, and unclear is not permission. Any server-side relay would put the user's subscription credential in USAGE's hands, which runs into those providers' credential-sharing clauses and into USAGE's own rules.
  - **Copilot:** a user-quoted GitHub support notice (unverified ⚠, a lead rather than a primary source) cites "proxy usage" as grounds for restriction.
  - **Cursor:** metering the traffic would mean decoding a private protocol, which ToS 1.5(i) bars.

**So Tier T1 (a server-observed subscription passthrough) is empty for the round-1 providers.** T1 stays a dormant spec until a specific provider authorizes it in writing.

**Round 2 (§2.7): no product is both technically routable through USAGE and permitted by its terms today.** The coding plans sold as API keys were the most likely candidates. Server-side observation of them would not use T1 (forwarding a caller's credential). It would use **T1k** (§3): the user connects the plan key through USAGE's existing encrypted provider-connection path, as with an OpenRouter key today.
- **Technically possible for almost every key-based plan.** Each documents a plain HTTPS base URL with a bearer key, usually Anthropic-compatible for Claude Code.
- **Explicitly prohibited by their terms:**
  - Z.ai GLM Coding Plan: supported tools only; no SaaS or "other systems"; no proxying.
  - Alibaba Model Studio Coding Plan and Token Plan: no application backends; personal use; Token Plan Personal is limited to one device.
  - Volcengine Ark, Tencent Cloud, Baidu Qianfan and StepFun Step Plan.
- **Unclear, which is not permission. Each has a route to written permission:**
  1. **Ollama Cloud**: the terms say nothing on proxies, resale or sharing, and API use from third-party tools is intended. This is the strongest candidate, but its plans are credits spent per token, not a pure flat rate.
  2. **Cline** (ClinePass and Cline credits): transferring API keys needs "prior written consent". Among round-2 plan and subscription products, the Cline API is the only source that returns a per-request USD cost (xAI's pay-per-token API, which is not a plan, also returns `cost_in_usd_ticks`).
  3. **Kilo Gateway**: the terms have a "Your Service" clause for platforms but say nothing about holding each user's key.
  4. **MiniMax Token Plan**: transferring access keys needs "express permission". The key also spends purchased Credits automatically once the plan quota runs out.
  5. **OpenCode Go**: "own internal use" only.
  6. **Moonshot Kimi Code**: leaning against. Use is interactive only, platform integrations go through the Kimi Platform, and reverse-proxy sharing is banned.
  7. **Cerebras Code**: every tier is sold out. Low confidence.
- **Not routable:** app-login subscriptions (SuperGrok, Grok Build, Zed, Warp credits, Augment, Amp credits, Factory, Replit, Microsoft consumer Copilot). Relaying them would mean handling a session credential. xAI and Microsoft prohibit that explicitly; Zed and Tabnine prohibit it in effect.

**So T1k is also empty today.** It becomes a candidate per provider only after written permission and owner decision D13 (Phase 1c).

**USAGE already runs a Claude subscription passthrough, and it must stop.**
- **How it happens.** When the miner falls back to its header-only plan, Claude Code sends the user's claude.ai OAuth token in `Authorization`, and USAGE's gateway forwards it to Vercel AI Gateway. That is the credential intermediation Anthropic's terms prohibit.
- **Why nothing needs to wait.** Stopping it is a code change and a deploy, with no migration. Phase 0a does it, and also audits existing log sinks for tokens that were already captured.
- **The only open owner question** is what replaces the fallback (D1).

**Provider-attested usage (T2) exists, but mostly for organizations.**
- **Individual-plan paths found** (each has limits):
  1. **GitHub Copilot per-user AI-credit billing API.** One aggregate per call, so one call per day. All surfaces are combined, and code completions and next edit suggestions are excluded. Read with a GitHub App user token.
  2. **Google Developer Program Premium.** A single-user Code Assist Standard licence whose project metrics map to one person. It can be read through an IAM role, with no secret held. Whether Gemini CLI traffic is recorded there is unconfirmed (⚡ docs conflict).
  3. **Cursor Cloud Agents API / SDK usage.** Provider-attested only for agent runs created through the API or SDK. It needs a full-power user API key (no read-only scope), so it is deferred.
  - **Not T2:** OpenAI's local app-server `account/usage/read` holds provider-originated numbers, but they are relayed through the user's device, so they are T3.
- **Org paths:**
  - Claude Enterprise Analytics API
  - ChatGPT Enterprise/Edu Admin keys
  - Google Cloud Monitoring for Code Assist, and developer tools metrics for Antigravity on a Gemini Enterprise licence
  - Copilot Business/Enterprise metrics
  - Cursor Teams Admin API and Cursor Enterprise Organization API
  - Windsurf/Devin Enterprise, JetBrains Console, Mistral Enterprise and Perplexity Enterprise
  - Kiro Enterprise push export, which is only org-attested (T2o)
- **Round 2 additions** (§2.7):
  - **Amp External API**, an individual candidate. A machine-to-machine app with only `threads.meta:view` reads per-thread USD cost and tokens. Plan availability and Amp's position on third-party use are unconfirmed.
  - **Tabnine Enterprise.** Any user can create a PAT scoped to Usage metrics read. The response fields are undocumented.
  - **Org paths:** Warp Enterprise and Augment Enterprise analytics (neither key is read-only), and Microsoft 365 Copilot Graph usage reports (activity counts only, tenant-wide permission, user names concealed by default).
  - **Not built on:** undocumented quota endpoints found in providers' own client code (Z.ai monitor, Kimi `/usages`, Ollama `/api/usage`), and MiniMax's documented but aggregate-only `token_plan/remains`. All of them would need USAGE to hold the plan key.
- **Caveats.** Every one of these has open terms questions, and several need broad privileges (see the blast-radius table in §5.2).

**Everything else is at best device-reported (T3):** local OpenTelemetry, hooks or CLI output. A PC can fabricate it, so under rule 6 it carries zero economic weight.
- **Round 2 adds:**
  - Claude Code launched with the user's own plan-provider configuration (Z.ai, Kimi, MiniMax, Alibaba, Volcengine, Tencent, Baidu, StepFun, Ollama, OpenCode Go). The key stays local and the miner is not in the request path.
  - Qwen Code OTel.
  - Grok Build external OTel.
- **Deferred:** Kilo CLI and Tabnine CLI OTel.

**Some products are not measurable (T0):**
- claude.ai web and Desktop chat
- ChatGPT web and desktop chat
- the consumer Gemini app
- Perplexity consumer plans
- Mistral le Chat web/apps
- Code Assist on GitHub
- Round 2: SuperGrok consumer apps and partner-app OAuth, Microsoft 365 consumer Copilot, ZCode, the Kimi Code OAuth clients, Zed-hosted models, Warp plan credits, Augment Standard/Business, Factory plan tokens, Replit Agent

Antigravity desktop on consumer plans is **T0 pending legal review**. Its hooks technically provide per-model invocation counts.

**Discontinued or unavailable** (§2.7.4): Qwen OAuth, Ollama Turbo, Microsoft Copilot Pro, Warp Pro/Turbo/Lightspeed, Tabnine individual plans, Roo Code, the Baidu Coding Plan (being phased out) and Cerebras Code (sold out).

**Recommended path:**
1. **Phase 0a (now; the stop itself needs no decision).**
   - Stop forwarding any caller `Authorization` upstream.
   - Audit log sinks for captured tokens.
   - Sanitize upstream error bodies.
   - Fix funding labels and the miner's messages.
2. **Phase 0b/0c.** Metadata-only T3 "subscription observe" launches, display only. Each tool is released only when its legal gate is clear.
   - Claude Code is pending review, so it is prototype only. That includes Claude Code pointed at a third-party plan.
   - Round 2 adds Qwen Code and Grok Build adapters.
3. **Phase 0r (research done 2026-09-16).** Written-permission requests to the §2.7 T1k candidates (D10) and the §8.2 checks come next.
4. **Phase 1.** One T2 pilot (Copilot individual), visible only to that user. Amp External API is a Phase 1b option.
5. **Phase 1c (conditional).** A display-only T1k pilot for the first provider that grants written permission (Ollama is the first request). Traffic is ROUTED with cost `pending_cost`.
6. **Later.** Economic weight comes only after owner decisions, written confirmation from each provider, and person-level Sybil and automation controls.

---

## 2. Provider matrix

Legend
- **Tier**:
  - **T1**: server-observed passthrough (the caller's credential is forwarded)
  - **T1k**: server-observed via a plan key connected through USAGE's encrypted provider-connection path (round 2, §3)
  - **T2**: provider-attested pull
  - **T2o**: org-attested (the data reaches USAGE through infrastructure or a secret the customer controls)
  - **T3**: device-reported
  - **T3s**: self-declared plan only, no numbers
  - **T0**: not measurable
- **ToS values**:
  - *prohibited*: an explicit clause
  - *likely prohibited*: a strong inference with no explicit clause
  - *unclear*: no clause either way, which is **not** permission
  - *n/a*: routing is technically impossible
- **Flags**: ⚠ unverified, ⚡ docs conflict, ◐ low or medium confidence. **[automation]** marks products whose usage is automated by definition. Their usage never carries economic weight (§5.6).
- **Privileges**: where a T2 path needs a broad role or scope, the row names it, and §5.2 lists its blast radius.
- **Device cost fields**: device cost or billing fields (Claude `cost_usd`, Codex `codex.turn_cost`, Copilot `github.copilot.cost` / `nano_aiu`) appear below only to describe the tools. The miner drops them (§4.1).

### 2.1 Anthropic

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| Claude Pro/Max, Claude Code CLI | claude.ai OAuth (`/login`), stored in `%USERPROFILE%\.claude\.credentials.json`; `setup-token` gives a 1-year token | Technically yes. `ANTHROPIC_BASE_URL` alone keeps the login and sends the OAuth bearer plus `anthropic-beta` OAuth value to that host. Documented only for gateways "your organization already runs". Settings-file `env` can set it even when the child env doesn't | None for individuals. UI only: Settings > Usage, `/usage`, status-line `rate_limits.five_hour/seven_day` | OTel `claude_code.api_request`: model, 4 token counts, `request_id`, `cost_usd` (list-price estimate; dropped by USAGE). No plan attribute. `claude auth status` JSON shows `subscriptionType` (field names undocumented ⚠) | **prohibited**: third parties "may not collect, store, or intermediate Claude.ai credentials", nor route via Free/Pro/Max credentials | device_reported | **T3** (legal gate pending, §8.1.2) |
| Claude Pro/Max, Claude Code VS Code extension | Same saved login as the CLI | Same mechanics as the CLI. The IDE spawns `claude` itself, so a miner child env never reaches it | UI only | Same OTel. Delivery only through persistent settings `env` (consent required). JetBrains integration not researched ⚠ | **prohibited** (same clause) | device_reported | **T3** (persistent settings, legal gate pending) ◐ |
| Claude Pro/Max, Desktop Code tab | Desktop account sign-in | No. Desktop takes gateway routing only from 3P inference config, which replaces the subscription | UI only | Same OTel, `service.name=claude-code-desktop`. Env from the local environment editor or `~/.claude/settings.json` `env` (documented; live probe advised ⚠). Desktop pins its own OTLP endpoint if it supplies one | **prohibited** (same clause) | device_reported | **T3** (persistent settings write, consent required; legal gate pending) ◐ |
| Claude Pro/Max, Desktop Chat / Cowork | Desktop sign-in | No | UI only ("usage ring" not found in docs ⚠) | None user-configurable (Cowork OTel is Team/Enterprise admin-only and includes prompts by default; never read) | **prohibited** | none | **T0** |
| Claude Pro/Max, claude.ai web and Claude Code on the web | Browser session; cloud sessions always use subscription | No. Interception would expose the session token | UI only | None reachable (the collector would have to be reachable from Anthropic's cloud, not loopback) | **prohibited** (Consumer Terms automated-access clause plus credential ban) | none | **T0** (optional T3s plan declaration) |
| Claude Team (Standard/Premium), CLI / Desktop / web | claude.ai OAuth with team seat; SSO options | Same as Pro/Max for CLI; documented only for customer-run gateways | Owner-only UI and spend CSV (usage-credit spend only; seat allowance not metered in dollars). No API ("not available on Teams plan") | Same CLI OTel. Managed settings can lock the OTLP destination, and the miner then receives nothing | **prohibited** (credential-intermediation ban; Commercial Terms resale restriction) | device_reported | **T3** (owner-uploaded CSV at most display-only "org-reported") ◐ |
| Claude Enterprise, all surfaces via Enterprise Analytics API | Primary Owner creates a `read:analytics` key (`x-api-key`) | Same as Team; not for USAGE | `/v1/organizations/analytics/user_usage_report`, `/user_cost_report` (buckets 1d/1h/1m, per seat user, fractional-cent decimal strings), `/users` activity. Usage-based plans: tokens and cost. Seat-based: usage credits only. Revisable for 30 days. Data from 2026-01-01. Per-user endpoints accept a `user_ids[]` filter (up to 100) and return email and name, including removed users | Same CLI OTel | Routing **prohibited**. Sharing the analytics key or data with a third party: **unclear** (docs and Commercial Terms silent; confidentiality clause applies) | provider_attested (aggregate, per seat user; attribution done by USAGE) | **T2** org connector, written Anthropic confirmation first. Key reads every employee's usage (§5.2) ◐ |

### 2.2 OpenAI

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| ChatGPT Free/Go/Plus/Pro, Codex CLI | "Sign in with ChatGPT" OAuth, stored in `~/.codex/auth.json` or keyring; bearer plus `ChatGPT-Account-ID` to `chatgpt.com/backend-api/codex` | Yes in code. `openai_base_url` (user-level config or `-c`) or custom provider with `requires_openai_auth=true`; the host then receives the ChatGPT bearer. Docs show proxy use. No doc says the ChatGPT backend accepts relayed requests ⚠ | None for third parties. Local app-server `account/usage/read` (daily token buckets; provider-originated but device-relayed) and `account/rateLimits/read` | OTel `[otel]` via `-c`: `codex.sse_event` (response.completed) token counts. `tool_token_count` is actually **total** tokens, so don't sum it. Every event carries `user.email`/`user.account_id`. `codex.turn_cost` (backend estimate) expected absent for personal plans; dropped by USAGE if present. `codex exec --json` `turn.completed` usage also exists but only for non-interactive runs, which the miner never starts | **unclear** for a hosted relay. The ToU bans sharing credentials or "making your account available to anyone else". OpenAI endorses using a ChatGPT plan in local third-party harnesses; its documents say nothing about hosted relays | device_reported | **T3** |
| ChatGPT plans, Codex IDE extension / ChatGPT desktop Codex mode | Shared cached login and `%USERPROFILE%\.codex` | Same keys; the miner cannot pass `-c`, so it would need a persistent config edit | Same as CLI | Shared `[otel]` config applies to the IDE. Desktop app honouring `[otel]` not documented ⚠ | **unclear** | device_reported | **T3** (persistent config, consent required) ◐ |
| ChatGPT plans, Codex cloud tasks (chatgpt.com/codex) **[automation]** | Runs on OpenAI infrastructure under the ChatGPT login | No | None for third parties. Whether local `account/usage/read` buckets include cloud tasks is an open question ⚠. Enterprise/Edu: Codex analytics rows per client (e.g. `CODEX_WEB`), see the Enterprise row | None (runs in OpenAI's cloud) | n/a | none per task; device-relayed daily totals at most | **T0** per task; account totals **T3** at most ◐ |
| ChatGPT Business, Codex | Workspace OAuth; admin may force login method or workspace | Same mechanism; managed requirements may pin settings | No Business analytics API documented (Admin keys listed for Enterprise/Edu/Healthcare; "availability varies") | Same OTel; managed config may override | **unclear** (Services Agreement §3.1 no credential sharing, §3.3 restrictions) | device_reported | **T3** ◐ |
| ChatGPT Enterprise/Edu/Healthcare, Codex + chat via Admin API | Workspace SSO; workspace Admin keys at `api.chatgpt.com/v1` | Not relevant | Codex Analytics `/analytics/codex/workspaces/{id}/usage` and `/turn-insights`; Compliance Logs `event_type=COSTS` with costs-only scope. COSTS schema, scope string, hourly grain and 3-5 h latency **could not be re-verified** ⚠. ⚡ `analytics-api.md` says a Platform org key is needed; the reference says Admin key | Same OTel for local clients | Routing **unclear**. Handing an Admin key to USAGE: the Admin keys Help Center article says the keys exist "to connect tools and services", but Services Agreement §3.3(g) bars transferring API keys with third parties, and §3.1 bars credential sharing. Keys default to All permissions and Never expiry | provider_attested at workspace level; attribution done by USAGE; figures described as estimates or reported charges | **T2** org connector, after legal review of §3.3(g), a live schema check, and the owner narrowing the key to Costs read / Codex analytics read with an expiry ◐ |
| ChatGPT web / desktop chat (Plus/Pro/Business) | Browser session or app sign-in | No | None (desktop Usage & billing excludes regular Chat) | None | No routing clause, but every measurement method (scraping, programmatic extraction, session reuse) is explicitly prohibited | none | **T0** |

### 2.3 Google

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| Gemini Code Assist Standard/Enterprise (org licence), Gemini CLI | Google OAuth to `cloudcode-pa.googleapis.com` | No legitimate option. `CODE_ASSIST_ENDPOINT` (dev/test) sends the OAuth bearer to any host. `GOOGLE_GEMINI_BASE_URL` applies only to API-key/gateway auth | Cloud Monitoring `cloudaicompanion` metrics, project-level only. ⚡ The monitoring page says recording is limited to IDE use, yet also counts "Gemini CLI"; the Generate-metrics page points CLI users to OTel. Token metrics absent from the GA reference ⚠. `usage/response_count` can include non-coding Gemini for Cloud products. License holders listable via `enumerateLicensedUsers`. Needs `roles/monitoring.viewer`, which covers every metric in the project | OTel `gemini_cli.api_response` token counts (no cost). `logPrompts` defaults to **true**. `gen_ai.client.inference.operation.details` **always** carries `gen_ai.system_instructions` | **prohibited** for relays and credential reuse: explicit on Google's Gemini CLI docs page; the Cloud ToS contract has no routing clause (§3.3 resale/quota) | device_reported per user; aggregate per project is provider-sourced but CLI coverage unconfirmed | **T3** now; T2 aggregate after live metric check ◐ |
| Google Developer Program Premium (single-user Code Assist Standard), Gemini CLI / IDE | Google OAuth; a Cloud project with the Gemini for Google Cloud API enabled, no billing required | Same as the org row | Same project metrics, but one licence holder, so they map to one person more cleanly than an org licence. IAM role grant, no secret held. CLI coverage unconfirmed (⚡ as above) | Same OTel | Same as the org row | provider_attested aggregate for one user (IDE; CLI unconfirmed) | **T2** individual candidate (Phase 1b), after `metricDescriptors.list` check ◐ |
| Code Assist Standard/Enterprise, IDE extensions (VS Code, JetBrains, agent mode) | Google OAuth in extension | No. Only an IDE HTTP proxy (TLS-inspection proxies documented for customer's own network) | Same project metrics. Metadata-only Cloud Logging possible (`log_metadata` separate from `log_prompts_and_responses`; `labels.user_id`=email). Reading logs needs `roles/logging.viewer`, which would also expose request/response prompt logs if those are on | None documented for completion/chat. Agent-mode OTel unverified ⚠ | **likely prohibited** (clause framed around Gemini CLI; Cloud ToS has no routing clause) | provider_attested aggregate (IDE); per-user via metadata logs | **T2** org connector (IAM role, no secret); logs only with proof that prompt logging is off or a `/metadata`-only log view ◐ |
| Code Assist Standard/Enterprise, Gemini CLI inside Zed / JetBrains / Xcode via ACP | Google OAuth; the editor launches the CLI | Same as CLI | Same project metrics | Same CLI OTel applies. The editor, not the miner, starts the process, so only persistent settings delivery would work ⚠ | Same as CLI | device_reported | **T3** deferred (persistent settings; content hazards as CLI) ◐ |
| Consumer individuals / Google AI Pro / Ultra, Gemini CLI or Code Assist IDE | Discontinued 2026-06-18 | n/a | None | Nothing served | **prohibited** | none | **T0** (remove any consumer launch option) |
| Gemini Code Assist on GitHub **[automation]** | Consumer use ended 2026-06-18; enterprise version under Google Cloud terms | n/a | Enterprise version does not support Cloud Logging | None | Cloud ToS | none found | **T0** (not a miner target) |
| Google AI Pro/Ultra, Jules (async coding agent) **[automation]** | Google sign-in; v1alpha REST API with an API key from the web app | No | Jules API exposes sessions and activities; no token or quota fields documented | None | not researched ⚠ | none (activity only) | **T0** (not researched further; any activity read would need a user-issued key) ◐ |
| Google AI Pro/Ultra, Antigravity CLI (`agy`) | Google Sign-In; tokens in OS keyring | No (`GOOGLE_GEMINI_BASE_URL` is API-key mode only; no bring-your-own-endpoint) | None. `agy -p "/usage" --output-format json` gives quota fractions | No OTel. statusLine JSON (tokens, quota, plan_tier, plus email/paths to drop); headless `usage` is **cumulative per session**; Pre/PostInvocation hooks carry modelName | **prohibited**: "Using third party software, tools, or services to access the Service" is a breach; plus "in connection with products not provided by us" | device_reported | **T3 only after legal review**; otherwise T0 ◐ |
| Google AI Pro/Ultra, Antigravity desktop / IDE | Google Sign-In | No | None public | Pre/PostInvocation hooks with modelName (per-model invocation counts, no tokens) | **prohibited** (same Additional Terms) | device_reported counts at most | **T0 pending legal review**; hook counts technically possible ◐ |
| Gemini Enterprise license, Antigravity desktop/CLI | Business account / Google Cloud / WIF | No | "Developer tools metrics" in Cloud Monitoring: tokens, API calls, active users, errors. Project-level; exact metric types and labels unverified ⚠. Documented dashboard role is `roles/discoveryengine.agentspaceAdmin` (an admin role); a non-admin Monitoring read path is unverified ⚠ | Hooks | Governed by Google Cloud ToS (no routing clause; §3.3) | provider_attested aggregate | **T2** org connector after `metricDescriptors.list` check and a verified non-admin read path ◐ |
| Gemini app (consumer AI Plus/Pro/Ultra) | Browser session | No | UI only (Settings > Usage Limits); Takeout contains prompts, so off-limits | None | **unclear** (Google ToS "Don't abuse" section, no routing clause) | none | **T0** (T3s at most) |
| Workspace Gemini app / Gemini in Workspace | Workspace session; admin OAuth `admin.reports.audit.readonly` | No | Reports API `gemini_in_workspace_apps` `feature_utilization` events: counts, no tokens/model/cost; 180-day history. The scope reads **every** Workspace audit log (Drive, login and more), and is a restricted scope that likely needs Google OAuth app verification ⚠ | None | **unclear** (Cloud ToS; routing irrelevant) | provider_attested activity counts | **T2** activity only, unpriceable; gated on OAuth verification and blast-radius acceptance ◐ |

### 2.4 GitHub Copilot

Code completions and next edit suggestions are not billed in AI Credits. No billing API meters them.

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| Copilot Pro/Pro+/Max, Copilot CLI | GitHub OAuth (keychain / Credential Manager), or `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`; fine-grained PAT with Copilot Requests | No. BYOK vars bypass the subscription. `COPILOT_API_URL`+`GITHUB_COPILOT_API_TOKEN` would hand USAGE a live Copilot token. HTTP proxies see TLS only | `GET /users/{u}/settings/billing/ai_credit/usage` (Plan: read; GitHub App user token). One aggregate per filter call, so one call per day; 24-month window. Use **gross** quantity/amount: included usage sits in `discountAmount`, so `netAmount` ≈ 0 for most subscribers. Display strings, not slugs. ⚡ Fine-grained PAT support conflicts across docs. Excludes completions/NES | OTel (traces): root `invoke_agent` span tokens; `github.copilot.cost` and `github.copilot.nano_aiu` (billing units, dropped by USAGE); content off by default | Written terms **unclear**. A user-quoted GitHub support notice (unverified ⚠) cites "proxy usage" as grounds for restriction. AUP §4 bars reward-incentivized activity | provider_attested (per-account daily aggregate, all surfaces) | **T2** (first individual-plan pilot) + T3 |
| Copilot Pro/Pro+/Max, VS Code | GitHub auth provider OAuth | No (debug `overrideCapiUrl` is internal) | Same billing API (not separable by surface) | `github.copilot.chat.otel.*` settings or env; default attributes leak repo URL, branch, commit SHA, org; no cost attribute. The debug panel captures full content locally when export is off | **unclear**; see the CLI row on the support notice ⚠ | provider_attested (aggregate) | **T2** (via account sync) + T3 opt-in |
| Copilot Pro/Pro+/Max, JetBrains | GitHub OAuth | No | Same billing API | OTel export setting exists; schema unpublished ⚠ | **unclear** | provider_attested (aggregate) | **T2** via account sync; no T3 until schema published |
| Copilot, GitHub Copilot app (desktop agent workspace) | GitHub OAuth; included in all plans | No (local BYOK exists but is not subscription usage, §2.8) | Individual: same aggregate billing API. Business/Enterprise: org metrics `totals_by_copilot_app` token sums | Not researched ⚠ | **unclear** | provider_attested (aggregate) | **T2** via account sync / org opt-in ◐ |
| Copilot, Visual Studio / Eclipse / Xcode | GitHub OAuth | No (Xcode local BYOK is not subscription usage) | Aggregate billing API only (Eclipse also has a status-bar usage view) | Not researched ⚠ | **unclear** | provider_attested (aggregate) | **T2** via account sync; no T3 ◐ |
| Copilot Chat on github.com, GitHub Mobile, Windows Terminal, GitHub Desktop | GitHub session / app sign-in | No | Aggregate billing API only | None | **unclear** | provider_attested (aggregate) | **T2** via account sync; per surface T0 |
| Copilot Spaces, Spark (`spark_ai_credits`), Code Quality (`code_quality_ai_credit`), Copilot code review, sandbox SKUs (`sandbox_linux`, `sandbox_memory`, `sandbox_snapshot`) | GitHub account / org | No | Credit-consuming SKUs in billing data; whether AI-credit `usageItems` separate them is unverified ⚠ | None | **unclear** | provider_attested (aggregate) | **T2** aggregate; sandbox SKUs are agent infrastructure and never earn ◐ |
| Third-party coding agents on GitHub (Anthropic Claude, OpenAI Codex), public preview **[automation]** | Enabled by policy per account or org; excluded from Copilot Student | No | Consume AI Credits (aggregate billing data) | None | **unclear** | provider_attested (aggregate) | **T2** display only; never earns |
| Copilot Free / Student / complimentary Pro (teachers, OSS maintainers) | GitHub OAuth | No | User billing endpoints "apply only if the user bought their own plan". Coverage untested ⚠ | Same client OTel | **unclear**; ToS B.3 one free account per person | device_reported | **T3**; test T2 before claiming |
| Copilot Business/Enterprise, CLI / IDEs | Member OAuth; org-pooled credits | No | Admin-only: org `ai_credit/usage?user=` (Administration: read) and usage-metrics `users-1-day` (`ai_credits_used`, not invoicing, not split by feature/model/surface; CLI token sums) | Same OTel; enterprise managed settings may override | **unclear** (General Terms §1.12 no working around limits, no hosting for others) | provider_attested (admin-granted) | **T3** default; **T2** org opt-in ◐ |
| Copilot cloud agent, individual **[automation]** | Runs on GitHub infrastructure | No | SKU `coding_agent_ai_credit` exists; whether usageItems separate it is unverified ⚠ | None (sandbox token and prompt env must never be relayed) | n/a | provider_attested (aggregate) | **T2** via account sync, display only; never earns |
| Copilot cloud agent, Business/Enterprise **[automation]** | GitHub infrastructure | No | Org metrics flag plus total credits only | None | n/a | provider_attested (admin-granted) | **T2** org opt-in, display only; never earns ◐ |

### 2.5 Cursor

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| Cursor Pro/Pro+/Ultra, editor | Cursor account (WorkOS); all AI traffic to `*.cursor.sh` | No. "Override OpenAI Base URL" is BYOK only, called from Cursor's backend, not Tab/built-in models, and admins can disable it. Certificate pinning on critical services | No API. Dashboard CSV export exists, but a user upload is forgeable and cost was removed 2026-07-31 (restoration disputed ⚠) | No OTel. `hooks.json` metadata (model, ids, durations, `context_tokens`); **no per-request tokens**; content hooks, `transcript_path`, `CURSOR_TRANSCRIPT_PATH` and `CURSOR_USER_EMAIL` must be avoided | Plain routing **unclear**; any *metering* proxy requires decoding, which is explicitly barred (ToS 1.5(i),(viii); AUP metering clause) | device_reported | **T3** (activity counts, no tokens; legal gate pending) ◐ |
| Cursor Pro/Pro+/Ultra, Cursor CLI (`agent`) | `agent login` or user API key | No inference endpoint override; HTTPS_PROXY opaque | No API; `/usage` UI | stream-json per-turn tokens and hook token fields claimed in changelog, **undocumented in references** ⚠; stream contains content | **unclear** | device_reported | **T3** after capturing real schema ◐ |
| Cursor individual, SDK / Cloud Agents API **[automation]** | Full-power user API key (no read-only scope); `Cursor.auth.login()` mints a 90-day key in `~/.cursor/sdk/auth.json`. Cloud agents need on-demand usage turned on | No (`backendUrl` replaces Cursor's backend, which would be a MITM) | `GET /v1/agents/{id}/usage` tokens; SDK `getUsage()` (billed record, `rawCostCents`, `chargedCents`=0 for plan-included, BYOK *or* credit-grant) | SDK usage events | **unclear** (Notion precedent holds user keys, but Notion is a listed integration) | provider_attested **only for API/SDK-created agents** | T3; T2 deferred (key power) |
| Cursor Teams (Standard/Premium) | Member accounts; team API keys `admin:*`, possibly `read:*` | No (BYOK carries Cursor Token Rate) | `POST /teams/filtered-usage-events`: per event tokens, `totalCents`, `chargedCents`, model, kind, `isHeadless`. Includes BYOK events. ⚡ Plan availability conflicts (overview says Enterprise). `read:*` on usage routes untested ⚠. Cents still populated after the 2026-07-31 change? ⚠ | Hooks, CLI | **unclear**; official API read is sanctioned use | provider_attested | **T2** org connector after live key test ◐ |
| Cursor Enterprise | SSO/SCIM; Organization API key with **`usage:*` scope** (read-only, usage routes only) | No | Organization API `/organizations/filtered-usage-events`, `/pooled-usage` (`chargedCents` billing-grade). Server-side OTel export (OTLP/HTTP protobuf; tokens, estimated cost, unsigned, static egress IPs, optional opaque team-scoped `cursor.user.id`; pushes the whole org; new families auto-enabled) | No client OTel | **unclear** for routing; usage export and API documented | provider_attested (pull); OTel export ≈ T2o | **T2** org connector (best Cursor path) ◐ |

### 2.6 Others

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| Windsurf / Devin Desktop self-serve Pro & Max (editor, JetBrains plugin, Devin CLI) | Browser account sign-in; CLI token in `credentials.toml` | No (forward proxy only) | None (Enterprise-only APIs) | Cascade hooks: model_name, ids, no tokens (still firing after Cascade reportedly retired? ⚠). Devin CLI hooks: no model or tokens; `UserPromptSubmit` carries prompt text | **likely prohibited** (Individual §13.4 non-provided tools; §6.2(c)). Which terms govern current users (Exafunction vs Cognition §14) is unclear | device_reported | **T3** counts only, after legal read; else T0 ◐ |
| Windsurf Teams | Account sign-in | No | None: no Teams API; the Devin v3 consumption endpoint returns 403 for Teams and self-serve | Same hooks | **unclear**: Teams terms now redirect to the Cognition Platform ToS (§2.3; AUP credential-sharing and usage-limit clauses) | device_reported | **T3** counts only, after legal read; else T0 ◐ |
| Windsurf / Devin Enterprise | SSO; admin service keys | No | Analytics API (`server.codeium.com`), v2alpha consumption (credits/ACUs by user/model; 10 req/h), Devin v3 daily ACUs. No tokens or USD | Hooks | **unclear** (Cognition Platform ToS §2.3; negotiated contracts unreviewed) | provider_attested (credits/ACUs) | **T2** org connector ◐ |
| JetBrains AI Pro/Ultimate personal (AI Assistant, Junie, Air) | JetBrains Account OAuth | No (BYOK/LiteLLM URL bypasses subscription) | None via API (widget, account page) | No OTel. Junie `/usage` interactive only; JSON output usage schema **not documented** ⚠. Headless `JUNIE_API_KEY` is separate usage-based billing and does **not** measure the subscription | **unclear** (AI ToS §3(d)(iv), §3(d)(i) fee avoidance; AUP §1(h) programmatic extraction of outputs) | device_reported | **T0/T3** deferred pending legal read of AUP §1(h) ◐ |
| JetBrains AI Free (3 credits / 30 days) | JetBrains Account | No | None via API | Same as personal | **unclear** (same terms) | device_reported | **T0/T3** deferred; free tier never earns ◐ |
| JetBrains AI for organizations (Central Console; incl. orgs migrated to JetBrains Central shared pools) | Service account with View AI analytics | No | Console Analytics API v2 (**Preview/EAP, may become paid**): credits per principal, session token usage; server-side vs IDE source of tokens unclear ⚠. Central-migrated orgs have no per-user subscription: usage draws from an org-wide pool, so per-person attribution is USAGE's own mapping | Same | **unclear** | provider_attested (credits) | **T2** org connector, later ◐ |
| Amazon Q Developer Pro, IDE plugins (sunsetting 2027-04-30) | IAM Identity Center / Builder ID | No | Customer-S3 user activity CSV (counts, no tokens/credits), CloudWatch, CloudTrail (IDE inference events undocumented ⚠) | None | **unclear** (AWS Customer Agreement §2.4, which also permits disclosing credentials to agents acting for the customer; §6.4) | org_attested (activity counts) | **Skip** (low priority) |
| Amazon Q Developer in the AWS Management Console (continues after 2027-04-30) | AWS console session | No | CloudTrail documents a console `SendMessage` event (source CONSOLE); signed digests prove events happened; no usage fields | None | **unclear** (same agreement) | org_attested (event counts) | **Skip** (low priority; T2o counts at most) ◐ |
| Kiro Pro/Pro+/Pro Max/Power individual | GitHub/Google/Builder ID OAuth; `KIRO_API_KEY` draws subscription credits | No | None (GitHub issue #7752 is a user request, not an AWS statement) | No OTel; `/usage` text and stream-json schema undocumented ⚠; ACP `_kiro.dev/metadata` session credits undocumented ⚠ | **unclear** | device_reported | **T3** deferred (interactive observation only) ◐ |
| Kiro Enterprise | IAM Identity Center / IdP | No | OTLP daily push (`kiro.daily.credits` etc., per user, gRPC or HTTP/protobuf) authenticated by **one header the customer admin sets**, unsigned; S3 CSV in customer bucket. Push includes every org user (`kiro.user.email` when resolvable) | None | **unclear** | **org_attested** (a single admin could forge) | **T2o** org connector ◐ |
| Mistral Vibe Pro/Free/Student (Vibe CLI, Vibe Code) | Account sign-in yields a Mistral API key in `~/.vibe/.env` | Technically (`api_base`), but the relay would receive the user's key; plan-key behind third-party gateway unverified ⚠ | None via API for Pro | Vibe CLI OTel traces: `gen_ai.usage.input/output_tokens`, model, response id. `otel_redaction="strict"` keeps them; **default passes tool args/results in clear text**. Without `otel_endpoint`, traces go to Mistral with the user's key | **unclear** for routing; consumer terms bar making credentials available to third parties; Commercial §2.2(h) bars transferring API keys, §2.2(i) bars integrating Vibe into third-party products | device_reported | **T3** after legal read of §2.2(i) ◐ |
| Mistral le Chat web/apps (Pro/Free/Student) | Browser session / app sign-in | No | None via API for Pro | None | **unclear** | none | **T0** |
| Mistral Team / Enterprise | Workspace keys; Enterprise Admin API key (`x-api-key`) | Same as Pro | Enterprise only (Preview): `/v1/admin/usage` monthly by category; Vibe analytics daily tokens per model **per workspace**; le Chat per-user counts (no tokens) | Same | **unclear** (§2.2(h),(i)) | provider_attested (workspace aggregate) | **T2** org connector, later ◐ |
| Perplexity Pro/Max (web, apps, Comet, Computer) | Account session; API is separate pay-as-you-go (primary source 403 ⚠) | No | None | None | **prohibited** for intercepting software (§5.2(i) bans software that "intercepts" the Services); no clause on relaying credentials | none | **T0** |
| Perplexity Enterprise Pro/Max | SSO; org analytics key | No | Computer Analytics API: org and **per-user** daily credit_usage and query_volume by feature (Search/Computer) and model; no tokens or USD | None | **unclear** (Enterprise Terms §1.2; AUP unretrievable ⚠) | provider_attested (credits and query counts) | **T2** org connector, later ◐ |

## 2.7 Round 2 providers

Researched 2026-09-16 by the same research-plus-skeptic method, in five families. Where the two disagreed, the skeptic's value is used unless its evidence was weaker. International pages were checked unless a row says otherwise. Mainland-China editions of Z.ai (BigModel) and Kimi were **not** reviewed.

Column conventions for this section:
- **Base-URL override.** For key-based plans this column gives the plan's documented endpoint. It also says whether USAGE could hold the key and forward traffic (**T1k**, §3).
- **Verification ceiling.** The value is **today's** ceiling. "→ server_observed if permitted" marks rows where a written-permission route exists. It is not a prediction that permission will be granted.
- **Product changes.** Several products changed name, pricing or availability during 2026. Re-verify every row before building.

**Headline: no round-2 product is both technically routable through USAGE and permitted by its terms.** See §2.7.5 for the flags that apply across rows.

### 2.7.1 Flat-rate plans delivered as an API key

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| Z.ai GLM Coding Plan, Individual (Lite/Pro/Max, from USD 18/month) | Static plan key from the console (Individual Coding Plan > Plan Overview); not a general Z.ai API key | Technically yes. `https://api.z.ai/api/anthropic` (Claude Code `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), `/api/coding/paas/v4` (OpenAI Chat), `/api/v1` (OpenAI Responses). A USAGE relay would be an unlisted "other system" or proxy. Calls from outside supported tools or to other endpoints do not use plan quota: they fail with error 1113 or draw on the **paid account balance** | Response `usage` token fields expected; untested ⚠. Undocumented monitor endpoints (`/api/monitor/usage/quota/limit`, `/model-usage`, `/tool-usage`) appear only in Z.ai's own plugin source. That source sends the raw key with no `Bearer`, parses a 5-hour token limit and a monthly MCP limit (not a weekly one), and works on the Personal plan only. Percentages and counts, never money. Credits are an internal unit with no USD value (GLM-5.3 multipliers: input 6.9, cached 1.7, output 24; peak Mon-Fri 14:00-18:00 SGT) | None of its own. Through Claude Code, Claude Code OTel applies, and its `cost_usd` uses Anthropic prices, so it is wrong here (dropped anyway) | **prohibited**. Subscription Terms §4.2: supported tools only; no direct calls from your own apps, bots, websites, SaaS or other systems without a written agreement; no reselling, repackaging, aggregating or proxying. §4.3: one natural person; bulk automated usage is grounds for suspension. The Usage Policy escalates to a permanent ban after more than three violations | device_reported | **T3** via Claude Code third-party-plan observe (§4.1). The key stays local and the miner stays out of the request path; the §8.1.2 gate applies. **No T1k.** No monitor-endpoint poll without written Z.ai confirmation |
| Z.ai GLM Coding Plan, Team | Per-member Team Plan Key (Team Coding Plan > My Plan). Minimum 2 seats; members and seats 1:1 | Same endpoints; same prohibition | Admin Usage Statistics portal by member and time period: **console only, no API**. The usage-query plugin is Personal-only. Seats: Standard 15,000 / 66,000 credits (5-hour / weekly), Premium 35,000 / 155,000 | As Individual | **prohibited** (same terms; seat sharing, unsupported tools and abnormally high-frequency calls trigger restrictions) | device_reported | **T3** as Individual; no org connector (no API) ◐ |
| Z.ai ZCode desktop app | Account sign-in linked to the plan (the docs do not call it OAuth), or an API key | No. Signed-in mode is undocumented, and a relay is outside the terms | The Usage Stats > Coding Plan tab reads remote plan statistics; no public API | App Usage reads local ZCode session records, which likely hold content: **never read**. No export or OTel documented | **prohibited** (same terms) | none | **T0** ◐ |
| Moonshot Kimi Code (membership benefit, formerly "Kimi For Coding"), API key in third-party tools | Up to 5 console keys, each shown once; bearer or `x-api-key` | Technically yes. `https://api.kimi.com/coding/` (Anthropic-compatible; Claude Code needs `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and every `ANTHROPIC_DEFAULT_*_MODEL` plus `CLAUDE_CODE_SUBAGENT_MODEL` set to the Kimi model) and `/coding/v1` (OpenAI). ⚡ The help-centre page shows different variable names and URL from the docs site; treat the docs site as canonical. A relay changes the source IP, and the rules forbid altering the User-Agent | Response `usage` expected; untested ⚠. Undocumented `GET {base}/usages` (found in Moonshot's open-source clients; Bearer; a data-driven `limits[]` array of windows). Console and web "My Quota". No per-request money. Credits refresh every 7 days; 5-hour window; monthly cap shared with Kimi web; optional Extra Usage wallet spent after plan credits | None of its own. Claude Code OTel should report Kimi model names (e.g. `k3-256k`); untested ⚠ | **unclear, leaning against.** Community Guidelines: interactive use only in mainstream coding tools; platform integrations and enterprise use go to the Kimi Platform; no reverse-proxy account sharing; no reselling accounts or **API access**; no client-identity spoofing. Model Service Agreement: no account transfer without consent; non-commercial personal use unless authorized in writing. Many members' traffic from USAGE's IPs would look like reverse-proxy sharing | device_reported (→ server_observed only with written Kimi Platform approval) | **T3** via Claude Code third-party-plan observe. T1k only after written approval, which is unlikely ◐ |
| Kimi Code official clients (kimi-cli, kimi-code, VS Code, Desktop), OAuth login | OAuth device/app login managed by the clients | No. The managed provider is fixed to `api.kimi.com`, and relaying would mean handling the OAuth token | `/usages` with the OAuth token (undocumented); console | kimi-cli product telemetry is on by default and posts to a fixed `telemetry-logs.kimi.com` endpoint, with no exporter option. Session files hold conversation content: **never read** | **unclear** (same guidelines; nothing on relaying OAuth sessions) | none | **T0** ◐ |
| MiniMax Token Plan (formerly Coding Plan; Plus $22 / Max $55 / Ultra $132; CNY 49/119/469 in China) | Static Subscription Key, one per user per Team, not interchangeable with pay-as-you-go keys. **The same key spends purchased Credits automatically** once plan quota runs out | Technically yes. `https://api.minimax.io/anthropic` (China `api.minimax.cn/anthropic`), plain bearer; nothing ties the key to a client | Anthropic-format `usage` (input/output tokens); no per-request cost. The FAQ documents `GET https://www.minimax.io/v1/token_plan/remains` with a Bearer key. Response fields are undocumented, and it is untested whether it accepts the key (the legacy `coding_plan/remains` reportedly needed a cookie, a lead) ⚠. Aggregate only. The quota model changed during 2026 | None of its own; Claude Code OTel | **unclear, leaning against.** ToS clause 7 (effective 2026-03-30): no leasing, selling, sublicensing, distributing or **transferring access keys without express permission**. 7(c): no resale outside integrated applications. FAQ: individual, interactive developer use; pay-as-you-go for production; rate control against automated batch and multi-user sharing. No tool whitelist | device_reported (→ server_observed only with express written permission) | **T3** via Claude Code third-party-plan observe. **T1k candidate** after express permission; overflow may be paid Credits, so cost stays unknown ◐ |
| Alibaba Cloud Model Studio Coding Plan (international; Pro $50; Lite closed to new sales 2026-03-20 and to renewals 2026-04-13) | `sk-sp-` plan key; one key per subscription, one subscription per account | Technically yes. `https://coding-intl.dashscope.aliyuncs.com/v1` and `/apps/anthropic` | Console call counts and quota only. The FAQ says token consumption cannot be viewed. No API. Quotas: 6,000 requests per 5 hours, 45,000 per week, 90,000 per month | Qwen Code OTel: off by default; **`logPrompts` defaults to true** once enabled; also records tool and file operations. Claude Code OTel | **prohibited.** Interactive use in coding tools only; no automated scripts, application backends or non-interactive use; "for personal use only and must not be shared"; curl, Postman and Dify use violates the terms | device_reported | **T3** (Qwen Code or Claude Code observe) |
| Alibaba Cloud Model Studio Token Plan, Personal (Lite $6 / Standard $18 / Pro $68, limited-time) and Team ($20-$200 per seat; Singapore region only) | Console key; Team: one key per seat, bound to one member | Technically yes; prohibited. The base URL is shown only in the console, not in public docs (⚠ unverified), so it is excluded from the §4.2 plan-host enum until documented | Personal: console subscription page. Team: Usage Analytics (1/7/30 days, per model, per member), **console only**. No API | As Coding Plan | **prohibited.** Interactive use only; no scripts or backends; Personal is limited to **one device per individual user** (international page too) and bans sharing; Team keys cannot be shared | device_reported | **T3.** The miner must never help copy the key across PCs. Team: no connector (no API) |
| Volcengine Ark Coding Plan (China; roughly CNY 40-1,000/month) | Ordinary Ark API key used with plan base URLs | Technically yes. `https://ark.cn-beijing.volces.com/api/coding` (Anthropic) and `/api/coding/v3` (OpenAI); prohibited. **A request that does not use the plan base URL may be billed pay-as-you-go** | Console activation page; no API | Via the client tool | **prohibited** (doc updated 2026-09-15): quota valid only in AI coding tools and not for API calls; other use may count as abuse, leading to suspension or an account ban; enterprise needs go to the regular Ark API | device_reported | **T3.** The newer Ark Agent Plan was not researched |
| Tencent Cloud Coding Plan (TokenHub / LKEAP; Lite CNY 40, Pro CNY 200) | `sk-sp-` plan key | Technically yes. `https://api.lkeap.cloud.tencent.com/coding/anthropic` and `/coding/v3`; prohibited | Console only; no API | Via the client tool | **prohibited** (doc updated 2026-09-10): programming tools only; no scripts, custom backends or batch use; account sharing strictly prohibited | device_reported | **T3.** Possibly no longer sold: Tencent's FAQ calls Token Plan "a full upgrade" (secondary sources report a sell-out around 2026-04-22). Tencent Token Plan not researched ◐ |
| Baidu Qianfan Token Plan Personal (Mini CNY 9.9 / Lite 40 / Pro 200 / Max 600; replaces Coding Plan) | Plan-specific key | Technically yes. `https://qianfan.baidubce.com/anthropic/tokenplan/personal` and `/v2/tokenplan/personal` (the old Coding Plan used `/anthropic/coding` and `/v2/coding`); prohibited | Subscription console; no API | Via the client tool | **prohibited:** interactive use in AI coding and agent tools only; no scripts or backends; suspension or key ban. The old Coding Plan also limited Lite to 1 terminal and Pro to 2 | device_reported | **T3.** Coding Plan renewals stopped 2026-06-25. Token Plan Enterprise not researched |
| StepFun Step Plan (Flash Mini $6.99 to Flash Max $99/month; credits) | StepFun API key on the plan endpoint | Technically yes. `https://api.stepfun.ai/step_plan` (Anthropic-compatible; official Claude Code guide) and `/step_plan/v1` (OpenAI); prohibited | Not documented; no API | Via the client tool | **prohibited.** Paid Service Agreement §3 (effective 2026-03-16): personal use by the subscribing account only; no providing the service to third parties in any form, including reauthorizing; no "unofficial, unauthorized, or unspecified tools, plugins, interfaces"; no scripts or proxies to get around limits | device_reported | **T3** |
| OpenCode Go (Anomaly; $10/month, dollar-denominated caps: 5-hour 20%, weekly 50%, monthly 100%) | OpenCode Zen API key; a stable `x-opencode-session` header per conversation | Technically yes. `https://opencode.ai/zen/go/v1/messages`, `/v1/chat/completions` and `/v1/responses`, depending on the model. Validated clients: Hermes, Claude Code, Codex, ZCode, Pi, jcode, Kilo Code CLI. A transparent relay could keep the session header | Console usage against limits. Whether responses carry cost is undocumented. No API | Via the client tool | **unclear.** ToS (2026-08-15): the customer's own internal use, not on behalf of or for the benefit of third parties; no multiple accounts to evade limits; no automated or programmatic extraction of Output. The Go docs say traffic is monitored for abuse | device_reported (→ server_observed only with written Anomaly confirmation) | **T3** via Claude Code third-party-plan observe. **T1k candidate** after written confirmation ◐ |
| ClinePass (Cline Bot Inc.; $9.99/month after a promotion; 5-hour, weekly and monthly windows) | Cline account in Cline clients; for other agents, a Cline API key (Bearer) from app.cline.bot, which the landing page says works "with other coding agents" | Technically yes. `https://api.cline.bot/api/v1/chat/completions` with `cline-pass/<model>` slugs. **OpenAI format only** (no Anthropic Messages surface, so Claude Code would need translation) | Responses carry `usage` tokens and `usage.cost` in USD (final SSE chunk when streaming). What `cost` means for quota-covered `cline-pass/` models is unknown ⚠. Quota on the dashboard; no API. ⚡ Model count: 13 in the docs, 15 on the landing page | OTel only through dashboard Remote Configuration (org-controlled; anonymous feature metrics; no tokens), so unavailable to the miner | **unclear, restrictive reading.** ToS (2025-09-25, older than ClinePass): no buying, selling or transferring API keys "without our prior written consent"; no access by unauthorized means; Payment Representations item (v): do not let anyone else use your Subscription or share authentication credentials. No clause on proxies | device_reported (→ server_observed with written consent) | **T1k candidate** after written consent. No T3 planned (no Anthropic-compatible surface) ◐ |
| Cerebras Code (Free / Pro $50, 24M tokens/day / Max $200, 120M/day; GLM 4.7) | Cerebras Cloud API key | Technically yes: an OpenAI-compatible endpoint. No Anthropic-compatible endpoint verified | OpenAI `usage` object (not re-verified for Code plans); no dashboard or API found | Via the client tool | **unclear.** Inference terms seen only in search results ⚠: non-transferable, non-sublicensable licence; no transferring or reselling API keys without consent | device_reported | **Skip.** Every tier is sold out; low confidence ◐ |

### 2.7.2 Credit plans delivered as an API key

These plans spend prepaid credits at per-token rates, so they are not pure flat-rate subscriptions. They are listed because they are the most technically routable round-2 products.

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| Ollama Cloud Pro / Max / Team (credit plans since 2026-08-31: Pro $20 with $60 credits, Max $100 with $300, Team $500 with $1,000 shared) | User-created API key sent as `Authorization: Bearer` (`x-api-key` alone is not accepted on `/v1/messages`); non-expiring, revocable | Technically yes, and documented. `https://ollama.com` (Claude Code `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), `/v1` (OpenAI), `/api` (native). The cloud Anthropic path does not support prompt caching, `tool_choice` or `metadata`, and does not enforce thinking `budget_tokens`. No stateful Responses | Per response: Anthropic path `input_tokens`/`output_tokens` only (no cached split); native API adds `prompt_eval_cached_count`. **No cost field in any response.** The account UI shows each request's cost, but no documented API exposes it: never scraped. `/api/usage` is undocumented ⚠. Peak pricing doubles rates 12:00-18:00 UTC on weekdays; cached input is priced separately; included credits are spent before purchased ones | No OTel | **unclear.** Terms (May 2026) contain no proxy, resale, sublicensing or account-sharing clause. §3: keep credentials confidential. §4: no automated access without permission; no competing products. The pricing page: one account per person. Ollama markets its plans for coding agents "plus an API for your own tools". A third party holding the key is not addressed | device_reported (→ server_observed if Ollama confirms in writing) | **T1k candidate #1** after written confirmation: ROUTED, `pending_cost`, never tokens × rate (peak and cache pricing make that wrong as well as forbidden). T3 via Claude Code third-party-plan observe meanwhile ◐ |
| Ollama legacy Pro / Max / Team (bought before 2026-08-31; GPU-time billing with session and weekly limits) | Same key | Same endpoints | Per-response tokens. Plan use only as a percentage of session and weekly limits; no money. Converts to the new pricing on a billing-cycle or tier change | No OTel | **unclear** (same terms) | device_reported | Covered by the same T1k route if built. Cost is unknown indefinitely ◐ |
| Ollama app/CLI signed in (local daemon, `:cloud` models, `ollama launch claude`) | `ollama signin` registers an ed25519 key pair; private key `~/.ollama/id_ed25519` (Windows `C:\Users\<user>\.ollama\id_ed25519`) | No. Tools point at `http://localhost:11434` and the daemon holds the account identity; USAGE cannot sit in that path without the device key | Account settings page only | The daemon returns token counts to the local client. Reading them would need a local proxy that sees content in memory; no OTel | **unclear** (no clause) | device_reported | **T3 deferred** (no mechanism fits §4). Steer users to the API-key path ◐ |
| Cline credits / Cline API (pay-as-you-go "Cline (usage-billing)") | Cline account; API key (Bearer) from app.cline.bot | Technically yes: the same OpenAI-compatible `api.cline.bot/api/v1`. Marketed for internal tools, CI and backend services | `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` and `usage.cost` ("Total cost in USD for this request"). **The only round-2 plan or subscription source with a provider-stated per-request USD cost** (xAI's pay-per-token API, not a plan, also returns `cost_in_usd_ticks`). No individual usage or balance API | As ClinePass (unavailable to the miner) | **unclear, restrictive reading** (same ToS clauses as ClinePass) | device_reported (→ server_observed with provider-stated cost, with written consent) | **T1k candidate** after written consent (same request as ClinePass). This is pay-per-token, not a subscription, so it would be ordinary ROUTED paid traffic with `cost` parsed through `usdStringToMicros` ◐ |
| Kilo Pass + Kilo Gateway (Starter $19 / Pro $49 / Expert $199 of credits at provider list rates, zero markup) | Kilo account; gateway API key (a JWT) as Bearer; org tokens expire after 15 minutes | Technically yes. OpenAI-compatible `https://api.kilo.ai/api/gateway` (`/chat/completions`, `/api/fim/completions`, `/models`, `/providers`); no `/v1/messages`. Kilo Pass credits are usable through it | `usage.prompt_tokens`, `completion_tokens`, `total_tokens`. Cost is tracked internally in microdollars, but **no client-facing cost field is documented** ⚠. No balance endpoint; HTTP 402 at zero balance | Kilo CLI OTel is **on by default** (`experimental.openTelemetry = false` turns it off) and uses `OTEL_EXPORTER_OTLP_ENDPOINT`. Request spans carry `session.id`, `message.id` and internal `opencode.*` params; token attributes undocumented | **unclear.** ToS (2026-01-29): a Gateway API "Your Service" clause lets platforms expose the Service if their end users comply with Kilo's Terms, but nothing covers holding each user's key. One account per entity; credentials confidential. Paid credits expire after one year; bonus credits expire monthly | device_reported (→ server_observed if Kilo confirms) | **T1k candidate** after written confirmation; `pending_cost` unless a client-facing cost field is confirmed. **Any Kilo route must exclude the models and accounts Kilo serves on third-party plans** (ChatGPT, SuperGrok, Z.ai, Kimi, MiMo): relaying Z.ai plan traffic or SuperGrok OAuth traffic is prohibited by those providers, and the others fall under those plans' terms, not Kilo Pass. If the gateway cannot tell them apart (⚠ unverified), no Kilo route is built ◐ |

### 2.7.3 App-login and editor subscriptions

| Product | Auth | Base-URL override w/ subscription auth | Provider-side usage data | Local telemetry | ToS on third-party routing | Verification ceiling | Recommended tier |
|---|---|---|---|---|---|---|---|
| xAI SuperGrok / SuperGrok Heavy / X Premium+ (grok.com, Grok apps, Grok on X) | Consumer login (accounts.x.ai / auth.x.ai; X login for Premium+). One weekly usage pool shared across Chat, Imagine, Voice, Build and API-type use; Extra Usage Credits | No | Settings > Usage: percentage used, breakdown by product (API, Build, Chat, Imagine, Voice), weekly reset, Extra Usage Credits balance. No API, tokens or cost | None | **prohibited.** Consumer Terms (SpaceXAI LLC, 2026-09-11): no sharing credentials or making the account available to anyone else. AUP (2026-08-14): no unauthorized automated access, no reselling Inputs/Outputs, no circumventing limits. The Grok FAQ tells users to revoke credentials a third-party app has used | none | **T0** (T3s at most) |
| Grok Build CLI (`grok`) on SuperGrok / X Premium+ | `grok login` (browser OIDC via auth.x.ai, or `--device-auth`); token cached in `~/.grok/auth.json`. Subscription inference goes to `cli-chat-proxy.grok.com`. Credential order: `model.api_key` > `model.env_key` > **signed-in session token** > `XAI_API_KEY` | **The block is contractual, not technical.** `GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_MODELS_BASE_URL` or a custom model `base_url` with no model-level key **sends the signed-in session token to that URL**. It must never point at USAGE (§2.7.5) | Settings > Usage only. (Pay-per-token xAI API keys, which are not the subscription, return an authoritative `usage.cost_in_usd_ticks`: 1 USD = 10^10 ticks, so 1 micro-USD = 10,000 ticks) | Official external OTel with a **double opt-in**: `GROK_EXTERNAL_OTEL=1` **and** `OTEL_METRICS_EXPORTER`/`OTEL_LOGS_EXPORTER=otlp`. Emits `grok_code.token.usage` (input/output/reasoning/cache_read, model) and a per-request `grok_code.api_request` log event. No cost metric. `user.email` is always attached on OAuth sessions and cannot be turned off. Content gates `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` (inherits the prompts gate if unset), `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`. xAI can force-disable the stream fleet-wide through a startup `/v1/settings` fetch, and a signed `requirements.toml` overrides env | Routing **prohibited** (Terms and AUP). Export to a collector the user chooses is a documented first-party feature | device_reported | **T3** (new adapter, §4.1). It may stop working without notice |
| SuperGrok in xAI-announced partner apps (OpenCode, Kilo Code, Warp, OpenClaw, Hermes) | "xAI Grok OAuth (SuperGrok Subscription)" through per-partner arrangements. xAI keeps an allowlist on the OAuth surface (403s reported; lead) | Not a base-URL mechanism. USAGE has no OAuth client, and reusing a partner's client id would be impersonation. Warp's in-flight relay is a partner arrangement, not a precedent | Not documented for OAuth traffic | Partner-dependent | **prohibited** for non-partners (credential-sharing clause); partners are announced one at a time | none | **T0.** A formal xAI partnership is a business question (D10), not engineering |
| Microsoft 365 Personal / Family / Premium Copilot (consumer) | Microsoft account login in Microsoft apps | No | AI credit balance under Microsoft account > Services & subscriptions; plan matrix is qualitative (Standard/Extensive/Highest usage); credits deducted per action. No API | None | **prohibited.** Copilot Supplemental Terms (effective 2026-08-18): no bots, scrapers, tools or programs; personal use only; covers Microsoft 365 apps; excludes Entra (work/school) sign-ins | none | **T0** |
| Microsoft 365 Copilot (enterprise per-user licence) | Entra ID. Graph `Reports.Read.All` as an **application** permission (admin consent, tenant-wide, no user role) or delegated (needs an admin or Reports Reader role) | No LLM endpoint. The Copilot Chat API (preview) is Graph-grounded and text-only, not OpenAI- or Anthropic-compatible | `getMicrosoft365CopilotUsageUserDetail`: last-activity dates per app. Prompt counts and active days exist **only in report v2** (periods D7/D28/D90/D180/ALL; v1 uses D30). User names are **concealed by default** (hashed UPNs) unless a global admin turns that off tenant-wide. No tokens or cost; rolling periods do not align with epochs | None | Routing n/a. Copilot APIs Terms (preview, December 2025): guideline 18 bars non-human-directed apps ("bots, multiplexing"); guideline 4 bars databases beyond the intended scenario; §5 deletion when a user leaves; §4 Microsoft audit rights | provider_attested (activity counts, tenant-wide) | **T2** activity only, lowest priority. The grant reads every licensed employee (§5.2) ◐ |
| Zed Pro / Business / Student (Zed-hosted models; Pro $10 with $5 credit, then list +10% under a spend limit; Business $30/seat) | Zed account through GitHub OAuth; **no API key for hosted models** | No. Hosted traffic goes to a non-public Zed endpoint. `api_url` exists only for user-connected providers (openai_compatible, anthropic_compatible, Mistral, DeepSeek, xAI), see §2.8 | dashboard.zed.dev (Orb); no API | Telemetry log without billed tokens; no OTel | **likely prohibited.** ToS §2.4 (2026-03-02): no seeking non-public APIs, no circumventing access restrictions, no providing the Service to third parties. No clause names proxies | none | **T0** (T3s at most). Earning goes through the §2.8 BYOK route |
| Warp Build / Max / Business (credits: Build $20 for 1,500, Max $200 for 18,000, Business $50/seat) | Warp login. `wk-` Personal/Agent keys authenticate only the Oz CLI/SDK and agent runs, draw credits, and have no read-only scope | No inference endpoint for outside tools. The **custom inference endpoint** (called from Warp's backend; public HTTPS URL; Chat Completions) is officially documented for third-party gateways and uses no Warp credits, so it belongs in §2.8, not here | In-app balance. Agent CLI `/usage` and `/cost` are interactive only. Agent-run objects have no usage fields | Rudderstack/Sentry analytics, Network Log; no OTel | **unclear** for plan credits. ToS (2025-10-07): no robots or scrapers, no circumventing usage caps, no resale, sublicensing or unauthorized access; credits cannot be transferred | none | **T0** for plan credits |
| Warp Enterprise | SSO. The Analytics API needs a team admin's Personal key, which is **not read-only** (it can start agent runs and spend credits) | n/a | Analytics API (Early Access; admin must enable Enterprise Usage Reporting): summary, users, events. `credit_charged` is the only economic field; no tokens or USD. Events carry **email, branch name and commit hash**, which must be dropped | As above | **unclear** (private contract) | provider_attested (credits) | **T2** org connector, later; blocked until a read-only key exists ◐ |
| Augment Code Standard / Business ($20 / $100 of dollar usage at list price + 40%, plus Cosmos $0.19/hour) | `auggie login` session JSON (`auggie token print`, `AUGMENT_SESSION_AUTH`); the docs call these tokens secrets tied to one user. No inference key | No API URL, tenant URL or BYOK override | app.augmentcode.com dashboard; no API | `--print --show-credits` and `--output-format json` exist only for non-interactive runs, which the miner never starts. Local session snapshots reportedly hold token usage **and full chat history** (lead): never read. No OTel | **unclear.** Professional ToS v1.9: §1.1 credentials not used by more than one individual; §1.6 no service bureau; §1.9 third-party tools at the customer's responsibility. Holding the session JSON conflicts with §1.1 | none practical | **T0** ◐ |
| Augment Code Enterprise | Service-account token (Enterprise, Administrator-created), shown once | n/a | Analytics API (preview), 8 endpoints: DAU, daily usage, per-user credit usage with model breakdown (units undocumented), editor/language breakdown, and **set budget overrides (write)**. Daily data at about 02:00 UTC; 90-day range; 2-year lookback | As above | **unclear** (Enterprise ToS §1.6) | provider_attested (daily credits) | **T2** org connector, later; the token is not read-only ◐ |
| Tabnine Enterprise (Code Assistant $39 / Agentic Platform $59 per user, annual; individual plans discontinued) | Tabnine sign-in (SSO). Personal Access Tokens with scoped permissions, **creatable by any user**; service accounts | No inference endpoint. Org admins can add an OpenAI-compatible model provider; whether Tabnine SaaS or the client calls it is undocumented ⚠ | `/api/v2/user/usage` and `/api/v1/user/agent-usage` (org/team/user levels) with a PAT scoped to Usage metrics read. Token or dollar fields are undocumented (⚡ the docs assistant and the API overview disagree). Private installs may need "API by token" enabled | Tabnine CLI (Agentic Platform tier only): `telemetry.otlpEndpoint`, `otlpProtocol`, `logPrompts`. Reportedly a Gemini CLI fork (lead), so tool-call arguments may be exported even with `logPrompts` off | Routing **likely prohibited.** Terms of Use (2024-07-25): no auto or macro programs, no intercepting or deciphering transmissions, no account sharing; no clause names proxies. A PAT usage read is a documented feature, but sharing with a third party depends on the org's MSA | provider_attested (fields unconfirmed) | **T2** per-user or org connector after a live field check and org consent. T3 CLI adapter deferred ◐ |
| Amp (Hobby free; Megawatt $20 with a 60% usage discount; Gigawatt 65%) | Amp account (WorkOS). External API: OAuth 2.0 machine-to-machine apps created at ampcode.com/workspace/applications; which plans and roles can create them is undocumented ⚠ | No for Amp-billed usage (inference is server-side). Model Routing "custom endpoint URLs" (early access for Megawatt/Gigawatt; spec undocumented ⚠) is BYOK, §2.8 | `GET /threads/{id}/usage`: thread cost in USD, per-model requests, input/output/cache tokens, threads under 90 days old. Needs only `amp.api:workspace.threads.meta:view`. Also a workspace `analytics.daily-usage:view` endpoint (fields undocumented ⚠). **Never request** `threads.contents:view` (titles, messages) or the `model-provider-keys` scopes. The BYOK "estimated provider cost" field is experimental | `--stream-json` usage (no cost) only in execute mode, which the miner never starts; no OTel | **unclear.** Terms: single user, at most two subscriptions, no direct resale of quotas. AUP (2026-09-10): one human per account; free usage not as raw inference outside Amp. Nothing on third-party External API consumers. The Terms still describe BYOK as Enterprise-only, behind the 2026-09-13 change | provider_attested | **T2 individual candidate** (Phase 1b) after an availability check and Amp's written position. BYOK-funded threads are not Amp-billed; they are labelled separately and never counted as an Amp plan. Threads funded by a linked ChatGPT subscription are **excluded** (not stored or displayed) until OpenAI's consumer terms on hosted relays are checked (§8.1.4) ◐ |
| Factory Droid Pro / Plus / Max ($20 / $100 / $200; 5-hour, 7-day and 30-day windows) | Factory login; `FACTORY_API_KEY` (`fk-`) for headless `droid exec`, a Factory credential rather than an LLM key | No for plan usage (unofficial OAuth-to-OpenAI bridges run into the reverse-engineering clause). BYOK `customModels` `baseUrl` goes straight from the CLI (§2.8). ⚡ Docs conflict on whether BYOK usage is charged against an allowance | Settings > Usage and `/limits`. The Analytics API (tokens, cost estimates) is documented under Enterprise only | Customer OTel (`OTEL_TELEMETRY_ENDPOINT` and related) is documented under Enterprise, and **token and cost data are explicitly excluded** from it. `OTEL_LOG_MESSAGE_CONTENT` exports messages and tool I/O. `stream-jsonrpc` token notifications exist only for headless runs | **unclear.** Individual Plans Terms (2026-07-14): internal use; no sublicensing, timesharing or service bureau; no reverse engineering | none practical for plan tokens | **T0** for tokens. Ask Factory whether the Analytics API is open to individuals ◐ |
| Replit Core / Pro (Agent; $20 / $100 of included credits) | Replit login; Agent runs in Replit's cloud | No. AI Integrations credentials are scoped to Replit Apps, and no env var names or base URL are documented | replit.com/usage per app, up to 30 minutes late; no API | None | **unclear** (ToS 2026-08-03 has no routing clause; bans scraping and reverse engineering) | none | **T0** |

### 2.7.4 Discontinued or unavailable (as of 2026-09-16)

| Product | Status | Evidence | Treatment |
|---|---|---|---|
| Qwen OAuth (Qwen Code free app-login tier) | Ended 2026-04-15; new requests rejected | Qwen Code auth docs | Not integrated. Qwen Code users on the Alibaba Coding Plan or Token Plan follow those rows |
| Ollama Turbo | No longer sold; `ollama.com/turbo` serves the pricing page | Pricing page; Ollama blog | Legacy plans continue (§2.7.2) |
| Microsoft Copilot Pro (consumer, $20) | Not sold; support ended 2026-08-01 | Microsoft Support | Shown as retired if listed |
| Warp Pro / Turbo / Lightspeed | Converted to Build at the first renewal after 2025-12-01 | Warp pricing blog | Treated as Build/Max |
| Tabnine Basic / Dev / Pro | The pricing page lists only team plans; the Dev doc returns 404. Retirement dates come only from secondary sources ◐ | Tabnine pricing and subscription-plans docs | Not built |
| Roo Code extension, Cloud and Router | Repository archived 2026-05-15; roocode.com redirects to roomote.dev (BYOK-only successor) | GitHub repo README; HTTP 301 checks | Dropped. The community ZooCode fork is an ordinary BYOK tool (§2.8) |
| Baidu Qianfan Coding Plan | Renewals stopped 2026-06-25; replaced by Token Plan Personal | Baidu announcement | Token Plan Personal row |
| Alibaba Coding Plan Lite | New sales stopped 2026-03-20, renewals 2026-04-13. Pro is sold in limited daily batches in China | Alibaba overview | Pro row only |
| Tencent Cloud Coding Plan | Possibly not sold to new buyers ◐ | Tencent FAQ (Token Plan as "full upgrade"); secondary reports | Row kept; Token Plan not researched |
| Cerebras Code Free / Pro / Max | All tiers sold out | cerebras.ai/code | Skip |

### 2.7.5 Round 2 flags (apply across rows)

1. **No product is routable and permitted.**
   - Written-permission routes exist for Ollama, Cline, Kilo, MiniMax, OpenCode Go and (weakly) Kimi.
   - Until a provider grants permission in writing, its plan key is **never** stored for routing. "Unclear" is not permission.
2. **Real money on misconfiguration.** A wrong or overflowing route can spend the user's paid balance:
   - **Z.ai:** non-plan endpoints draw on the account balance.
   - **Volcengine:** a request without the plan base URL may be billed pay-as-you-go.
   - **MiniMax:** Credits cover overflow automatically.
   - **Ollama:** purchased credits are spent after the included ones.
   - **Kimi:** the Extra Usage wallet is spent after plan credits.
   - **Factory:** BYOK overage (⚡).

   The miner **never writes or edits a plan base URL or key**. Its preflight only compares the configured host with the exact documented plan host (§4.2). A T1k route would use a server-fixed upstream and would have to surface 402 and 1113 errors, never retry them.

   **Display of overflow.** Where quota overflows into paid credits (MiniMax Credits, Ollama purchased credits, Kimi Extra Usage), neither the device nor USAGE can tell plan quota from paid overflow. T3 rows for these plans are labelled by plan host only, never as "covered by plan" or "included in subscription", and carry a note that some of this usage may have been billed to paid credits.
3. **Claude Code on a third-party backend.**
   - **Cost.** `cost_usd` is an Anthropic-price estimate and wrong for GLM, Kimi, MiniMax and similar models. It is already dropped (§4.3).
   - **Labels.** Rows are labelled by the preflight's plan-host enum, never as Claude usage.
   - **Credential leak.** If a claude.ai login is also present, Claude Code may send the claude.ai OAuth token to the third-party host (§2.1; precedence probe §8.2.1). The preflight refuses that combination.
4. **Grok credential leak.** Any Grok endpoint override set while a subscription session exists delivers the SuperGrok session bearer to that host. The miner never sets one and refuses launch if one is present.
5. **Telemetry that exports content by default.**
   - **Qwen Code:** `logPrompts` defaults to true, and telemetry records tool and file operations.
   - **Kilo CLI:** OTel is on by default and its spans carry `opencode.*` params.
   - **Tabnine CLI:** may export tool-call arguments.
   - **Factory:** `OTEL_LOG_MESSAGE_CONTENT` exports messages and tool I/O.
   - **Grok Build:** attaches `user.email` and inherits response logging from the prompts gate.
   - **Rule:** allowlist numeric fields, pin every content gate off, and trip the session on content (§4.2, §4.3).
6. **Local credential and content stores that are never read** (§4.7): `~/.ollama/id_ed25519`, `~/.grok/auth.json`, the Augment session JSON and session snapshots, kimi-cli session files and OAuth tokens, ZCode session records, and plan keys in Claude Code settings `env`.
7. **Undocumented quota endpoints** (Z.ai monitor, Kimi `/usages`, Ollama `/api/usage`) appear only in the providers' own client code. They are not built on. MiniMax `token_plan/remains` is documented, but its fields are unknown and it needs key custody.
8. **Shared egress looks like sharing.** A multi-tenant T1k relay sends many users' keys from USAGE's IPs. Several providers treat that pattern as abuse: Kimi (reverse-proxy sharing), MiniMax (multi-user sharing patterns), Z.ai (multi-user access) and OpenCode Go (abuse monitoring). Any permitted relay passes the client User-Agent and session headers through unchanged and keeps per-key concurrency within plan limits.
9. **Interactive-only terms.** Alibaba, Kimi, MiniMax, Baidu and Tencent require interactive use, and Z.ai names bulk automated usage. A relay cannot prove a human drove a request, so §5.6 applies in full to T1k.
10. **Terms older than products, or in flux** (re-verify before acting):
    - The Cline ToS predates ClinePass.
    - Amp's Terms lag its 2026-09-13 BYOK change, and its AUP changed 2026-09-10.
    - ⚡ Docs conflicts: Warp pricing page vs docs on BYOK; Factory BYOK charges; Kimi env var names.
    - MiniMax changed its quota model during 2026.
    - Tencent and Baidu are moving from Coding Plan to Token Plan.
11. **Low confidence** ◐: Cerebras terms (search results only); Tencent sales status; Tabnine retirement dates; Augment local snapshots and the Tabnine-as-Gemini-CLI-fork claim (both leads); xAI's OAuth allowlist (a lead); whether plan endpoints return `usage` when streaming (untested, and not to be probed with real credits without approval).

## 2.8 Contrast: documented routes that are *not* subscription usage

These BYOK paths already fit the existing ROUTED model. USAGE's paid route funds them, never the subscription, and they must never be labelled as subscription usage.

| Path | Where the USAGE credential ends up | Can be disabled by |
|---|---|---|
| Copilot CLI `COPILOT_PROVIDER_BASE_URL` | Local env of the CLI process | — |
| Copilot local BYOK in VS Code, JetBrains, Xcode, the Copilot app | IDE/app settings files on disk | Org or enterprise policy |
| JetBrains AI Assistant "OpenAI-compatible" provider; Junie `JUNIE_LITELLM_URL` | IDE settings / env | Org configuration |
| Mistral Vibe separate `[[providers]]` entry | `~/.vibe` config | — |
| Cursor "Override OpenAI Base URL" (unverified ⚠) | **Cursor's servers.** Cursor's backend calls the URL with the key on every request, so it must be publicly reachable. It covers chat/agent custom models only | Team/Enterprise admins (BYOK controls) |
| Gemini CLI with an API key, `GOOGLE_GEMINI_BASE_URL` | Local env / settings | — |
| Warp custom inference endpoint (round 2; officially documented for OpenRouter, LiteLLM and self-run gateways at a public URL; uses no Warp credits). ⚡ The pricing page seems to exclude Build/Max, while the FAQ and docs include them | **Warp's servers** (the backend calls the public USAGE URL) | Business/Enterprise policy. Free/Build/Max only for individuals and orgs of 10 or fewer employees |
| Zed `openai_compatible` / `anthropic_compatible` provider `api_url` (round 2) | On the device (exact key storage location ⚠ unverified) | — |
| Factory Droid BYOK `customModels` `baseUrl` (round 2; the CLI calls it directly) | `~/.factory/settings.json` | Org admins can restrict allowed base URLs. ⚡ Factory may charge BYOK overage even when inference goes through USAGE |
| Kilo CLI custom OpenAI-compatible provider; ZooCode fork (round 2) | Local config | — |
| Amp Model Routing custom endpoint URL (round 2; early access; spec undocumented ⚠) | **Amp's servers** (inference is server-side) | Not offered until the spec is confirmed |
| Tabnine org OpenAI-compatible model provider (round 2; who calls it is undocumented ⚠) | Tabnine org settings, possibly Tabnine SaaS | Org admin only. Not offered until tested with a Tabnine org |

Before any of these is offered:
- **Credential.** Each BYOK surface gets its own `usgm_` key. The key is narrowly scoped (routed inference only), rate-limited, revocable on its own, and never the miner's device credential. Where no such key type exists yet, the path is not offered.
- **Consent screen.** It says where the key will live. For Cursor, that is a third party's backend.
- **Admin-disabled BYOK.** The path is marked blocked wherever an admin has disabled BYOK.

## 2.9 Out of scope (not researched)

Not covered by this document, and nothing here should be read as a finding about them:
- **Plans named in round 2 but not researched:**
  - Xiaomi MiMo Token Plan; iFlytek Astron Coding/Token Plan; Huawei Cloud MaaS Token Plan; JD Cloud; China Telecom CTyun; Kwai KAT (StreamLake) Coding Plan; Moore Threads; UniAI.
  - Tencent Cloud Token Plan; Volcengine Ark Agent Plan; Baidu Qianfan Token Plan Enterprise.
  - Mainland-China editions: the Zhipu BigModel GLM Coding Plan (`open.bigmodel.cn`) and Kimi's China membership terms.
  - Alibaba Qoder IDE subscription; the MiniMax Agent consumer app; Synthetic coding plans.
  - Kimi membership tier prices, and the Z.ai Team price.
- **Grok Build on the Free tier** (third-party reports only).
- Pay-per-token API keys and cloud-marketplace model access (Bedrock, Vertex, Azure). These are the existing ROUTED/VERIFIED model.
- Negotiated enterprise contracts whose text was not available (Windsurf/Devin Enterprise, Cursor MSA order forms, OpenAI enterprise order forms).
- Consumer chat products not in the round-1 families. Mobile-only apps of the round-1 families beyond those named in the matrix.
- The Anthropic Agent SDK, `claude -p` and third-party-app credit pools as a *metering* source. Their credit-pool change is paused, and the miner never generates traffic anyway.
- Self-hosted Claude Code cloud environments (Team/Enterprise beta) and the Claude apps gateway. These are customer-run infrastructure, not subscription routes.
- Antigravity SDK and Copilot SDK server-side sessions. The first is Vertex/API-key billed. The second would require USAGE to hold user tokens and run prompts, which USAGE's rules forbid.

---

## 3. Evidence tiers for USAGE

Each tier defines what a record *proves*. Only trusted server-side ingestion assigns a tier (rule 11). Clients cannot claim one.

### T1: Server-observed subscription passthrough
**Definition.** The request goes through a USAGE-hosted gateway. The client authenticates to the provider with its own subscription credential, and USAGE forwards that credential unchanged. USAGE reads usage (model, tokens, provider request id) from the provider's response.

**Proves:**
- A request from an authenticated miner reached the provider through USAGE at a given time.
- The provider returned the stated token counts.

**Cannot prove:**
- That the credential was a subscription and not an API key. USAGE can't check without parsing the credential, which this design forbids, so funding is *assumed from the route*.
- Which plan was used, or whether the request was inside the plan allowance or billed as overage/extra-usage credits.
- That a person, not automation, generated it.
- That the credential belongs to the miner's user (shared accounts).
- Any cost: flat-rate responses carry none.

**Fabrication risk.**
- **Token counts:** low. They come from the provider.
- **Funding labels:** high.
- **Legal and security:** maximal. USAGE handles live subscription credentials on every request.

**Status: no round-1 provider authorizes this.**
- **Explicitly prohibited:** Anthropic (terms) and Google Antigravity (Additional Terms). For Code Assist, the explicit statement is on Google's Gemini CLI docs page. The Cloud ToS contract has no routing clause.
- **Unclear on paper:** OpenAI, GitHub and Cursor. In practice the conflict is with their credential-sharing clauses. Copilot also has a user-quoted support notice citing "proxy usage" (unverified ⚠), and Cursor metering would require protocol decoding.
- **Round 2 (§2.7).** No app-login subscription is a T1 candidate. Relaying one would put a session or OAuth credential in USAGE's hands, which xAI and Microsoft prohibit explicitly and Zed and Tabnine prohibit in effect. Augment's terms are unclear, but holding its session JSON conflicts with its §1.1 (one individual per credential). The key-based plans are assessed under T1k below. They are not T1, because the client does not send the plan credential.

T1 stays a dormant spec until written authorization exists. The existing Claude passthrough (§5.7) is not a T1 implementation. It is a violation that Phase 0a removes.

### T1k: Server-observed via a connected plan key (round 2)
**Definition.** The user connects a plan key (an API key sold with a flat-rate or credit plan) through USAGE's **existing encrypted provider-connection path**, the same way an OpenRouter key is connected today. Then:
1. The miner points the tool at the USAGE gateway carrying only the miner credential.
2. The server decrypts the key and forwards the request to a **server-fixed** upstream, the plan's documented endpoint.
3. The server reads the provider's `usage` from the response.

**How it differs from T1:**
- **No new credential class.** The client never sends a provider credential, and the key is stored under the same explicit, encrypted, server-side connection USAGE already uses for API keys.
- **Custody is the issue.** Storing and using a user's key is exactly what several providers' key-transfer and credential-sharing clauses address (MiniMax clause 7, Cline's "prior written consent", Kimi reverse-proxy sharing, StepFun reauthorization). Custody that is acceptable under USAGE's own rules is not thereby permitted under the provider's.

**Proves:**
- USAGE forwarded a request with that connected key to the provider's endpoint.
- The provider returned the stated model and token counts.

**Cannot prove:**
- That the request drew on plan quota and not paid overflow (MiniMax Credits, Ollama purchased credits, the Kimi Extra Usage wallet).
- That a person, not automation, drove it. Most plans require interactive use.
- That the key is not shared with others.
- Any cost, except the Cline API's provider-stated `usage.cost`.

**Labels:**
- Verification type is `routed` (rule 11), never `verified`.
- Cost is `pending_cost` with an explicit `cost_basis` (unknown or `subscription_flat`) unless the provider states a per-request cost. Tokens × rate is never used.
- Funding class is route-declared: `subscription` for flat-rate plans. For credit plans (Ollama, Kilo, Cline credits) the class is an open question (D13).

**Fabrication risk.** Low for token counts. High for funding labels. Custody risk equals the existing connection path, plus breaking provider terms if permission is missing.

**Status: no round-2 provider authorizes it.**
- **Explicitly prohibited:** Z.ai, Alibaba (Coding Plan and Token Plan), Volcengine, Tencent, Baidu and StepFun.
- **Unclear, with a written-permission route:** Ollama Cloud, Cline (ClinePass and credits), Kilo Gateway, MiniMax, OpenCode Go; Kimi (leaning against); Cerebras (sold out).

T1k is a dormant spec (§5.3). It is built per provider only after that provider's written permission and owner decision D13 (Phase 1c).

### T2: Provider-attested (pull)
**Definition.** USAGE's hosted ingestion fetches records over TLS from the provider's official usage or admin API, using read access that the account or org owner granted. USAGE's server binds identity itself:
- **Individual:** through the provider's identity endpoint on a sanctioned path, e.g. GitHub `GET /user` with a GitHub App user token.
- **Org:** through provider-reported member emails (e.g. Anthropic per-user reports filtered by `user_ids[]`, Cursor Organization API `userEmail` on usage events), plus the member proving that email and consenting.

USAGE signs the receipt after fetching (rule 10). The provider signs nothing; every source found is TLS-only.

**Proves:**
- The provider's own records show that this provider account or seat consumed X (tokens, credits, requests, or provider-stated amounts) in a given time bucket.
- The binding to that provider identity, when USAGE's server performed it.

**Cannot prove:**
- Per-request linkage to a miner session or client surface. All sources are aggregates: daily, hourly or per-minute.
- That usage was ordinary human use rather than automated burning. Only SKUs or kinds the provider itself labels (cloud agent, third-party agents, Cursor `isHeadless`) identify automation.
- That usage figures are final. Anthropic revises for 30 days; the others don't document a window.
- That the provider account is used by only one person, or that one person does not hold several provider accounts.
- For org keys, that a row belongs to that USAGE member. The mapping is USAGE's own work.
- That usage was not also routed through USAGE. Some aggregates include BYOK events (Cursor).

**Fabrication risk.** A PC can't forge the numbers. They can be inflated in four ways:
- by really consuming, which is its own abuse vector (§5.6);
- by account sharing;
- by one person holding several plans (Sybil);
- by an org admin mapping rows to the wrong members.

**Privilege risk.** Several T2 paths need roles or scopes far broader than usage (§5.2).

### T2o: Org-attested (push or customer-controlled sink)
**Definition.** The data comes from the provider but reaches USAGE through infrastructure the customer controls, or through a push authenticated only by a secret the customer admin knows. Examples:
- Kiro OTLP export (single admin-set header)
- Kiro and Q Developer CSVs in the customer's S3 bucket
- Cursor Enterprise OTel export (admin-set header; Cursor's shared static egress IPs)

**Proves:** someone with org-admin control delivered data in the provider's format. For Cursor OTel behind an IP allowlist, the payload most likely came from Cursor.

**Cannot prove:** that an admin did not change or fabricate it. A single-admin org can forge the Kiro and S3 data, and no payload is signed.

**Data-protection note:** pushes carry the whole org, non-members included. USAGE receives that data whether or not members consent, so it must drop non-members at ingest (§5.2).

**Fabrication risk:** moderate to high for small orgs.

### T3: Device-reported
**Definition.** Metadata produced on the user's PC (local OTel, hooks, CLI JSON), allowlisted by the miner, signed with the device's Ed25519 key, and uploaded.

**Proves:** a paired, live device uploaded well-formed numbers.

**Cannot prove:** that any consumption happened. Anyone can post OTLP to a loopback receiver or change the miner.

**Fabrication risk:** total. It has zero economic weight under rule 6, and no exceptions are proposed. T3 may be shown to the user next to T2 for their own information. It **never** feeds holds, automation signals, anomaly scores, reputation or rewards, because a signal derived from T3 would teach users to fabricate T3 that matches T2.

### T3s: Self-declared plan
The user states a plan tier, or the miner reads a local plan hint such as `claude auth status` `subscriptionType` (handled as in §4.2). No usage numbers are involved. Display only.

### T0: Not measurable
There is no official data source, and every possible method is prohibited or technically closed. The UI shows "not measurable" and accepts no numbers. Rows marked "T0 pending legal review" may move to T3 counts only if legal review clears them.

### Existing tiers, unchanged
- **VERIFIED (green):** provider-verified API traffic.
- **ROUTED (blue):** USAGE-routed paid traffic.
- **REPORTED (grey):** fixtures and device data.

T1 and T1k map to ROUTED. T2 and T2o do not map cleanly onto these (decision D3).

---

## 4. Miner design (USAGE-Miner)

### 4.1 Adapter capability model

Add a descriptor next to `capabilities()` on `LocalToolAdapter` (`USAGE-Miner/src/tools/adapter.ts:147-174`):

```ts
type SubscriptionObserve = {
  mode: "otel-logs" | "otel-traces" | "hooks-count" | "cli-json" | "none";
  delivery: "launch-env" | "launch-flags" | "persistent-config";
  allowlistId: string;           // key into telemetry/mappings.ts
  preflightId: string;           // key into tools/preflight/*; required for every mode except "none"
  contentHazards: string[];      // documented content-bearing events/attrs to drop
  costFields: string[];          // device cost/billing fields, always dropped (never uploaded)
  legalGate: "clear" | "pending-review" | "blocked";
  plans: string[];               // plans for which the tool can serve subscription traffic
};
```

Server config must **not** be able to flip `legalGate` or `mode`. The adapter rules at `adapter.ts:13-39` already say nothing the server sends decides what runs. The server may only switch a mapping off. An adapter with `legalGate` other than `clear` may exist behind a developer flag for prototyping, but it is never offered in a released build.

| Tool (adapter) | Mode | Delivery | Must drop (content, identity **and cost**) | legalGate |
|---|---|---|---|---|
| Claude Code (`claude-code.ts`) | otel-logs, keep only `claude_code.api_request` | launch-env (CLI); persistent `~/.claude/settings.json` env (Desktop Code tab, IDE extension, always-on) | `user.email`, `user.account_id/uuid`, `organization.id` (or salted hash), `workspace.host_paths`, `vcs.*`, agent/skill/plugin/marketplace/MCP names, anything from `user_prompt`, `tool_result`, `api_*_body`. **Cost:** `cost_usd` and any derived `cost_usd_micros` | **pending-review** until §8.1.2 is answered. Prototype only; no release |
| Codex (`codex.ts`) | otel-logs, keep only `codex.sse_event` kind=response.completed | launch-flags `-c otel.*` (CLI); persistent config.toml `[otel]` (IDE/desktop) | `codex.user_prompt`, `codex.tool_result`, `codex.tool_decision`, `user.email`, `user.account_id`; never sum `tool_token_count`. **Cost:** the whole `codex.turn_cost` event (incl. `usage.estimated_usd`) and `codex.turn.cost_microusd` | clear (local OTel of the unmodified binary) |
| Gemini CLI (`gemini-cli.ts`) | otel-logs, keep only `gemini_cli.api_response` numerics plus model/status/auth_type | launch-env `GEMINI_TELEMETRY_*` | whole `gen_ai.client.inference.operation.details` event, `user.email`, `installation.id`, `session.id` unless hashed, `prompt_id`; traces off | clear for Code Assist Standard/Enterprise (incl. GDP Premium) only; consumer tiers discontinued |
| Copilot CLI (new adapter) | otel-traces, root `invoke_agent` span only | launch-env `COPILOT_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false` | `gen_ai.*.messages`, `system_instructions`, `tool.definitions`, `tool.call.*`, `gen_ai.tool.call.result`, `github.copilot.message`, `github.copilot.tool.*`, `github.copilot.skill.path`, `github.copilot.hook.error_message`, `enduser.pseudo.id`, `server.address`. **Cost:** `github.copilot.cost`, `github.copilot.nano_aiu` | clear |
| Mistral Vibe (new adapter) | otel-traces, chat spans only | persistent `~/.vibe/config.toml` (no per-launch override documented ⚠): `enable_otel=true`, `otel_redaction="strict"` and loopback `otel_endpoint`, written and restored **as one unit** (§4.5) | tool spans, `http.url`, conversation id unless hashed | pending-review (Commercial §2.2(i)) |
| Cursor (`cursor.ts`) | hooks-count (sessionEnd, stop, preCompact) | persistent user `~/.cursor/hooks.json` | never register content hooks; never read `transcript_path`, `CURSOR_TRANSCRIPT_PATH` or `CURSOR_USER_EMAIL`. Hook must exit 0, write nothing to stdout, and finish within a short timeout (fail-open) | **pending-review** (Cursor terms rated unclear) |
| Antigravity CLI / desktop | hooks-count (Pre/PostInvocation) | persistent | email, cwd, workspace, transcript_path, vcs | **blocked** until legal review |
| Windsurf/Devin | hooks-count | persistent | response, transcript, `UserPromptSubmit` | **pending-review** (§13.4) |
| Kiro CLI | interactive-session observation only (no extra invocations) | launch | everything except numeric totals | pending-review. Any `/usage` call before or after a session is forbidden until it is confirmed to spend no credits ⚠ |
| Claude Code, third-party-plan observe (round 2; `claude-code.ts` mode) | otel-logs, keep only `claude_code.api_request` numerics plus model | launch-env telemetry only. The user's own plan configuration (settings `env` or shell env) is left untouched; the miner never sets `ANTHROPIC_BASE_URL` or a key | As the Claude Code row, and label by the preflight's plan-host enum, never "Claude" and never as plan-covered where overflow spends paid credits (§2.7.5 flag 2). **Cost:** `cost_usd` (Anthropic prices, wrong for these models) | **pending-review** (§8.1.2 applies whatever the backend is), **plus a per-plan-host legal gate**: each enum host is released only after a legal read of that provider's terms (§8.1.14). StepFun §3 bars unofficial or unspecified tools, and the miner is not a supported tool under Z.ai §4.2 |
| Qwen Code (new adapter, round 2) | otel-logs/metrics, token, request-count and latency fields only | launch-env telemetry with prompt logging forced off (`QWEN_TELEMETRY_ENABLED`, `QWEN_TELEMETRY_LOG_PROMPTS=false`; loopback endpoint variable name unverified ⚠) | prompts, tool execution details, file operations and paths; `includeSensitiveSpanAttributes` content (full history and file contents) | clear after a live run, for the Alibaba Coding Plan host only. The Token Plan host is shown only in the console (⚠ unverified) and is excluded until publicly documented |
| Grok Build (new adapter, round 2) | otel-metrics `grok_code.token.usage`, otel-logs `grok_code.api_request` numerics | launch-env `GROK_EXTERNAL_OTEL=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, loopback endpoint; `OTEL_LOG_USER_PROMPTS=0`, `OTEL_LOG_ASSISTANT_RESPONSES=0`, `OTEL_LOG_TOOL_DETAILS=0`, `OTEL_LOG_TOOL_CONTENT=0` pinned explicitly | `user.email` (dropped in the receiver before anything leaves the PC), `user.id` unless hashed, every content event | clear after a live run (documented export to a user-chosen collector; the miner never touches credentials). May be disabled by xAI fleet policy |
| Kilo CLI (round 2) | deferred: token attributes undocumented; spans carry `opencode.*` params | — | — | deferred |
| Tabnine CLI (round 2) | deferred: Enterprise-only tier; tool-call arguments may be exported with `logPrompts` off | — | — | deferred |
| Junie CLI | **none**. Headless `JUNIE_API_KEY` is separate usage-based billing and does not measure the JetBrains AI subscription; its JSON usage schema is undocumented; AUP §1(h) bars programmatic extraction of outputs | — | — | **blocked** (removed) |
| Everything in the T0 rows | none | | | |

### 4.2 Launch modes and preflights

`RouteConfig` (`adapter.ts:97-115`) gets an explicit, mutually exclusive `mode`:

- `routed`: existing behaviour (isolated profile + `usgr_` session, or provider BYOK to the USAGE gateway).
- `subscription-observe` (new): launches the **unmodified** tool under the user's own normal login.
  - Claude Code:
    - Do not use `claude-profile.ts`.
    - Strip `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_*` from the child env.
    - Add only the telemetry env.
    - Never set `x-usage-miner-token` in this mode.
  - Codex: no `model_providers.*`, no `openai_base_url`, no `chatgpt_base_url`; add only `-c otel.*`. Never start the app-server in `chatgptAuthTokens` mode.
  - Gemini CLI: add only `GEMINI_TELEMETRY_*` with `GEMINI_TELEMETRY_LOG_PROMPTS=false`; strip `CODE_ASSIST_ENDPOINT`, `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` from the child env.
  - Copilot CLI: strip every BYOK variable (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_BEARER_TOKEN`, `COPILOT_PROVIDER_WIRE_API`) and `COPILOT_OFFLINE`, so BYOK traffic is never labelled subscription usage.
  - Never combine the two modes in one launch. `cli.ts` must refuse any mixed plan.

**Never generate traffic.** No `claude -p` loops, no `codex exec` scheduling, no Kiro `/usage` polling, no headless "mining" runs. The miner only observes sessions the user starts.

**Preflight contract (all adapters).** Settings-file `env` replaces process env, and several tools read settings from the project directory, so the child env guarantees nothing. Every `subscription-observe` adapter has a preflight module, run before each launch and at each always-on start:
1. **Read-only.** It never writes, and never opens a file on the forbidden list (§4.7).
2. **Presence flags only.** The parser works on the file in memory and returns a fixed record of booleans and enums (e.g. `{ baseUrlOverride: true, authTokenPresent: true, contentFlag: "OTEL_LOG_USER_PROMPTS" }`). No value (token, URL, header, path, email, org id) leaves the parser. Values never reach logs, telemetry, the UI, crash reports or error messages. Parse errors report the file *name* and "unparsable", never a snippet.
3. **Outcomes:** *refuse* (explain the flag name and what to change), *warn* (launch, show the reason), or *strip* (child env only).
4. **Tests:** each preflight is tested with fixtures holding fake secret values (e.g. `sk-ant-oat01-TESTSECRET`, `ghu_TESTSECRET`), and a logger, crash-reporter and UI-output spy asserts the value never appears.

| Adapter | Refuse launch when (flag resolves on, from env, any settings layer or managed policy) | Warn | Strip (child env) |
|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper` set in any settings file; **content flags** `OTEL_LOG_RAW_API_BODIES`, `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_TOOL_DETAILS` | managed OTLP lock or launcher-pinned endpoint (nothing will be measured; do not override) | `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*` |
| Codex | `openai_base_url`, `chatgpt_base_url` or custom `model_providers` (incl. `requires_openai_auth`) in user or managed config; `otel.log_user_prompt=true`; managed requirements that pin another OTel exporter | managed login/workspace constraints | — (config layers, not env) |
| Gemini CLI | `CODE_ASSIST_ENDPOINT` in env, settings or a `.env` file the CLI loads ⚠; API-key, Vertex or gateway auth selected (`GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`), which is not subscription usage; `telemetry.logPrompts=true` in any settings file, **until** it is verified in source or a live test that `GEMINI_TELEMETRY_LOG_PROMPTS=false` overrides settings ⚠ | consumer Google login detected (service discontinued; nothing to measure) | `CODE_ASSIST_ENDPOINT`, `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY` |
| Copilot CLI | `COPILOT_API_URL` or `GITHUB_COPILOT_API_TOKEN` present; managed or MDM settings that force content capture (`captureContent` / `lockCaptureContent`) | enterprise-managed OTel exporter present | BYOK vars and `COPILOT_OFFLINE` (above) |
| Mistral Vibe | active provider `api_base` is not the first-party Mistral host; `otel_redaction` not `strict`; `enable_otel=true` without a loopback `otel_endpoint` (traces would go to Mistral with the user's key) | — | — |
| Cursor hooks | an existing user hook for the same event (never merge) | Team/Enterprise-distributed hooks present | — |
| Claude Code, third-party-plan observe (round 2) | the configured base-URL host is not an **exact** documented plan host (enum: `z.ai`, `kimi`, `minimax`, `alibaba-coding`, `volcengine-ark`, `tencent-lkeap`, `baidu-qianfan`, `stepfun`, `ollama`, `opencode-go`; the Alibaba Token Plan host is excluded until publicly documented ⚠), or is a USAGE host, or its per-plan-host legal gate is not clear (§8.1.14); **a claude.ai login is also present** (the OAuth token could reach the third-party host; `claude auth status` enum only); the Claude Code content flags. The host is compared inside the parser. Settings `env` may be parsed in memory, but the key value never leaves the parser; process env is checked for presence only (env-guard) | Kimi: env var names conflict between Kimi pages ⚡ | — (the user's configuration is not stripped in this mode) |
| Qwen Code (round 2) | `logPrompts=true` or `includeSensitiveSpanAttributes=true` in any settings file, until env precedence is verified ⚠; base URL not the Alibaba Coding Plan host (pay-as-you-go keys are not subscription usage; the Token Plan host is console-only ⚠ and excluded until documented) | — | — |
| Grok Build (round 2) | `GROK_MODELS_BASE_URL`, `GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_XAI_API_BASE_URL` or any custom model `base_url` present in env or config (session-token leak); `model.api_key` or `model.env_key` present in config (presence only; they outrank the session token and bill pay-per-token, so the traffic would not be subscription usage); any `otel_log_*` content key on in config; a signed `requirements.toml` that pins any content gate on (`otel_log_user_prompts`, `otel_log_assistant_responses`, `otel_log_tool_details`, `otel_log_tool_content`; exact key names ⚠ unverified). `requirements.toml` is read presence-only: the parser returns which content gates are pinned on, nothing else. A pin overrides env, so pinning the env gates to 0 does not help | a signed `requirements.toml` pins non-content OTel keys, e.g. the exporter off (nothing will be measured) | `XAI_API_KEY` and `GROK_CODE_XAI_API_KEY` from the child env (not subscription usage) |

**Content flags refuse, they do not warn.** With these flags on, full prompts, responses and code would reach the miner process. The receiver allowlist (§4.3) is the second line, not the reason to proceed. Always-on and persistent modes cannot preflight each later session, which may start in a project whose settings turn a flag on. So the receiver also **trips**: when it sees a content-bearing event or attribute (a non-redacted `prompt`, any `api_*_body` event, `gen_ai.input.messages`, tool content), it drops the batch contents, stops accepting from that session, and tells the user which tool and which flag to turn off.

**Plan label (T3s).** Run `claude auth status` with output captured in memory. The parser returns only the `subscriptionType` enum; `email`, `orgId` and `orgName` are discarded inside the parser and never stored, logged or shown. Field names are undocumented ⚠, so an unexpected shape yields "unknown", never a raw dump.

### 4.3 Receiver changes

`USAGE-Miner/src/telemetry/receiver.ts` (127.0.0.1, per-session bearer) and `otlp.ts` today parse only `/v1/logs`.
- Add `/v1/traces` for Copilot and Vibe.
- The loopback receiver accepts OTLP/HTTP JSON only. Before relying on each tool, check which encoding it actually emits ⚠: Codex `otlp-http`, Copilot `http/json` supported, Vibe OTLP/HTTP encoding unverified. (Server-side push receivers for org exports need protobuf; see §5.2.)
- **Allowlist first, denylist second.** Keep only named events/spans and named attributes per `mappings.ts` entry. Drop every attribute not listed, even if unknown.
- Keep a second-line denylist of content prefixes (`prompt`, `gen_ai.input`, `gen_ai.output`, `gen_ai.system_instructions`, `tool.`, `body`, `response`, `transcript`). It only **drops attributes** and trips the session (§4.2); it never rejects a whole normal batch. Claude's `user_prompt` event defines a redacted-by-default `prompt` attribute, and batch rejection would discard normal traffic.
- **Cost fields are always dropped**: `cost_usd`, `cost_usd_micros`, `codex.turn_cost` and its `usage.estimated_usd`, `codex.turn.cost_microusd`, `github.copilot.cost`, `github.copilot.nano_aiu`. They are backend estimates or billing units, and device `funding`, `cost` and `paid` are forbidden fields (§5.1).
- **Bodies never persist.** The receiver never logs, writes to disk, or includes in an error, crash report or debug dump any request body or fragment of one. This holds on every path: parse failure, oversized payload, wrong content type, bad bearer, unknown route, exporter retry. Errors carry a fixed code only.
- Hash conversation or session ids with a per-device salt before upload.
- Dedupe on provider request id (`request_id`, `gen_ai.response.id`) and on Copilot root-span id.
- Session-cumulative sources (Antigravity headless) must be converted to deltas.
- **Tests:** feed a prompt-bearing batch (and a secret-bearing header) through each error path (malformed JSON, truncated body, oversized body, bad bearer, unknown route, handler exception) and assert nothing from it reaches logs, the state directory, crash output or the upload queue.

### 4.4 Consent UX

A separate opt-in per tool and per mode. It is never on by default and never switched on by server config. The consent screen states in plain words:
1. **What is read**: the exact field list (e.g. "model name, input/output/cache token counts, request id, timestamp").
2. **What is never read**: prompts, responses, code, file paths, tool arguments, cost estimates, your login token or credentials file.
3. **What it earns**: "Nothing. This is shown on your profile as device-reported and has no economic weight." (Rules 1 and 6: no implied monetary value.)
4. **Provider relationship**: "USAGE is not affiliated with or endorsed by <provider>. Your requests go directly to <provider>, not through USAGE." (Cursor's AUP bars implying origin from Anysphere; the same caution applies to every provider.)
5. **Persistent changes**, if any: file path, the USAGE-owned key names and the values USAGE writes (any secret-shaped value masked), and how to undo. The screen never renders any other line of the user's file. A warning that exports fail silently when the miner is not running, and that the setting applies to every session of that tool.
6. **Preflight result**: the flag names that caused a refusal or warning, never their values.
7. A one-click **Stop measuring** that runs the restore in 4.5.

### 4.5 Writing and restoring settings

- **Prefer per-launch delivery** (child env, `-c` flags). Nothing touches disk.
- **Persistent writes** only when per-launch delivery is impossible (Claude Desktop Code tab / IDE extension / always-on, Codex IDE/desktop, Vibe, Cursor hooks), and only if D11 allows them:
  1. Read the file in memory. If it is unparsable, stop.
  2. Refuse if a conflicting user value already exists (another OTLP endpoint, an existing hooks entry for the same event, content flags, a non-first-party `api_base`). **Never overwrite a user value. There is no force option.**
  3. **No byte backups.** The miner never copies the original file, in whole or in part, anywhere. These files can hold credentials: Claude `settings.json` `env` may contain `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`; Codex `config.toml` can carry provider tokens and headers; Cursor `hooks.json` commands can embed secrets.
  4. Write atomically (temp file in the same directory + rename), adding only USAGE-owned keys.
  5. Record a **manifest of USAGE-owned keys only**: `file`, and per key its path, its prior state (`absent`, or `present-identical` when the user had already set exactly the value USAGE needs, in which case USAGE does not own it and never removes it), and a hash of the value USAGE wrote. The manifest holds no other content of the file. It is encrypted with Windows DPAPI (current-user scope), the same way the miner token is stored.
  6. **Restore**: re-read the file; for each owned key whose current value hash equals the recorded hash, remove it; leave changed keys alone and tell the user which key names changed. Show only key names and USAGE-written values, masked where secret-shaped.
  7. **Units.** Keys that are unsafe apart are written and restored together. Vibe `enable_otel`, `otel_endpoint` and `otel_redaction` form one unit: if any member is missing or changed, remove the USAGE-owned `enable_otel` first (telemetry off), never leave `enable_otel=true` without the loopback endpoint, and warn the user.
  8. Run restore on opt-out, on uninstall, and on miner start if the manifest's tool is no longer opted in.
- **Existing `USAGE-Miner/src/telemetry/always-on.ts` must be brought under these rules before it is extended:**
  - Remove its `force` path, which overrides conflicting user values.
  - It writes a plaintext `receiverKey` into `~/.claude/settings.json`: the same class of problem `claude-code.ts:34-40` rejects for the miner token. Until a better loopback authentication exists, a persistently written key must be receive-only (it can do nothing except post to the loopback receiver), never the miner token or a `usgm_` credential, rotated on each opt-in, and masked in every diff and log. Whether a loopback receiver can drop the key entirely is an open question (§8.2).
  - Move its restore to the manifest model above.
- **Tests (required):**
  - A settings file with a secret-bearing `env` block (`ANTHROPIC_AUTH_TOKEN="sk-ant-oat01-TESTSECRET"`), a Codex `config.toml` with a token header, and a Cursor `hooks.json` command embedding a secret: after opt-in, restore and a failed write, the secret never appears in the state directory (manifest decrypted included), logs, UI output or crash reports.
  - Restore on an untouched file removes exactly the owned keys; on an edited file removes only unchanged owned keys; a conflicting value refuses; `present-identical` keys survive restore.
  - Vibe unit: a file with `enable_otel=true` and no `otel_endpoint` is refused at preflight and repaired to telemetry-off on restore.
  - No code path accepts a force or overwrite flag.

### 4.6 Privacy summary (metadata only)
The upload contains: tool, adapter version, mode, model id, token counts by type, provider request id, salted session hash, timestamp, duration, T3s plan label. It never contains prompts, completions, code, paths, repository/branch/commit identifiers, tool names or arguments, emails, provider account ids, credentials, or any cost, price, credit or billing-unit value. This matches rule 3 and the existing forbidden keys in `src/lib/miner/telemetry.ts:60-71`.

### 4.7 Must never happen

Three guard rules, each with its own test:
- **Dedicated credential and content files** (e.g. `.credentials.json`, `auth.json`, transcripts, session files) are never opened. Test: a mocked `fs` that fails if the path is opened or stat-read for content.
- **Process environment variables** holding credentials are never read for their value. Presence checks go through a helper that returns a boolean without exposing the value. Test: a mocked env accessor that fails if the value is read.
- **Config files that may contain a credential** (Claude Code settings, including its `env` block; Codex `config.toml`; Grok config and `requirements.toml`; Factory `~/.factory/settings.json`) are not on the never-open list. A preflight may parse them in memory (§4.2), and only presence flags, enums and host names compared against the enum may leave the parser. The credential values listed below must never leave it. Test: fixtures with fake secret values, and spies on the parser's return value, logs, UI output, crash reports and the state directory that assert no value appears.

1. **Reading, copying, uploading or logging any credential** (value or file):
   - Claude: `~/.claude/.credentials.json`; values of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`; running or reading the output of an `apiKeyHelper`.
   - OpenAI: `~/.codex/auth.json` or its keyring entry; Codex app-server `chatgptAuthTokens` mode, in which the host handles the user's ChatGPT tokens.
   - Google: `~/.gemini/oauth_creds.json`; Antigravity keyring tokens.
   - Cursor: session tokens; `~/.cursor/sdk/auth.json` (a 90-day full-power user key).
   - Windsurf/Devin: `credentials.toml`.
   - Mistral: `~/.vibe/.env` (the plan-derived Mistral API key).
   - GitHub: values of `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_COPILOT_API_TOKEN`; Windows Credential Manager entries.
   - Kiro/JetBrains: values of `KIRO_API_KEY`, `JUNIE_API_KEY`.
   - Round 2:
     - Ollama `~/.ollama/id_ed25519`, the device sign-in private key.
     - Grok `~/.grok/auth.json`.
     - Augment session JSON: the `AUGMENT_SESSION_AUTH` value and `auggie token print` output.
     - kimi-cli OAuth tokens.
     - Values of `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `FACTORY_API_KEY`, `TABNINE_KEY`, Warp `wk-` keys.
     - Grok config `model.api_key` values, and the value of the variable `model.env_key` names.
     - Factory `~/.factory/settings.json` `customModels` `apiKey` values.
     - Any plan key held in Claude Code settings `env` or a tool config (Z.ai, Kimi, MiniMax, Alibaba `sk-sp-`, Volcengine, Tencent, Baidu, StepFun, Ollama, OpenCode, Cline, Kilo). The file may be parsed in memory by a preflight; the value never leaves the parser.
   - Any OS keychain entry; browser cookies.
2. **Reading any content store**, even to count:
   - Claude Code session transcripts (under `~/.claude/projects/`) and any `transcript_path` passed to a hook or status line.
   - Codex rollout files `~/.codex/sessions/**/*.jsonl` (they hold `token_count` lines but also full conversations).
   - Vibe session logs `~/.vibe/logs/session` (they hold message content).
   - Cursor `transcript_path`, and the hook env vars `CURSOR_TRANSCRIPT_PATH` and `CURSOR_USER_EMAIL`.
   - Windsurf transcripts (`post_cascade_response_with_transcript`); Devin CLI `UserPromptSubmit` payloads.
   - Antigravity statusLine `transcript_path`, email and cwd.
   - Copilot VS Code debug-panel content capture; Copilot cloud agent `COPILOT_AGENT_PROMPT`.
   - Google Takeout exports.
   - Round 2: kimi-cli session files; ZCode local session records; Augment Auggie session snapshots; any Qwen Code telemetry outfile.
3. **Pointing any subscription-authenticated client at a USAGE or third-party host**: `ANTHROPIC_BASE_URL` with a claude.ai login, `openai_base_url`/`chatgpt_base_url` with ChatGPT auth, `CODE_ASSIST_ENDPOINT`, `COPILOT_API_URL`, Cursor `backendUrl`, Vibe `api_base` with a plan key. Round 2: any Grok Build endpoint override while a `grok login` session exists; any plan base URL or plan key aimed at a USAGE host for a provider that has not given written permission (T1k); writing or editing a plan base URL at all. On the server side: forwarding any caller `Authorization` upstream (§5.7).
4. TLS interception, custom CA injection (`NODE_EXTRA_CA_CERTS`), or decoding a private protocol.
5. Scraping dashboards (claude.ai Settings > Usage, chatgpt.com, cursor.com dashboard endpoints including `export-usage-events-csv`, gemini.google.com). Round 2: the Ollama per-request cost page, Grok Settings > Usage, Z.ai/Alibaba/Volcengine/Tencent/Baidu consoles, replit.com/usage, dashboard.zed.dev, app.augmentcode.com. Also calling undocumented quota endpoints (Z.ai `/api/monitor/usage/*`, Kimi `/usages`, Ollama `/api/usage`).
6. Generating or scheduling model traffic to accumulate usage, including extra non-interactive invocations to read usage (round 2: `droid exec`, `auggie --print`, Amp execute mode, Kimi `/usage`).
7. Enabling any content-capturing flag, even briefly, or requesting provider-side content logs: Cloud Logging request/response logs, Gemini Enterprise `gemini_enterprise_user_activity` audit logs (they carry full prompts and responses), Cowork OTel, the ChatGPT Compliance API, Enterprise Compliance APIs, or Perplexity Audit Logs.
8. Presenting T3 data as verified, or showing a monetary figure next to it.
9. Removing or restricting a tool's built-in sign-in method in a way the provider would treat as modification. The current isolated profile deletes `.credentials.json` if someone logs in inside it (`claude-profile.ts:147,158`); that needs legal review (§8.1.2).

---

## 5. Server design (USAGE)

### 5.1 T3 ingestion changes (Phase 0)
- `src/lib/miner/telemetry-ingest.ts:33`: add mappings for `subscription-observe` per tool. Enabled mappings are server-controlled, but only as an *off* switch (see §4.1).
- **`funding`, `cost` and `paid` stay forbidden device fields** (`src/lib/miner/telemetry.ts:66-69`). Add the device cost fields to the same forbidden set: `cost_usd`, `cost_usd_micros`, `codex.turn_cost`, `estimated_usd`, `cost_microusd`, `github.copilot.cost`, `nano_aiu`. An upload carrying any of them is rejected (the miner should never send them, so their presence means a modified or broken miner). The "subscription" label for T3 is a display-only `session_mode` / `declared_plan` value, never written to economic columns.
- The ingest route never logs request bodies, including on validation or parse failure. Errors carry a fixed code and the offending *key name* at most.
- Correlation (`telemetry.ts:269`) only matches confirmed routed events. Subscription-observe rows will be uncorrelated `local_usage_observations`. Check the dashboard shows uncorrelated local rows as grey REPORTED, with reads running as the signed-in user (rule 12). If a display column is needed, it is a migration **file** now and production DDL only with explicit agreement (rule 13).
- Keep the zero-weight guarantees as they are:
  - `local_usage_observations` has no economic columns (`0017`).
  - `verifyEconomically` returns `not_verified/local_only` for device evidence.
  - `decideReward` returns `no_economic_weight` for reported usage.
  - `VERIFICATION_WEIGHTS_V1.reported = 0`.
- T3 rows never feed holds, anomaly scores, automation signals, reputation or leaderboards (§3).

### 5.2 T2 and T2o connectors

**Layout.** Wire formats only in `src/lib/providers/<provider>-usage/` (e.g. `github-copilot-billing/`, `cursor-org-usage/`, `anthropic-enterprise-analytics/`, `google-code-assist-monitoring/`). Everything downstream consumes `NormalizedUsageRecord`. Records need an explicit `granularity` / bucket (day, hour, minute), because none of these sources is per-request. Each connector adds its row to the capability table in `docs/ARCHITECTURE.md` (hard rule 2) in the same change.

**Privilege and blast radius.** Every grant is least-privilege where the provider allows it, and the owner accepts the residual blast radius per connector before it ships.

| Source | Role / scope / key | What it can read beyond usage (blast radius) | Required mitigation / gate |
|---|---|---|---|
| GitHub Copilot individual AI-credit usage | GitHub App user token, Plan: read | The account's plan and billing data | GitHub App (not OAuth App: that needs the broad classic `user` scope); no fine-grained PAT reliance (⚡) |
| Copilot Business/Enterprise | Administration: read; Copilot metrics read (App installation) | Org administration data, all members' metrics | Org opt-in; member consent filter |
| Claude Enterprise Analytics | `read:analytics` key | Every seat user's usage, email and name, including removed users; skills/connectors/apps/plugins/artifacts endpoints | Request only per-user endpoints with `user_ids[]` for consenting members; Anthropic written confirmation |
| ChatGPT Enterprise/Edu Admin key | Admin key; defaults to All permissions, Never expiry | Everything the key's permissions allow in the workspace | Owner narrows permissions to Costs read or Codex analytics read and sets an expiry; legal review of §3.3(g) |
| Google Code Assist / GDP Premium metrics | `roles/monitoring.viewer` on the licensed project | **Every** metric in the project, not only `cloudaicompanion` | Dedicated project for the licence where possible; query only `cloudaicompanion` types; owner acceptance |
| Google Code Assist metadata logs | `roles/logging.viewer` | Request/response logs with **prompts** if `log_prompts_and_responses` is on | Before any log read: proof that `log_prompts_and_responses` is off, or a log view restricted to the `/metadata` log name (feasibility unverified ⚠) |
| Antigravity on Gemini Enterprise | Documented dashboard role `roles/discoveryengine.agentspaceAdmin` (**admin**) | Administrative access to the Gemini Enterprise app | Not accepted. Verify a non-admin Monitoring read path first ⚠ |
| Google Workspace Gemini activity | OAuth `admin.reports.audit.readonly` | **Every** Workspace audit log (Drive, login and more) | Google OAuth app verification / security assessment (restricted scope, likely required ⚠); owner acceptance; filter to `gemini_in_workspace_apps` at fetch |
| Cursor Enterprise pull | Organization API key, `usage:*` scope | Pooled usage, usage events, daily usage, spend for the whole org | Consenting-member filter; live test that the key is limited to usage routes |
| Cursor Teams pull | Team key `read:*` (untested on usage routes ⚠) or `admin:*` | `admin:*` can write | Only `read:*`; if it fails on usage routes, not built |
| Windsurf/Devin, JetBrains, Mistral, Perplexity Enterprise | Admin/service/analytics keys | Org-wide analytics | Per-connector review in Phase 3 |
| Kiro Enterprise OTLP, Cursor Enterprise OTel export (push) | USAGE-issued ingest token set by the admin | The whole org's usage pushed to USAGE, non-members included | Push rules below |
| Amp External API (round 2) | M2M app with `workspace.threads.meta:view` only. `analytics.daily-usage:view` is requested only after a field check shows its rows can be filtered to the bound user | Metadata of every thread in the workspace, including other members' threads and creator ids | Never request `threads.contents:view` or `model-provider-keys:*`; filter to the binding user's `creatorUserID` in memory; ChatGPT-linked threads excluded (§2.7.3); Amp's written position first |
| Tabnine usage API (round 2) | PAT scoped to Usage metrics read | A seat holder's own usage; team or org usage if created by an admin | Per-user PAT preferred; live field check; org MSA allows third-party sharing |
| Warp Enterprise Analytics (round 2) | Team admin's Personal `wk-` key | **Not read-only**: can start agent runs and spend credits. Events carry email, branch names and commit hashes | Not accepted until a read-only key exists; drop email and `git_context` at ingest |
| Augment Enterprise Analytics (round 2) | Service-account token | Org usage, and **write** access to budget overrides | Not accepted until a read-only token exists or Augment confirms scoping |
| Microsoft 365 Copilot usage reports (round 2) | Graph `Reports.Read.All` (application) | Usage reports for every user in the tenant; the permission is broader than Copilot reports ⚠ | Delegated permission where possible. The report returns the whole tenant, so the push-source rules below apply: non-members dropped in memory before any write, queue or log; no raw payload logging; bounded retention (nothing about non-members retained). USAGE never asks the admin to disable name concealment; if names stay concealed, rows are not mapped. Lowest priority |

**Credential handling (decision D4).** Options, in order of credential exposure:
1. *No USAGE-held secret*: Google IAM role granted to a USAGE service account; AWS cross-account role with ExternalId; push with a USAGE-issued ingest token (Kiro OTLP, Cursor OTel export).
2. *One-shot user-initiated sync*: the token is used inside one server request and discarded. Never persisted, never logged. Where the provider lets the app revoke its own token (GitHub Apps can revoke a user token through GitHub's REST API; verify the endpoint in current docs before building ⚠), **USAGE revokes it server-side** at the end of the sync instead of asking the user to. Otherwise the user is told to revoke it.
3. *Encrypted, revocable, least-privilege stored credential* (GitHub App refresh token, Cursor `usage:*` org key, Anthropic `read:analytics` key). Needs an explicit owner exception to "never store a user's credentials".

**Phase 1 is honest about this.** A daily-reconciliation pilot with one-shot tokens would need a manual reconnect every day, so in practice it depends on option 3. Phase 1 is therefore specified for option 2 as a *user-triggered sync with backfill*: each sync fetches every day not yet stored, up to the API's 24-month window, one call per day. If the owner wants automatic daily sync, that is D4(c) and must be named as a Phase 1 prerequisite.

**Logging.** Credential values must never enter `src/lib/gateway/observability.ts`-style allowlists, error messages, receipts or DB rows. Tests assert this (§7).

**Identity binding.**
- Individual (Copilot): the server calls `GET /user` with the user's token and stores the provider login id. A **uniqueness constraint** ensures one provider account binds to one USAGE account.
- Org, pull sources: the admin connects the org. Each member proves control of the email the provider reports and consents. Where the provider supports it, the request itself is filtered to consenting members (Anthropic `user_ids[]`). Otherwise rows for non-consenting members are dropped in memory before any write or log.
- Org, **push sources** (Kiro OTLP, Cursor OTel export) cannot be filtered at fetch: the provider pushes the whole org, with `kiro.user.email` or `cursor.user.id`. USAGE receives non-members' data whatever it does. Rules:
  - **Drop at ingest**: non-member datapoints are discarded in memory before any write, queue or log.
  - **No raw payload logging** anywhere: platform request logs, function logs, error logs, and dead-letter queues. A failed batch is dropped with a counter, not parked.
  - **Family allowlist**: accept only named metric/log families. Cursor enables new families by default (`auto_enable_new_families`), so unknown families are rejected, not stored.
  - **Bounded retention**: nothing about non-members is retained; member data follows the normal retention policy.
  - **DPA text**: the org agreement states that USAGE processes non-member data transiently, only to discard it.
  - **Protobuf receiver**: Cursor pushes OTLP/HTTP protobuf and Kiro pushes gRPC or HTTP/protobuf. The server receiver supports OTLP/HTTP protobuf and is tested with real captured payloads. gRPC is not planned; a Kiro org must select HTTP/protobuf (confirm the option exists ⚠).
  - **Tests**: a push containing non-member and unknown-family data stores only allowlisted member rows; a malformed push leaves nothing in logs or queues.

**Automation and reconciliation.**
- **Automated SKUs and kinds carry no economic weight**, whatever D2 decides: Copilot `coding_agent_ai_credit`, third-party coding agents, sandbox SKUs; Cursor events with `isHeadless`, `cloudAgentId` or `automationId`; Cursor SDK/Cloud Agents usage; Jules; Codex cloud tasks. They may be displayed.
- **Aggregate minus routed.** Some aggregates include traffic USAGE also routes (Cursor Teams/Enterprise usage events include BYOK events). Each connector specifies how routed usage is subtracted. Where it can't be identified reliably (whether a Cursor event's `kind` identifies BYOK is unverified ⚠), a provider account that also has ROUTED traffic earns nothing from T2.

**Dedupe key:** `(provider, provider_account_or_seat, bucket_start, bucket_width, product/sku, model)`.

**Restatement:** upsert with a `source_revision`. Records stay `pending` until the provider's revision window has passed (Anthropic: 30 days; Copilot and Cursor: unknown, so the owner picks a conservative hold, decision D9).

**Money:**
- Copilot amounts are JSON numbers. Parse from the **raw numeric text** into integer micros, never through `JSON.parse` floats (rule 4).
- Anthropic amounts are fractional-cent decimal strings with up to 6 decimals, finer than a micro. This needs a **versioned rounding rule** (e.g. `money-rounding-v1: half-even to micro`).
- Cursor `chargedCents` and `totalCents` precision, and whether they are still populated after 2026-07-31, must be checked on live data ⚠.

**Cost basis:** keep it explicit and separate from proof status.
- Copilot: `grossAmount` is the provider-stated list value; `discountAmount` is included-allowance coverage; `netAmount` is paid overage.
- Cursor: `chargedCents` is 0 for plan-included, BYOK and credit-grant usage, so 0 does not mean "subscription".
- Credits, ACUs and query counts are not USD. Store them in their own unit with `cost_basis = unknown` and economic status `pending_cost`.

**Ingestion role:** the service role is used for ingestion only. Dashboards read as the user (rule 12).

### 5.3 T1 passthrough gateway (dormant spec; implement only per provider after written authorization)
If a provider ever authorizes a hosted relay in writing, the route must:
1. Be a new `ComputeGateway` per provider with a **fixed upstream URL chosen by the server**. The client never supplies one. Reuse of `protocols/anthropic-compatible.ts` is not possible as-is: it strips `authorization` (lines 32-34, 220-226).
2. Carry the miner credential only in `x-usage-miner-token` (`src/lib/miner/token.ts:69`) and treat `Authorization` as opaque. It must be:
   - never parsed and never hashed into storage;
   - never logged;
   - never copied into observations, receipts or errors;
   - never retried to a different host;
   - dropped from memory when the request ends.
   The `readSubscriptionAuthorization` / `buildUpstreamHeaders` code (`src/lib/gateway/anthropic.ts:66-106`) that Phase 0a disables is a reference for header handling only. Its forwarding behaviour is not reinstated for any provider without that provider's authorization.
3. Sanitize upstream error bodies. This is done for all gateway routes in Phase 0a, not deferred to T1.
4. Add a new `WireSurface` (`src/lib/providers/surfaces.ts`). Route-session binding (`route-session.ts`) is keyed to a connection id and needs a "subscription surface" binding with no connection row. `ResolvedGateway.credential` (`handler.ts:46`) must become optional or carry an explicit `callerSubscription` marker.
5. Have the **server** assign funding from the route: `observation.funding = { class: "subscription", basis: "route_declared" }`. The existing `classifyEconomicSource` already maps that (`economic-unit.ts:455`). Document that USAGE cannot verify the credential is a plan token.
6. Set `verification_type = routed`, never `verified` (rule 11). Keep a distinct `cost_basis` (5.4). Economic status stays `pending` until policy (§6).
7. Match the provider string used by telemetry correlation. Vercel records use `vercel-ai-gateway` (`observation.ts:15`), while Claude OTel carries Anthropic request ids; `telemetry-ingest.ts:95` requires equal provider strings.
8. Update the capability table in `docs/ARCHITECTURE.md`.

**T1k variant (round 2; dormant, per provider after written permission and D13).** A T1k route reuses the existing encrypted provider connection and ROUTED pipeline, not the opaque-`Authorization` design above. Differences:
- **Fixed upstream.** The upstream is the plan's documented endpoint, fixed per provider on the server (e.g. `https://ollama.com`). The connection stores which plan the key belongs to. A key is never sent to any other host, so a plan key cannot silently spend pay-as-you-go balance through a different endpoint.
- **Provider wire needs:**
  - Ollama requires `Authorization: Bearer`.
  - Kimi requires the client User-Agent untouched.
  - OpenCode Go needs `x-opencode-session` passed through.
  - Cline and Kilo are OpenAI-format only, so the route serves only tools that speak that format.
- **Kilo third-party plans.** A Kilo route refuses models and accounts that Kilo serves on third-party plans (ChatGPT, SuperGrok, Z.ai, Kimi, MiMo). Relaying Z.ai plan traffic or SuperGrok OAuth traffic is prohibited by those providers. If this cannot be enforced from the gateway's documented interface (⚠ unverified), no Kilo route is built.
- **Plan limits.** Per-key concurrency stays within plan limits: Ollama 3 (Pro) or 10 (Max/Team); MiniMax roughly 3-7 agents at peak; Kimi at most 30 connections. USAGE never retries into a limit.
- **Errors.** Provider 402, 1113 and quota errors are surfaced to the user unchanged in meaning, with a fixed message and no echoed body.
- **Cost.** `cost_basis` is unknown or `subscription_flat`, and economic status is `pending_cost`. The only exception is a provider-stated per-request cost (Cline API `usage.cost`, parsed with `usdStringToMicros`).
- **No new credential class.** Provider module: `src/lib/providers/<provider>/`. Capability table row in `docs/ARCHITECTURE.md`.

### 5.4 Pricing when no cost is returned
- Flat-rate traffic has no per-request cost. Under the conventions, provider cost is **authoritative or unknown** and is never estimated. So `cost_basis` is `unknown` or a new explicit value such as `subscription_flat`. The `CostBasis` union at `src/lib/domain/receipt.ts:52` is part of the receipt, so a new receipt version is required.
- Device-side cost estimates (Claude `cost_usd`, Codex `turn_cost`, Copilot `nano_aiu`) are never a cost basis. They are dropped (§4.3, §5.1).
- A **protocol value** may still be computed from versioned protocol prices (`src/lib/pricing/compute.ts:106`, version from `pricingForEpoch`). That value is explicitly "NOT a cost" (`compute.ts:12-15`) and must be displayed as such. Whether it can drive rewards for flat-rate usage is decision D5.
- Direct provider model ids (e.g. bare Anthropic ids) do not match priced slugs like `anthropic/claude-sonnet-4.6` (`usage-pricing-v3.ts:49-67`). Add an alias map in a **new pricing version** (e.g. `usage-pricing-v4`); never edit v3 (rule 5).
- Credit-denominated T2 sources (Copilot AI Credits, Cursor cents, Windsurf credits/ACUs, JetBrains credits, Kiro credits, Perplexity credits) keep their native unit. Converting credits to USD only uses a provider-stated rate (Copilot `pricePerUnit`; JetBrains "1 credit = USD 1" for list price only, since org pricing may differ) and is labelled with that basis.
- Round 2 units are not USD and have no stated conversion: Z.ai plan credits, Kimi credits, StepFun credits, Warp `credit_charged`, Augment credit usage (units undocumented). The same goes for Ollama and Kilo account credits: they are USD-denominated, but no per-request charge is returned. xAI `cost_in_usd_ticks` (pay-per-token API only, not SuperGrok) converts exactly: 1 micro-USD = 10,000 ticks, with sub-micro remainders kept as ticks or rounded by a versioned rule.

### 5.5 Labels and versions

| Concept | Today | Proposed (all behind owner decisions) |
|---|---|---|
| `VerificationType` (`src/lib/domain/types.ts:12`) | `verified \| routed \| reported` | add `provider_attested`; optionally `org_attested` (D3). T1 and T1k stay `routed` |
| Colour | green / blue / grey | a new colour per new type (convention: colour encodes verification only) |
| Source/funding class | `subscription` exists (DB check `0011:55-57`) | used for T1 (route-declared) and T2 (provider-stated plan) |
| Reward reason | `subscription_pending_policy` | keep until D2; add e.g. `subscription_attested_capped` if D2 allows earning; add `automated_sku_no_weight` |
| Economic verification | `economic-unit.ts` v1, subscription → `held` (593-594) | `economic-verification-v2` with a subscription branch, only if D2 |
| Reward policy | `usage-reward-policy-v1`, subscription `held` (`reward-policy.ts:104`) | `usage-reward-policy-v2` plus a `reward_policy_versions` row (FK `0011:52`, frozen trigger `0018:378`); **production DDL, rule 13** |
| Cost basis | incl. `unavailable` | add `subscription_flat`, `provider_list_gross`, `provider_credit_units` (receipt version bump) |
| Scoring | `VERIFICATION_WEIGHTS_V1` | `VERIFICATION_WEIGHTS_V2` with `provider_attested = 0` in scores **and** leaderboards while display-only; any non-zero weight only if D2/D3 require it |
| Catalog copy | `src/lib/providers/catalog.ts:180-182` "Forwarding a Claude subscription needs paid AI Gateway credits upstream." | rewritten in Phase 0a: USAGE does not forward Claude subscription credentials |

### 5.6 Anti-abuse (flat-rate means spending more is free up to the plan limit)
Subscriptions make marginal usage free until the cap, so any reward creates an incentive to burn limits with automation. Several provider terms treat that as abuse: GitHub AUP §4 (reward-incentivized activity, excessive automated bulk activity); Anthropic ("ordinary, individual use"); OpenAI and Google (circumventing limits/quotas); Cursor AUP (interfering with usage metering; exploiting team workflows to avoid fees).

**Always, even while display-only:**
- Automated SKUs and kinds never earn (§5.2).
- T3 never feeds any signal (§3).
- Display of provider-attested usage stays private to the user until the relevant provider or legal review answers whether a public profile or leaderboard entry counts as a reward (GitHub AUP §4).

**If D2 ever allows earning, these are Phase 2 gates, not options:**
1. **Person-level Sybil control.** One person can buy N cheap plans and bind each to its own USAGE account; the provider-account uniqueness constraint does not stop that. Economic weight requires a USAGE-account-level identity bound across providers, so one person maps to one earning account (mechanism: D12).
2. **Reward bounded well below plan price.** Expected reward per plan per epoch must stay well below the plan's price, so buying plans to farm points never pays off, even allowing for later changes in how points are perceived.
3. **Non-increasing marginal reward.** The curve is concave and its marginal reward falls to zero **before** the plan's nominal allowance. A cap at the allowance still rewards burning up to it. Versioned in the reward policy.
4. **Separate sub-pool.** Subscription-attested usage draws from a fixed share of the epoch pool (rule 7), capped so it can never dilute paid routed compute.
5. **Binding rules.** One provider account binds to one USAGE account (DB uniqueness). Rebinding has a cooldown and voids pending rewards.
6. **Automation signals from provider data only.** Holds, not bans, based on T2 fields the provider itself supplies: labelled automated SKUs or kinds, 24/7 activity in provider buckets, perfectly regular provider-bucket cadence. **No signal derived from T3** (it would teach users to fabricate T3 that matches T2), and no headless share taken from device data.
7. **No double counting.** Per-connector aggregate-minus-routed reconciliation, or no T2 earning for provider accounts that also have ROUTED traffic (§5.2). T3 never counts.
8. **Settlement delay** until the revision window closes; clawback on restatement.
9. **Free tiers never earn** (Copilot Free: one free account per person; JetBrains AI Free; farming risk).
10. **Employer-paid seats** earn only if D6 allows it, and only with explicit org consent.
11. **A calibration epoch first**: settle at zero reward, like epoch-2026-09-10, and inspect the distributions.

### 5.7 The existing Claude subscription passthrough (a terms conflict; it stops in Phase 0a)
Facts from the codebase map:
- When the miner uses the USAGE fallback, it launches Claude Code with the header-only plan (`USAGE-Miner/src/tools/claude-code.ts:229-236`), setting only `ANTHROPIC_CUSTOM_HEADERS`.
- Claude Code keeps its claude.ai OAuth token in `Authorization`.
- `buildUpstreamHeaders` (`src/lib/gateway/anthropic.ts:66-106`) forwards it to Vercel AI Gateway (`src/lib/compute/vercel-gateway.ts:74`).
- `src/lib/providers/vercel-gateway/adapter.ts:200-206` then records it as `usage_credit` (promotional/held), not subscription.
- The miner tells the user "USAGE still swaps in your provider's credential" (`USAGE-Miner/src/cli.ts:459`), which is wrong for this route.
- `handler.ts:371-383` passes upstream error bodies back verbatim.

Why it must stop:
- Anthropic's Legal and compliance page says third-party developers may not route requests through Free/Pro/Max credentials on behalf of users, and "may not collect, store, or intermediate Claude.ai credentials or session tokens". The skeptic confirmed this reading.
- USAGE's server receives and relays that token on every such request. That is intermediation, even though nothing is stored.
- The only basis recorded in the repo is Vercel's own documentation of a Claude Code subscription mode (`anthropic.ts:76-86`). It is unverified here ⚠, and a gateway vendor's documentation cannot grant Anthropic's permission to USAGE.
- The hard constraints forbid helping users violate a provider's terms.

This is **not** an owner option to keep or relabel. Stopping it is a code change and a deploy with no migration, so nothing needs to wait. Phase 0a:
- **Server:** refuse any request that carries a caller `Authorization` on a route that would forward it upstream, with a clear error. Do not silently strip it and continue: continuing would fund the user's Claude usage from USAGE's key, which Anthropic's "Can customers offer Claude Code in their products?" section bars (paying for, reselling or intermediating Claude usage for end users; §8.1.2).
- **Miner:** stop using the header-only branch for Claude when a claude.ai login is active.
- **Audit existing sinks** for tokens already captured (§7 Phase 0a).
- **Sanitize** upstream error bodies on every gateway route.
- **Fix** the miner message at `cli.ts:459`, the catalog copy, and the stale comment at `claude-code.ts:26-29` (contradicted by the measurements in `docs/M15-ECONOMICS.md:1604-1614`).
- **Record** the change in `docs/STATE.md` and the `docs/ARCHITECTURE.md` capability table.

Past observations are not rewritten (rule 5 spirit: history stays as recorded). They were held as `usage_credit`; Phase 0a confirms none earned.

The only owner decision left is **what replaces the fallback** (D1).

---

## 6. Economics & owner decisions

### 6.1 Rules and documents affected

| Rule / doc | Current text (summary) | How subscription metering touches it |
|---|---|---|
| Hard rule 1 | Off-chain, non-transferable, no monetary value | All UI copy for subscription tiers; never show USD next to T3 |
| Hard rule 2 | Verify official docs; record capability table in `docs/ARCHITECTURE.md` | Every adapter and connector phase updates the table (§7) |
| Hard rule 3 | Metadata only; never persist prompts/code; never log secrets | T3 allowlists and content-flag refusal; forbidden reads (§4.7); no config byte backups; push sources drop non-members at ingest; log audit of the existing passthrough |
| Hard rule 4 | Integer micro-USD; parse strings | Copilot JSON numbers, Anthropic fractional cents: raw-text parsing plus a versioned rounding rule |
| Hard rule 5 | Scores/rewards versioned | reward-policy v2, economic-verification v2, pricing v4, receipt version, weights v2; past passthrough rows not rewritten |
| Hard rule 6 | Reported usage has zero economic weight | T3 subscription data **stays zero** and feeds no signal. No change proposed |
| Hard rule 7 | Fixed epoch pool | Sub-pool share for subscription (D7) |
| Hard rule 8 / hard constraint | Secrets server-side; never store user credentials | T2 token handling (D4); USAGE-side token revocation; T1 opaque forwarding (dormant); T1k plan keys use the existing encrypted connection path, and are not stored at all for a provider without written permission (D13) |
| Hard rule 10 | Root of trust is USAGE's receipt signing key | T2 is fetched and signed by trusted ingestion (fits). T2o pushes authenticated by customer-known headers: does USAGE's signature over unsigned third-party data meet "CONFIRMED"? (D3) |
| Hard rule 11 | Tier assigned server-side; USAGE-routed is ROUTED never VERIFIED; only `confirmed` earns; cost-unknown stays `pending` | New `provider_attested` type; T1 remains ROUTED; flat-rate cost is unknown by definition, so earning requires changing "cost-unknown stays pending" for this class **or** a non-cost value basis (D5) |
| Hard rule 13 | Production DDL agreed in advance | New verification type check, cost_basis check, reward_policy_versions row, connector/binding tables. (Phase 0a needs no DDL.) |
| Convention "Provider cost is authoritative or unknown. Never estimate" | | Device cost estimates dropped; protocol value / list-price credits never labelled cost |
| Convention "Colour encodes verification level only" | | Colours for new types |
| `src/lib/domain/cost.ts:88-91` | Price-table figures must not make usage eligible | Conflicts with D5 option (b) |
| `src/lib/protocol/reward-policy.ts:104, 308-309, 325-326`; `economic-unit.ts:523, 593-594`; tests `reward-policy.test.ts:133-137`, `economic-unit.test.ts:162-165` | Subscription → held | Change only through new versions |
| `docs/ARCHITECTURE.md:605, 808`; `docs/STATE.md:44-45` ("Subscriptions … never earn") | | Update to match the decisions |
| `src/lib/miner/telemetry.ts:11-15, 66-69` | A device upload never creates economic value; funding/cost/paid forbidden | Forbidden set extended with device cost fields |

### 6.2 Owner decisions required (options, not decisions)

**D1: What replaces the Claude subscription fallback** (the passthrough itself stops in Phase 0a regardless)
- (a) No fallback. The miner tells a Claude subscriber that subscription usage can only be observed (T3, once its legal gate clears) and that ROUTED Claude usage needs a paid route (their own key or a connected paid provider). Pro: no terms exposure. Con: some users lose a working path.
- (b) **BLOCKED.** A USAGE-funded shared-key Claude route, held and capped. Anthropic's "Can customers offer Claude Code in their products?" section bars paying for, reselling or intermediating Claude usage for end users (§8.1.2). This option is not available unless Anthropic confirms in writing that it is permitted.
- (c) Only `subscription-observe` (T3) for Claude subscribers. Pro: the user keeps their own login and plan. Con: display-only; blocked on the Claude Code launcher legal question.
- The open choice is therefore between (a) and (c). (b) stays blocked.

**D2: May subscription usage ever carry economic weight?**
- (a) Never. Display and reputation only. Pro: simplest; no farming incentive; no provider-AUP exposure. Con: subscription users (a large share of real AI use) are not rewarded.
- (b) T2 only, from a capped sub-pool under the §5.6 gates. Pro: real provider data; bounded dilution. Con: aggregate-only attribution; farming pressure; provider AUP risk (GitHub §4) unless the provider confirms; needs rule 11 and cost.ts changes.
- (c) T2 plus T1 or T1k once a provider authorizes. Pro: per-request data. Con: none authorize today; credential exposure (T1) or key custody (T1k); T1k cannot tell plan quota from paid overflow.
- T3 earning is **not** offered as an option (rule 6 and core thesis).

**D3: Verification type(s)**
- (a) Reuse `verified` for T2. Con: blurs per-request provider verification with aggregates attributed by USAGE.
- (b) Add `provider_attested` only; treat T2o as `reported`. Pro: honest and simple. Con: Kiro and Cursor OTel export get no credit.
- (c) Add both `provider_attested` and `org_attested`. Pro: precise. Con: more UI colours and rule surface.

**D4: Credential policy for T2**
- (a) Only secretless mechanisms (IAM roles, push with USAGE-issued tokens). Pro: no rule exception. Con: excludes Copilot, Anthropic Enterprise, Cursor pull, OpenAI Enterprise, and others.
- (b) One-shot user-initiated syncs with backfill; USAGE revokes the token server-side where the provider allows. Pro: no storage. Con: no automatic sync; freshness depends on the user.
- (c) Encrypted, least-privilege, revocable stored read-only credentials. Pro: automated daily sync. Con: an explicit exception to a hard constraint; breach impact; still subject to providers' key-transfer clauses (OpenAI §3.3(g), Mistral §2.2(h)). **A Phase 1 with automatic daily reconciliation requires this option.**

**D5: Value basis for flat-rate usage (if D2 ≠ a)**
- (a) Provider-stated list value (Copilot `grossAmount`, Cursor `totalCents`/`rawCostCents`, Anthropic `list_amount`). Pro: provider-sourced. Con: not what the user paid; not all providers state it.
- (b) USAGE protocol value from versioned prices on provider token counts. Pro: uniform. Con: conflicts with `cost.ts:88-91`; requires token counts, which several T2 sources lack.
- (c) Normalized units (tokens or credits) with no USD. Pro: honest. Con: units aren't comparable across providers.
- (d) Activity counts only. Pro: works for count-only sources. Con: easy to game, weak signal.

**D6: Employer-paid seats (Team/Enterprise/Business)**
- (a) Never earn for the individual. (b) Earn only with org consent. (c) Earn like personal plans. The trade-off is fairness and incentive against employer data-processing obligations and the provider org terms.

**D7: Pool share and caps**: sub-pool percentage, per-plan reward bound below plan price, the non-increasing curve, per-provider cap. Trade-off: attracting subscription users against diluting paid routed compute.

**D8: Granularity**: whether daily aggregates across all surfaces (Copilot) are acceptable for earning, or only sources with per-user hourly or finer buckets.

**D9: Settlement delay**: hold length per provider (Anthropic ≥ 30 days; others unknown). Trade-off: user experience against clawbacks.

**D10: Legal outreach**: who requests written confirmation, and from which providers first. Recommended order:
1. **Anthropic**: whether a miner that launches the unmodified Claude Code binary is "offering Claude Code in a product"; the isolated profile; whether it would confirm in writing that a shared-key route (D1b, blocked until then) is permitted; whether any third-party tools are currently allowed under its discretionary usage-credit policy; Enterprise analytics key or data sharing.
2. **GitHub**: T2 read plus AUP §4, including whether display-only reputation counts as a reward.
3. **Cursor**: `usage:*` key sharing; hooks-based counting.
4. **OpenAI**: Admin key vs §3.3(g).
5. **Google**: Antigravity hooks; Workspace OAuth app verification.
6. **Mistral** §2.2(i) and **JetBrains** AUP §1(h).

Round 2 targets, in recommended order. Each request asks one narrow question: may a user store their own key with USAGE, which forwards **only that user's own interactive traffic** to the documented endpoint with the User-Agent and session headers unchanged, and may USAGE record token metadata? A missing reply means no.

7. **Ollama** (hello@ollama.com). The terms say nothing on key custody, which makes Ollama the strongest T1k candidate. Also ask for a documented usage and cost API, since the per-request cost exists only in the account UI.
8. **Cline Bot Inc.** The ToS names "prior written consent" for API-key transfer. Ask about ClinePass and Cline credits together, and what `usage.cost` means for `cline-pass/` models.
9. **Kilo Code Inc.** Does the Gateway "Your Service" clause extend to holding each user's key? Does the gateway return cost to clients?
10. **MiniMax.** Clause 7 requires express permission for access-key transfer. Also ask whether `token_plan/remains` accepts the Subscription Key, and what it returns.
11. **Anomaly (OpenCode Go).** Does "own internal use" allow a transparent forwarding gateway?
12. **Amp Frontier Corporation.** May a third-party platform consume External API usage data (`threads.meta:view`, `analytics.daily-usage:view`)? Which plans can create machine-to-machine apps? What is the custom endpoint URL spec?
13. **Factory.** Is the Analytics API open to individual plans? Does customer OTel work on them? The BYOK charge conflict.
14. **Tabnine, Warp and Augment** (enterprise). May a customer share usage API data with a third party? Could read-only keys or tokens be issued?
15. **Moonshot / Kimi Platform** (platform.moonshot.ai). Low expectation: the guidelines route integrations there and lean against relays.
16. **xAI** (business development, not engineering). Is there any partner OAuth program for USAGE? Engineering does nothing until xAI answers.
17. **Not requested** (explicitly prohibited; no request planned): Z.ai, Alibaba, Volcengine, Tencent, Baidu, StepFun. Z.ai's terms allow a separate written agreement, but a relay would still clash with its proxy and one-person clauses. Cerebras Code is sold out.

**D11: Persistent config writes**: whether the miner may write user-level settings for tools it doesn't launch (Desktop Code tab, IDE extensions, Vibe, Cursor hooks), under the §4.5 rules.

**D12: Person-level identity**: how one person maps to one earning USAGE account across providers (required before any economic phase). Trade-off: Sybil resistance against privacy and onboarding friction. USAGE must not collect provider identity data beyond what binding needs.

**D13: T1k connected plan keys (round 2)**
- (a) Never. Key-based plans stay T3 (Claude Code third-party-plan observe). Pro: no custody of plan keys, and no exposure to shared-egress abuse detection. Con: no server-observed data for any plan.
- (b) Per provider, only after written permission, display-only. Traffic is ROUTED with `pending_cost`, visible to the user, and earns nothing. Pro: real provider token counts; fits the existing connection and ROUTED pipeline. Con: USAGE can't tell plan quota from paid overflow or prove interactive use; users risk provider enforcement if permission is later withdrawn.
- (c) As (b), then eligible for economic weight under Phase 2 gates. Pro: rewards real consumption. Con: every §5.6 farming risk applies, and flat-rate cost is unknown by definition (D5).
- **Sub-decision.** Credit plans (Ollama, Kilo, Cline credits) are prepaid usage, not a flat rate. Choose whether they are funded as `subscription` or as a separate prepaid-credit class. The Cline API's provider-stated `usage.cost` would make it ordinary paid ROUTED traffic.

---

## 7. Phased plan

Every phase finishes with `npm run typecheck && npm run lint && npm test && npm run build` in both repos. Production migrations need prior agreement (rule 13). **Every adapter or connector phase updates the capability table in `docs/ARCHITECTURE.md` (hard rule 2), and its go/no-go includes that table matching what shipped.**

### Phase 0a: Stop the Claude subscription passthrough (no new features; no decision needed to start)
- **Gate:** none for the stop. D1 decides only what the miner offers instead.
- **Tasks:**
  1. Server refuses a caller `Authorization` on every route that would forward it upstream (§5.7).
  2. Miner stops the header-only branch for Claude when a claude.ai login is active.
  3. Sanitize upstream error bodies on all gateway routes (`handler.ts:371-383`): fixed messages, no echoed headers or bodies.
  4. **Log-sink audit** for claude.ai OAuth tokens captured by past fallback traffic. Search Vercel request and runtime logs, `src/lib/gateway/observability.ts` output, error bodies returned or logged through `handler.ts:371-383`, Vercel AI Gateway logs, and any DB column that stores error text. Search for `Authorization` headers and `sk-ant-oat`-shaped values. Run the search so that matched values are counted and located, never printed in full. Purge what is found, where the sink allows it. If any token is found, tell the affected users to sign out of Claude Code and sign in again (rotating the token), without re-sending the value.
  5. Fix the funding label path, the miner message, catalog copy and stale comment (§5.7).
- **Files (USAGE):**
  - `src/lib/gateway/anthropic.ts`, `src/lib/gateway/handler.ts`
  - `src/lib/compute/vercel-gateway.ts`
  - `src/lib/providers/vercel-gateway/adapter.ts:200-206`
  - `src/lib/providers/catalog.ts:180-182`
  - `src/lib/miner/route-session.test.ts:116-118`
  - `docs/ARCHITECTURE.md` (capability table: Anthropic surface via Vercel), `docs/STATE.md`
- **Files (USAGE-Miner):**
  - `src/tools/claude-code.ts:26-29, 229-236`
  - `src/cli.ts:459` (message)
  - `src/route.ts` (`chooseRoute` fallback)
- **Tests:**
  - `gateway.test.ts`: a request with a caller `Authorization` is refused on every forwarding route; no upstream request is made; nothing is funded from USAGE's key.
  - Error sanitization: an upstream error that echoes request headers and a fake `sk-ant-oat01-TESTSECRET` returns a fixed message, and the value appears in no log (logger spy).
  - Adapter test: no observation is created with `usage_credit` for a refused request.
  - Miner test: the fallback never launches header-only mode with a live claude.ai login.
- **Go/no-go:** after deploy, a metadata-only counter shows refused requests and zero forwarded caller `Authorization` headers; the audit is complete and its outcome (counts, sinks, purge and notification status, no values) is recorded; the miner message matches actual behaviour. The miner release that carries the change is the owner's step.

### Phase 0b: T3 "subscription observe" for Claude Code and Codex (display only, zero weight)
- **Gates:**
  1. Live probes on current versions: Claude Code 2.1.273 credential precedence; OTLP http/json delivery to loopback; Desktop Code tab reading settings `env`; Codex `otlp-http` encoding and events on a real Plus/Pro session. Tokens are never captured.
  2. Privacy review of allowlists and preflights.
  3. D11 for any persistent write.
  4. No production DDL, or DDL agreed in advance.
  5. **Claude Code: legalGate `pending-review` until §8.1.2 is answered.** Claude Code may be prototyped behind a developer flag but is not released. Codex may release once gates 1-4 pass.
- **Files (USAGE-Miner):**
  - `src/tools/adapter.ts` (`SubscriptionObserve`, `RouteConfig.mode`)
  - `src/tools/claude-code.ts`, `src/tools/codex.ts` (launch plans, env stripping)
  - new `src/tools/preflight/claude-settings.ts`, `src/tools/preflight/codex-config.ts`, `src/tools/preflight/presence.ts` (presence-flag helper)
  - `src/telemetry/mappings.ts` (allowlists, cost-field drops)
  - `src/telemetry/otlp.ts`, `src/telemetry/receiver.ts` (content trip, body-free error paths)
  - `src/telemetry/always-on.ts` (remove `force`, manifest-only restore with DPAPI, receive-only key)
  - `src/cli.ts`, `src/ui.ts` (consent screens, mode selection, redacted diffs)
  - test fs-guard / env-guard helpers
- **Files (USAGE):**
  - `src/lib/miner/telemetry-ingest.ts`
  - `src/lib/miner/telemetry.ts` (validation; forbidden set extended with device cost fields)
  - `src/lib/miner/tools.ts` (`LOCAL_TOOLS` accepted adapters)
  - `src/app/api/miner/config/route.ts`
  - dashboard component for uncorrelated local rows
  - optional migration file for a display-only `session_mode` column
  - `docs/ARCHITECTURE.md` (capability table rows for Claude Code and Codex subscription-observe)
- **Tests:**
  - Mapping fixtures with content present: Claude `user_prompt` with `prompt` attribute, `api_request` with email/org ids, `workspace.host_paths`, `vcs.*`; Codex `user_prompt`, `tool_result`, email/account id. Only allowlisted fields survive, and normal batches are not rejected.
  - Cost fields: `cost_usd`, `cost_usd_micros`, `codex.turn_cost` are dropped by the miner; an upload containing them is rejected by the server.
  - Codex: `tool_token_count` is never added to totals.
  - Launch env: the child env contains no `ANTHROPIC_*`/`CLAUDE_CODE_OAUTH_TOKEN`; Codex args contain no `openai_base_url`, `chatgpt_base_url` or `model_providers`.
  - Preflight: a settings-sourced `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper` refuses launch; **each content flag (from user, project and managed settings) refuses launch**; a managed OTLP lock warns.
  - Preflight output: fixtures with fake token values; logger, crash-report and UI spies prove only presence flags leave the parser. `claude auth status` parser returns only `subscriptionType`.
  - Receiver: a prompt-bearing batch through every error path leaves nothing in logs, state or queue; a content-bearing event in an always-on session trips the session.
  - Settings: secret-bearing `env` test (§4.5); restore cases; no force path exists.
  - Forbidden reads: fs-guard and env-guard fail if any §4.7 list 1 or list 2 item for Claude or Codex is touched (credentials, `~/.claude/projects/` transcripts, `~/.codex/sessions/**/*.jsonl`).
  - Server: an uploaded subscription-observe observation creates no `usage_events` row, and `decideReward` gives `no_economic_weight`.
- **Go/no-go:** zero content fields and zero cost fields in a week of dogfood uploads; restore verified on Windows; capability table updated; Claude Code remains unreleased unless §8.1.2 is resolved.

### Phase 0c: More T3 adapters
Each adapter ships with its preflight, forbidden-read guards and its `docs/ARCHITECTURE.md` capability table row.
- **Gemini CLI** (Code Assist Standard/Enterprise and GDP Premium only):
  - Files: `src/tools/gemini-cli.ts`, `src/tools/preflight/gemini-settings.ts`, `mappings.ts`, `docs/ARCHITECTURE.md`.
  - Tests: the `gen_ai.client.inference.operation.details` event is dropped entirely; `GEMINI_TELEMETRY_LOG_PROMPTS=false` is set; `CODE_ASSIST_ENDPOINT` in env, settings or `.env` refuses launch; API-key/gateway mode refuses subscription-observe; `telemetry.logPrompts=true` in settings refuses launch until precedence is verified; `~/.gemini/oauth_creds.json` fs-guard.
  - Gates: live run on a licensed project; verify in source or a live run whether `GEMINI_TELEMETRY_LOG_PROMPTS` beats `telemetry.logPrompts` in settings.
- **Copilot CLI**:
  - Files: new `src/tools/copilot-cli.ts`, `src/tools/preflight/copilot-env.ts`, `/v1/traces` in `receiver.ts`/`otlp.ts`, `mappings.ts`, `ADAPTERS` in `cli.ts:55` and `ui.ts:48`, server `LOCAL_TOOLS`, `docs/ARCHITECTURE.md`.
  - Tests: root-span-only extraction; `github.copilot.cost` and `nano_aiu` dropped (never summed, never uploaded); BYOK vars stripped; `COPILOT_API_URL` / `GITHUB_COPILOT_API_TOKEN` refuse launch; managed content capture refuses launch; token env values never read (env-guard).
  - Gate: live run.
- **Mistral Vibe**:
  - Gates: legal read of Commercial Terms §2.2(i) and which terms govern Pro users; a live run confirming `strict` keeps `gen_ai.usage.*`; D11.
  - Tests: refuse unless `otel_redaction="strict"`; refuse if `api_base` is not first-party; `enable_otel`/`otel_endpoint`/`otel_redaction` written and restored as one unit, including the partial state (§4.5); `~/.vibe/.env` and `~/.vibe/logs/session` fs-guard.
- **Cursor hooks (count-only)**:
  - Gates: capture real hook payloads on a test account; legal review (legalGate `pending-review`); D11.
  - Tests: no content hook registered; `transcript_path`, `CURSOR_TRANSCRIPT_PATH` and `CURSOR_USER_EMAIL` never read; the hook exits 0, writes nothing to stdout and finishes within its timeout even when the miner is down, the receiver errors or the payload is malformed; `~/.cursor/sdk/auth.json` fs-guard.
- **Kiro CLI**: interactive-session observation only. No `/usage` or other extra invocation unless Kiro documents that it spends no credits. legalGate `pending-review`.
- **Junie CLI**: removed. Headless mode measures `JUNIE_API_KEY` usage-based billing, not the subscription.
- **Deferred with legalGate blocked or pending**: Antigravity, Windsurf/Devin.
- **Remove** any consumer Gemini CLI subscription option.
- **Claude Code third-party-plan observe** (round 2). Released together with the Claude Code adapter, so it is prototype only until §8.1.2 is answered.
  - Files: `src/tools/claude-code.ts` (mode), `src/tools/preflight/claude-settings.ts` (plan-host enum), `mappings.ts` (label by plan host), `docs/ARCHITECTURE.md`.
  - Tests:
    - Host matching is exact (a lookalike host, a wrong path or a USAGE host refuses).
    - A claude.ai login plus a plan base URL refuses.
    - The plan key value never leaves the preflight parser: a settings `env` fixture with a fake `sk-sp-TESTSECRET` is parsed in memory, and spies on the parser's return value, logs, UI output, crash reports and the state directory find no value; a process-env key is checked for presence only (env-guard).
    - A host whose per-plan-host legal gate is not clear refuses; the Alibaba Token Plan host is not in the enum.
    - `cost_usd` is dropped.
    - The miner never writes `ANTHROPIC_BASE_URL` or any key.
    - Uploads carry the plan-host enum, never the model string as a provider label.
    - For MiniMax, Ollama and Kimi rows, the display carries the paid-overflow note and never a "covered by plan" label (§2.7.5 flag 2).
  - Gates:
    - A per-plan-host legal read of each provider's terms (§8.1.14), in addition to §8.1.2.
    - A live run per plan host confirming Claude Code OTel reports the third-party model names. It uses the user's own session and is never a probe run on credits without approval.
    - Credential-precedence probe (§8.2.1).
- **Qwen Code** (round 2).
  - Files: new `src/tools/qwen-code.ts`, `src/tools/preflight/qwen-settings.ts`, `mappings.ts`, `docs/ARCHITECTURE.md`.
  - Tests:
    - `logPrompts` is forced false.
    - `includeSensitiveSpanAttributes=true` refuses.
    - Tool-execution and file-operation attributes are dropped by the allowlist.
    - A content-bearing event trips the session.
    - A non-plan base URL refuses, including the undocumented Alibaba Token Plan host.
  - Gates: a live run; verify the env variable names and whether env overrides settings ⚠.
- **Grok Build** (round 2).
  - Files: new `src/tools/grok-build.ts`, `src/tools/preflight/grok-config.ts`, metrics support in `receiver.ts`/`otlp.ts` if needed, `mappings.ts`, `docs/ARCHITECTURE.md`.
  - Tests:
    - Every Grok endpoint override in env or config refuses launch.
    - `model.api_key` or `model.env_key` in config refuses launch, and their values never leave the parser (fake-secret fixture and spies).
    - All four content gates are pinned to 0.
    - A signed `requirements.toml` pinning any content gate on refuses launch; the parser returns only which gates are pinned on.
    - `user.email` never leaves the receiver.
    - `~/.grok/auth.json` fs-guard.
    - Fleet-disabled telemetry shows "nothing measured", not an error.
  - Gate: a live run on a SuperGrok account.
- **Deferred:** Kilo CLI (token attributes undocumented; default-on spans with internal params), Tabnine CLI (Enterprise tier; tool arguments). **Not built:** Augment, Amp and Factory local signals (only from non-interactive runs or content-bearing stores).

### Phase 0r: Round 2 research (done 2026-09-16; follow-ups open)
- **Done.** §2.7 is filled, and the T1 conclusion in §1 and §3 is revisited (T1k added).
- **Open follow-ups (no code):**
  1. Send the D10 round-2 requests (items 7-16).
  2. Research the §2.9 round-2 leftovers only if a user or partner asks for them.
  3. Re-verify each §2.7 row before any build, because several products changed during 2026.
- **Gate for any adapter, connector, T1 or T1k work on a round-2 provider:** hard rule 2 verification of that provider's current official docs, plus the gates in the phase that builds it.

### Phase 1: First T2 pilot, display only and private: GitHub Copilot individual AI-credit usage
Why this one: it is a documented, consent-based, read-only third-party path for an **individual** subscription, and GitHub App user tokens are a sanctioned integration mechanism.
- **Gates (all required):**
  1. Owner D3 (type) and D4. **As specified here, Phase 1 uses D4(b)**: user-triggered sync with backfill up to the API's 24-month window, one call per missing day, and USAGE revokes the GitHub user token server-side right after the sync. An automatic daily sync requires D4(c), named explicitly as a prerequisite.
  2. Live test with a Pro account: GitHub App user token with Plan: read works on `/users/{u}/settings/billing/ai_credit/usage`; record the actual `product`/`sku` strings, `day` behaviour, and whether the cloud-agent and third-party-agent SKUs are separate. Resolve the fine-grained PAT doc conflict by not relying on PATs. Confirm the token-revocation API.
  3. Test with a Free account (expected: no data) so the UI claims no coverage it lacks.
  4. **Display is private to the user** (no public profile, no leaderboard, no reputation input) until GitHub's written position or legal review on AUP §4 answers whether reputation counts as a reward. `provider_attested` weight is 0 in scoring and leaderboards.
  5. Production migrations agreed (rule 13).
- **Files (USAGE):**
  - new `src/lib/providers/github-copilot-billing/` (client, raw-number parser, mapper to `NormalizedUsageRecord` with day granularity and gross/discount/net fields, automated-SKU flag)
  - new connection routes under `src/app/api/connections/github-copilot/` (GitHub App callback, sync trigger, server-side revocation)
  - `src/lib/db/ingest.ts` (provider_attested path, dedupe key, restatement upsert)
  - `src/lib/domain/types.ts` (`VerificationType`)
  - `src/lib/domain/receipt.ts` (new receipt version, cost_basis)
  - `src/lib/domain/scoring.ts` (weights v2 with provider_attested = 0; excluded from leaderboards)
  - `src/lib/protocol/economic-unit.ts` (provider_attested + subscription → held)
  - `supabase/migrations/00xx_provider_attested.sql` (type check, `provider_account_bindings` with uniqueness, connector state without secrets)
  - `src/lib/supabase/database.types.ts` (`type`, not `interface`)
  - dashboard components (private view)
  - `docs/ARCHITECTURE.md` (capability table row for GitHub Copilot billing usage)
- **Tests:**
  - raw JSON number to micros (`0.008`, `0.01`, `1e-3` handling or rejection, large values)
  - gross/discount/net mapping; `netAmount` = 0 still shows consumption
  - backfill: a sync after a gap fetches each missing day once; repeated syncs are idempotent
  - restatement upsert changes the value without duplicating
  - binding uniqueness and rebinding cooldown
  - automated SKUs flagged and excluded from any weight
  - the token never appears in logs, errors, DB or receipts (spy on logger and DB writes); not persisted after the request; revocation called on success and on failure
  - RLS: users read only their own attested rows; no public or leaderboard query returns them
- **Go/no-go:** internal accounts' synced data, gathered over 30 days through user-triggered syncs with backfill (no stored credential), reconciles with the GitHub UI's AI usage page; no credential leakage findings; capability table updated.

### Phase 1b: Parallel design partner (optional, display only)
Pick one, based on a willing user or org:
- **Google Developer Program Premium (individual, no secret held).** A single-user Code Assist Standard licence; project metrics map to one person. Gates: the owner accepts that `roles/monitoring.viewer` reads every metric in the project; `metricDescriptors.list` confirms the token metrics exist and whether CLI traffic appears (⚡); no log access.
- **Cursor Enterprise** Organization API key with `usage:*`. Gates: D4(c); a live test that the key is limited to usage routes; consenting-member filter.
- **Google Code Assist Standard/Enterprise (org)** through an IAM `roles/monitoring.viewer` grant, no secret held. Gates: as GDP Premium, plus `enumerateLicensedUsers` for attribution; any log read only with proof that `log_prompts_and_responses` is off or a `/metadata`-only log view.

- **Amp External API (individual, round 2).**
  - Gates:
    - A live check that a Megawatt or Hobby workspace can create a machine-to-machine app.
    - Amp's written position on third-party consumption (D10).
    - D4 for the app credential.
    - Starts with `threads.meta:view` only. `analytics.daily-usage:view` is requested only after a field check shows its rows can be filtered to the bound user.
    - Rows filtered to the bound user.
    - BYOK threads labelled separately. ChatGPT-linked threads excluded (not stored or displayed) until OpenAI's consumer terms on hosted relays are checked; if they cannot be identified in the usage data (⚠ unverified), the connector is not built.
    - Amp's current Terms re-read (they lag the 2026-09-13 change).
  - Tests:
    - A request for `threads.contents:view` or `model-provider-keys:*` is impossible in code.
    - ChatGPT-linked threads are dropped in memory before any write.
    - Thread titles are never stored.
    - USD `cost` is parsed from raw text to micros.
    - Threads older than 90 days are handled (404).
- **Tabnine Enterprise per-user usage (round 2).**
  - Gates: a live field check of `/api/v2/user/usage` (tokens or dollars?); org MSA and admin consent; a per-user PAT limited to Usage metrics read.

Files: `src/lib/providers/google-code-assist-monitoring/`, `cursor-org-usage/`, `amp-usage/` or `tabnine-usage/`, a consent flow, member email verification, a filter test proving non-consenting members' rows are never stored, and the `docs/ARCHITECTURE.md` capability table row.

### Phase 1c: T1k pilot (conditional on written permission; display only)
Why: T1k gives provider-returned token counts on a path that fits the existing connection and ROUTED pipeline. It is only legitimate where a provider says so in writing.
- **Gates (all required):**
  1. Written permission from the provider (D10 round-2 request), recorded in `docs/ARCHITECTURE.md` next to the capability row. The first request goes to Ollama; the pilot uses whichever candidate answers yes first.
  2. D13 = (b) or (c).
  3. Hard rule 2: current official docs for the endpoint, auth header and `usage` fields, including streaming. Verified on the user's own traffic or on a provider-supplied test key. `npm run usage:gateway:probe` or any credit-spending probe runs only with `--confirm` and approval (rule 9).
  4. Owner accepts the §2.7.5 shared-egress risk and informs users that their provider may still enforce its terms.
  5. Production migrations agreed (rule 13) if a new `cost_basis` or funding value needs DDL.
  6. **Kilo only:** the route excludes models and accounts Kilo serves on third-party plans (ChatGPT, SuperGrok, Z.ai, Kimi, MiMo), because relaying Z.ai plan traffic or SuperGrok OAuth traffic is prohibited by those providers (§5.3). No Kilo pilot until this is enforceable.
- **Files (USAGE):**
  - new `src/lib/providers/<provider>/` (wire format, `usage` mapper to `NormalizedUsageRecord`, fixed upstream)
  - a gateway definition per §5.3 T1k variant
  - connection UI copy stating where the key lives and what is recorded
  - `src/lib/domain/receipt.ts` (cost_basis, receipt version, if needed)
  - `docs/ARCHITECTURE.md` capability row
- **Files (USAGE-Miner):** a launch plan in `routed` mode for that provider's tool, carrying only the miner credential.
- **Tests:**
  - The upstream host can't be changed by client input.
  - The key never appears in logs, errors, receipts or responses (spy).
  - User-Agent and session headers pass through unchanged.
  - Concurrency limit enforced per key.
  - 402/1113/quota errors are sanitized and not retried.
  - Rows are `routed` with `pending_cost` (Cline API: provider `usage.cost` parsed with `usdStringToMicros`).
  - `decideReward` gives no economic weight while D13 = (b).
  - Disconnecting the connection deletes the stored key.
  - Kilo: a request for a third-party-plan model or account is refused before any upstream call.
- **Go/no-go:** a week of dogfood traffic reconciles with the provider's own usage view (viewed by the user, never scraped); no key leakage; capability table updated.

### Phase 2: Economic policy (only if D2 ≠ never)
- **Gates:**
  - D2, D5, D6, D7, D8, D9 and D12 decided.
  - Written confirmation from each provider whose data will earn.
  - **Person-level Sybil control** in place (D12).
  - **Reward per plan bounded well below plan price**, and a **non-increasing marginal curve** that reaches zero before the allowance.
  - Automated SKUs and kinds excluded; aggregate-minus-routed reconciliation specified per connector, or routed-traffic accounts excluded.
  - No signal derived from T3.
  - A zero-reward calibration epoch reviewed.
  - Production DDL agreed.
- **Files:**
  - `src/lib/protocol/reward-policy.ts` (new `usage-reward-policy-v2`, sub-pool, bounds, curve)
  - `src/lib/protocol/economic-unit.ts` (`economic-verification-v2`)
  - `src/lib/pricing/usage-pricing-v4.ts` (aliases) if D5b
  - `src/lib/domain/cost.ts` comment and logic if D5b
  - migration inserting `reward_policy_versions` row
  - `CLAUDE.md` rules 6/11 wording **only for T2**
  - `docs/ARCHITECTURE.md`, `docs/STATE.md`, `docs/M15-ECONOMICS.md`
- **Tests:**
  - v1 behaviour unchanged for historic epochs (never rewrite history)
  - sub-pool can't exceed its share
  - per-plan bound and curve (marginal reward non-increasing, zero before allowance)
  - one person with N bound plans earns no more than the person-level cap
  - T3 still zero and absent from every signal
  - automated SKUs zero
  - free tier never earns
  - held until the revision window; clawback on restatement
  - no double count across routed/T2

### Phase 3: More org connectors (each display-only first, then Phase 2 policy)
Each connector updates the `docs/ARCHITECTURE.md` capability table and its go/no-go. Order by legitimacy and value:
1. Anthropic Enterprise Analytics (gate: Anthropic written confirmation on sharing a `read:analytics` key or data; `user_ids[]` filtering).
2. Copilot Business/Enterprise org metrics (GitHub App installation).
3. Cursor Teams (gate: `read:*` works on usage routes; the plan-availability doc conflict resolved live).
4. OpenAI Enterprise/Edu (gates: §3.3(g) legal review; live COSTS schema; key narrowed to Costs read / Codex analytics read with an expiry).
5. Perplexity Enterprise Analytics.
6. Windsurf/Devin Enterprise.
7. Mistral Enterprise (workspace-level only).
8. JetBrains Console v2 (gate: out of Preview).
9. Push sources as T2o: Kiro Enterprise OTLP and Cursor Enterprise OTel export (gates: D3c; protobuf receiver; drop-at-ingest, family allowlist, no raw payload logging, DPA text; §5.2).
10. Antigravity on Gemini Enterprise (gate: verified non-admin read path).
11. Google Workspace Reports activity counts (gates: OAuth app verification; owner acceptance of audit-log blast radius).
12. Tabnine Enterprise org-level usage (round 2; gates: live field check; org MSA).
13. Warp Enterprise Analytics (round 2; gate: a read-only key exists; drop email and git context at ingest).
14. Augment Enterprise Analytics (round 2; gate: a read-only token exists; credit units documented).
15. Factory Analytics API (round 2; gate: availability confirmed; token and cost fields are estimates, labelled as such).
16. Microsoft 365 Copilot Graph usage reports (round 2; activity counts only; gates: owner accepts the tenant-wide `Reports.Read.All` blast radius; push-source rules (drop non-members in memory, no raw payload logging, bounded retention); USAGE never asks the admin to disable name concealment, so rows are mapped only if the tenant has already made names visible on its own decision; Copilot APIs Terms retention and audit obligations).

Amazon Q Developer: skip (IDE plugins sunsetting; console Q gives event counts only). Round 2 skips: Z.ai Team and Alibaba Token Plan Team (console-only analytics, no API); Replit (no API).

### Phase 4: T1 passthrough (conditional, possibly never)
- **Gate:** written authorization from a specific provider for a third-party hosted relay of subscription credentials, **and** owner acceptance of per-request credential exposure.
- **Files:** as in §5.3 (`src/lib/compute/<provider>-subscription-gateway.ts`, `src/lib/providers/surfaces.ts`, `src/lib/gateway/handler.ts`, `src/lib/miner/route-session.ts`, `USAGE-Miner/src/tools/adapter.ts` RouteConfig), plus the `docs/ARCHITECTURE.md` capability table.
- **Tests:** opaque header forwarding, no logging, error-body sanitization, server-fixed upstream, funding assigned by route, provider string correlation.
- Without written authorization this phase does not start. Round 2 found no app-login subscription that could authorize it. Key-based plans go through T1k (Phase 1c), not this phase.

---

## 8. Risks & open questions

### 8.1 Legal and terms
1. **Existing Claude passthrough.** It conflicts with Anthropic's credential-intermediation ban (§5.7) and is removed in Phase 0a. Residual risk: tokens captured in logs by past traffic (audit in Phase 0a). Vercel's subscription-mode documentation is unverified here and cannot grant Anthropic's permission.
2. **Miner launching Claude Code at all.** Anthropic's "Can customers offer Claude Code in their products?" section requires Commercial Terms, an unmodified binary, and no removing, disabling or restricting of built-in auth methods. It also bars paying for, reselling or intermediating Claude usage for end users. Open: does a third-party launcher count as offering Claude Code in a product? Does the isolated profile that deletes `.credentials.json` (`claude-profile.ts:147,158`) count as restricting sign-in? Needs legal review. A USAGE-funded shared-key Claude route (D1b) falls under the bar on paying for Claude usage and is blocked unless Anthropic confirms in writing that it is permitted. Until answered, the Claude Code adapter is `pending-review`.
3. **Anthropic support article (2026-05-19):** Anthropic "may, at its discretion, allow" certain third-party tools for paid subscribers with usage credits on, billed to usage credits. Discretionary; whether any tool is allowed today is unknown; ask Anthropic (D10).
4. **OpenAI:** "unclear" for hosted relays is not permission. OpenAI endorses using a ChatGPT plan in local third-party harnesses; its documents say nothing about hosted relays. ToU credential clause; Services Agreement §3.1, §3.3(g); "Modify, copy, lease, sell or distribute any of our Services". On Admin keys, both sides apply: the Help Center says the keys exist "to connect tools and services", while §3.3(g) bars transferring API keys with third parties.
5. **GitHub:** AUP §4 reward-incentivized and bulk-automation clauses. A user-quoted support notice citing "proxy usage" is a lead, not a primary source (unverified ⚠). A public profile or leaderboard entry may count as an incentive even with zero points, so Phase 1 display stays private. OpenCode support is a named partnership, not a general permission.
6. **Google:** the Code Assist third-party-access statement sits on the Gemini CLI docs page, not in the Cloud ToS contract. Antigravity terms' "in connection with products not provided by us" may reach local status-line or hook consumers. `admin.reports.audit.readonly` is a restricted scope that likely needs OAuth app verification ⚠.
7. **Cursor:** the automated-access AUP clause sits under "comply with law", not as a standalone ban. Certificate pinning; no read-only user key. Terms for a USAGE-installed hook are unclear, so hooks are `pending-review`.
8. **Windsurf/Devin:** which terms govern current self-serve users (Exafunction Individual §13.4 vs Cognition Platform ToS §14) is unclear. Teams terms now redirect to the Cognition Platform ToS.
9. **Mistral:** Commercial §2.2(i) (integrating Vibe into third-party products); consumer vs commercial terms for Pro users running the Vibe CLI.
10. **JetBrains:** AUP §1(h) programmatic extraction of outputs; §3(d)(i) fee avoidance.
11. **Enterprise analytics keys given to USAGE:** Anthropic docs silent; OpenAI §3.3(g); Mistral §2.2(h); Perplexity AUP unretrievable ⚠. Written confirmations needed.
12. **Data protection:** org keys expose every employee's usage, and push exports deliver non-members' data regardless of consent. USAGE becomes a processor, must filter at fetch or drop at ingest, and needs DPA text covering transient processing; the org must obtain consents (OpenAI Service Terms say the same for Enterprise admins).
13. **Key-based coding plans (round 2).** Six providers explicitly prohibit backends, proxies or unlisted access methods: Z.ai §4.2/§4.3, Alibaba, Volcengine, Tencent, Baidu and StepFun §3. For them only T3 is possible. The rest are unclear, and unclear is not permission:
    - MiniMax clause 7 (express permission for key transfer).
    - Cline (prior written consent for key transfer; credential-sharing item (v); the ToS predates ClinePass).
    - Kimi Community Guidelines and Model Service Agreement (lean against).
    - OpenCode "own internal use".
    - Kilo "Your Service" clause (silent on per-user keys).
    - Ollama Terms (silent).
    - Cerebras (terms seen only in search results).

    Storing any of these keys for routing before written permission would help users breach their terms.
14. **Claude Code on third-party plans.** Launching Claude Code pointed at a plan provider keeps the provider's supported-tool condition only while the miner stays out of the request path. That condition is necessary, not sufficient. Each plan host also needs its own legal gate before release, separate from the Anthropic question: StepFun §3 bars "unofficial, unauthorized, or unspecified tools", and the miner is not a supported tool under Z.ai §4.2. A host whose gate is not clear is refused by the preflight (§4.2). It also inherits the open Anthropic question in item 2, whatever the backend. Z.ai's bulk-automation clause and the interactive-only rules of Alibaba, Kimi, MiniMax, Baidu and Tencent make any miner-generated traffic a ban risk for users.
15. **xAI.** The consumer Terms, AUP and Grok FAQ treat third-party possession of Grok credentials as prohibited. Partner OAuth integrations are individual arrangements, not a program USAGE can join by itself.
16. **Microsoft.** The consumer Copilot Supplemental Terms ban bots, tools and programs. For enterprise reports, the Copilot APIs Terms (preview) guidelines 4, 10 and 18, §4 audit rights and §5 deletion duties apply.
17. **Editor and agent vendors.**
    - Zed §2.4 and Tabnine (auto programs, intercepting transmissions) prohibit routing in effect.
    - Augment §1.1 bars credential sharing, which rules out holding session JSON.
    - Amp's Terms and AUP are in flux; nothing covers third-party External API consumers.
    - Factory Individual Plans Terms bar reverse engineering, which rules out unofficial OAuth bridges.
    - Warp credits cannot be transferred.
18. **Enterprise analytics data (round 2).** Warp, Augment and Tabnine are governed by private contracts whose third-party data-sharing terms are unknown. Written confirmation is needed per vendor (D10 item 14).

### 8.2 Technical unknowns (verify before building)
1. Claude Code credential precedence on 2.1.273 vs the 2.1.268 probe (a saved login outranked `ANTHROPIC_AUTH_TOKEN` there, contrary to docs). Re-probe without capturing the token.
2. Claude Desktop Code tab OTel via settings `env` (documented, live probe advised); Desktop's pinned endpoint (v2.1.251+); Windows user-level `OTEL_*` variables affect all sessions.
3. `claude auth status` JSON field names are undocumented; Team/Enterprise values unverified.
4. Codex: `[otel]` honoured by the desktop app ⚠; `otlp-http` encoding; `codex.turn_cost` from plain TUI runs; `account/usage/read` surface coverage (cloud tasks) and timezone.
5. Gemini: Code Assist token metrics absent from the GA reference; CLI traffic in Cloud Monitoring (⚡ docs conflict); agent-mode OTel; Workspace AI Ultra CLI access after 2026-06-18; **whether `GEMINI_TELEMETRY_LOG_PROMPTS=false` overrides `telemetry.logPrompts=true` in settings**; which `.env` files the CLI loads; whether a Cloud Logging view can be limited to `/metadata` entries.
6. Antigravity Gemini Enterprise developer-tools metric types and labels; a non-admin Monitoring read path.
7. Copilot: fine-grained PAT support (⚡); Free/Student/complimentary Pro coverage; cloud-agent and third-party-agent SKU separation; restatement and finality of day data; JetBrains OTel schema; how enterprise-managed settings interact with a local exporter; the GitHub App token-revocation endpoint.
8. Cursor: Teams Admin API availability (⚡); `read:*` on usage routes; whether `totalCents`/`chargedCents` are still populated after 2026-07-31; stream-json and hook token fields; `/v1/agents` coverage of editor-started agents; mapping the OTel `cursor.user.id`; whether usage-event `kind` identifies BYOK.
9. OpenAI Enterprise: Admin key vs Platform key (⚡); COSTS schema, scope and latency; token fields in Codex `/usage`.
10. Kiro/Vibe: undocumented JSON usage schemas; whether Kiro `/usage` spends credits; Kiro ACP `_kiro.dev/metadata`; whether a Kiro org can choose HTTP/protobuf export; Vibe strict redaction confirmed in source (mistralai 2.6.0), but the live run is pending.
11. Windsurf: whether Cascade hooks still fire after the reported Cascade retirement.
12. Anthropic Enterprise fractional-cent rounding; Agent SDK / `claude -p` credit-pool change is paused but may resume, which would change labelling.
13. Loopback receiver authentication for persistent modes: whether the plaintext receive-only key in `settings.json` can be removed.
14. **Plan endpoints (round 2).**
    - Whether the Z.ai, Kimi, MiniMax, Alibaba, Volcengine, Tencent, Baidu, StepFun and OpenCode Go endpoints return `usage` in Anthropic/OpenAI format, including when streaming. Untested; never probe with real credits without approval.
    - Whether Ollama's `/v1/messages` returns usage in streaming `message_delta` and cache tokens.
    - Whether MiniMax `token_plan/remains` accepts the key.
    - Whether the Kilo gateway returns cost to clients.
    - What Cline `usage.cost` means for `cline-pass/` models.
15. **Claude Code OTel with a third-party backend:** whether `claude_code.api_request` reports the backend's model names (e.g. `glm-5.3`, `k3-256k`), and how credential precedence behaves when a claude.ai login and a plan base URL coexist (ties to item 1).
16. **Kimi docs conflict** (⚡) on Claude Code env var names and base URL between the help centre and the docs site.
17. **Qwen Code:** exact telemetry env names, and whether env overrides `logPrompts` / `includeSensitiveSpanAttributes` in settings.
18. **Grok Build:** OTLP endpoint variable name and protocol; whether fleet policy currently disables external OTel; the unverified Free-tier availability.
19. **Amp:** which plans and roles can create machine-to-machine apps; the fields of the workspace daily-usage endpoint; the custom endpoint URL spec.
20. **Tabnine:** usage API token and dollar fields (⚡); what the CLI OTLP stream contains with `logPrompts` off; who calls an org OpenAI-compatible provider.
21. **Factory:** whether customer OTel and the Analytics API work on individual plans; the BYOK charge conflict (⚡).
22. **Warp:** the pricing page vs docs on BYOK and custom endpoints for Build/Max (⚡); whether a read-only analytics key can be created.
23. **Augment:** credit-usage units in the Analytics API; whether `auggie --output-format json` carries usage fields.
24. **Microsoft Graph:** report latency (not stated on the docs page); whether delegated permission suffices for the v2 report.

### 8.3 Product and economic risks
1. **Farming:** flat-rate plus reward drives automated burning, provider enforcement against USAGE users, and account bans that users blame on USAGE.
2. **Sybil arbitrage:** one person buying several cheap plans and binding each to its own USAGE account; mitigated only by person-level identity (D12) and per-plan reward bounds.
3. **Dilution:** subscription volume could swamp paid routed compute without a capped sub-pool.
4. **False precision:** showing T3 or estimated cost as real. Every such figure must carry its tier and "not a cost"; device cost estimates are dropped.
5. **Silent measurement gaps:** managed settings lock OTLP destinations; exports fail silently when the miner is down; content-flag refusals and session trips stop measurement; users may read gaps as bugs.
6. **Config damage and secret sprawl:** persistent writes to user settings files; mitigated by §4.5 (no byte backups, DPAPI manifest, no force, redacted diffs).
7. **Credential breach** if D4c is adopted.
8. **Privilege blast radius:** Google monitoring and logging roles, Workspace audit scope and admin keys read far more than usage (§5.2).
9. **Attribution errors** in org connectors (shared emails, removed users still in data).
10. **Provider changes:** policies moved several times in 2026 (Anthropic Feb/Apr/May/Jun; Google consumer CLI shutdown; Cursor cost reporting). Re-verify before each phase. Round 2 adds more:
    - Shutdowns or retirements: Qwen OAuth, Microsoft Copilot Pro, Roo Code.
    - Plan changes: Ollama's credit pricing, MiniMax's quota model, Baidu and Tencent Coding Plan to Token Plan, Warp and Augment pricing.
    - Terms changes: Amp's terms, xAI's issuer.
11. **Real money on misconfiguration (round 2).** A wrong base URL, or a plan quota running out, can spend a user's paid balance: Z.ai account balance, Volcengine pay-as-you-go, MiniMax Credits, Ollama purchased credits, Kimi Extra Usage, Factory BYOK overage. Users would blame USAGE. Mitigated by never writing base URLs or keys and by exact host checks (§2.7.5).
12. **Account enforcement from shared egress (round 2).** If T1k is ever built, many users' keys leave from USAGE's IPs, a pattern Kimi, MiniMax and Z.ai associate with sharing. Written permission should name this explicitly.
13. **Label confusion (round 2).** Claude Code sessions backed by GLM, Kimi or MiniMax models could be shown as "Claude" usage, with Anthropic-priced cost. Rows are labelled by plan host, and device cost is always dropped.
14. **Content leakage through default telemetry (round 2).** Qwen Code prompts on by default, Kilo CLI export on by default, Tabnine CLI tool arguments, Factory message content, Grok `user.email`. Mitigated by the allowlist, pinned gates and session trip, but each new tool version can add attributes.

---

## 9. Sources

Primary sources only. Leads and secondary reports are listed separately and were not used as evidence.

### Anthropic
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/llm-gateway
- https://code.claude.com/docs/en/llm-gateway-protocol
- https://code.claude.com/docs/en/llm-gateway-connect
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/settings-reference
- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/analytics
- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/desktop
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/cloud-environments
- https://claude.com/docs/third-party/claude-desktop
- https://claude.com/docs/third-party/claude-desktop/gateway
- https://www.anthropic.com/legal/consumer-terms
- https://www.anthropic.com/legal/commercial-terms
- https://www.anthropic.com/legal/aup
- https://platform.claude.com/docs/en/api/admin/analytics
- https://platform.claude.com/docs/en/manage-claude/analytics-api
- https://platform.claude.com/docs/en/build-with-claude/claude-code-analytics-api
- https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account
- https://support.claude.com/en/articles/12883420-view-usage-analytics-for-team-and-enterprise-plans
- https://support.claude.com/en/articles/14477985-monitor-claude-cowork-activity-with-opentelemetry
- https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

### OpenAI
- https://learn.chatgpt.com/docs/auth.md
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/config-file/config-advanced.md
- https://learn.chatgpt.com/docs/config-file/config-basic.md
- https://learn.chatgpt.com/docs/windows/windows-app.md
- https://learn.chatgpt.com/docs/agent-approvals-security.md
- https://learn.chatgpt.com/docs/app-server.md
- https://learn.chatgpt.com/docs/non-interactive-mode.md
- https://learn.chatgpt.com/docs/enterprise/analytics-api.md
- https://learn.chatgpt.com/docs/enterprise/governance.md
- https://learn.chatgpt.com/docs/enterprise/workspace-analytics.md
- https://learn.chatgpt.com/docs/enterprise/usage-limits.md
- https://learn.chatgpt.com/docs/enterprise/work-admin-faq.md
- https://learn.chatgpt.com/docs/pricing.md
- https://chatgpt.com/public/admin/api-reference
- https://help.openai.com/en/articles/20001407-managing-admin-keys-in-admin-console
- https://help.openai.com/en/articles/20001478-reviewing-work-and-codex-usage-and-using-personal-analytics-in-chatgpt-desktop
- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- https://help.openai.com/en/articles/20001155-managing-credits-and-spend-controls-in-chatgpt-business
- https://help.openai.com/en/articles/10875114-workspace-analytics-for-chatgpt-enterprise-and-edu
- https://openai.com/policies/row-terms-of-use/
- https://openai.com/policies/eu-terms-of-use/
- https://openai.com/policies/services-agreement/
- https://openai.com/policies/service-terms/
- https://openai.com/policies/usage-policies/
- https://developers.openai.com/community/codex-for-oss
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/model-provider-info/src/lib.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/model-provider/src/bearer_auth_provider.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/core/src/config/mod.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/network-proxy/src/credential_broker/providers/openai.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/otel/src/events/session_telemetry.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/otel/src/events/shared.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/otel/src/metrics/names.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/codex-api/src/rate_limits.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/backend-client/src/client/chatgpt_turn_cost.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server/src/turn_cost_worker.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server/src/turn_cost_worker_chatgpt.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server/tests/suite/v2/turn_cost_otel.rs
- https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountTokenUsageResponse.ts
- https://github.com/openai/codex/releases/tag/rust-v0.154.0

### Google
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/resources/tos-privacy.md
- https://geminicli.com/docs/resources/tos-privacy/
- https://github.com/google-gemini/gemini-cli (commit 6a466a7: `packages/core/src/core/contentGenerator.ts`, `packages/core/src/telemetry/types.ts`, `docs/cli/telemetry.md`)
- https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx
- https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- https://developers.google.com/gemini-code-assist/resources/privacy-notices
- https://developers.google.com/gemini-code-assist/docs/network-access
- https://developers.google.com/gemini-code-assist/docs/use-agentic-chat-pair-programmer
- https://developers.google.com/profile/help/benefit-gemini-code-assist
- https://docs.cloud.google.com/gemini/docs/quotas
- https://docs.cloud.google.com/gemini/docs/codeassist/monitor-gemini-code-assist
- https://docs.cloud.google.com/gemini/docs/codeassist/generate-metrics
- https://docs.cloud.google.com/gemini/docs/codeassist/manage-licenses
- https://docs.cloud.google.com/gemini/docs/codeassist/network-access
- https://docs.cloud.google.com/gemini/docs/configure-logging
- https://docs.cloud.google.com/gemini/docs/log-gemini
- https://docs.cloud.google.com/monitoring/api/metrics_gcp_c
- https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-metrics
- https://cloud.google.com/terms
- https://workspace.google.com/terms/premier_terms/
- https://antigravity.google/llms.txt
- https://antigravity.google/docs/cli/install
- https://antigravity.google/docs/cli/gcli-migration
- https://antigravity.google/docs/plans
- https://antigravity.google/pricing
- https://antigravity.google/docs/cli/commands/usage
- https://antigravity.google/docs/cli/credits
- https://antigravity.google/docs/cli/statusline
- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/settings
- https://antigravity.google/docs/settings
- https://antigravity.google/docs/hooks
- https://antigravity.google/docs/enterprise/
- https://antigravity.google/changelog
- https://antigravity.google/terms
- https://github.com/google-antigravity/antigravity-cli
- https://jules.google/docs/api/reference/
- https://support.google.com/gemini/answer/16275805
- https://support.google.com/gemini/answer/17004136
- https://policies.google.com/terms
- https://policies.google.com/terms/generative-ai
- https://developers.google.com/data-portability/user-guide/scopes
- https://developers.google.com/workspace/admin/reports/v1/appendix/activity/gemini-in-workspace-apps
- https://developers.google.com/workspace/admin/reports/reference/rest/v1/activities/list
- https://workspaceupdates.googleblog.com/2025/07/gemini-audit-logs-reporting-api-audit-and-security-invesitgation-tools.html

### GitHub Copilot
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-cli-reference/cli-command-reference.md
- https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models
- https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-cli-reference/cli-config-dir-reference.md
- https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/models/bring-your-own-key.md
- https://docs.github.com/en/copilot/concepts/network-settings
- https://docs.github.com/en/copilot/concepts/agents/opentelemetry
- https://code.visualstudio.com/docs/agents/guides/monitoring-agents
- https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/guides/monitoring-agents.md
- https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/configuration/common/configurationService.ts
- https://github.blog/changelog/2026-07-08-enterprise-managed-opentelemetry-export-for-vs-code-and-cli/
- https://github.blog/changelog/2026-07-27-github-copilot-for-jetbrains-adds-improvved-opentelemetry-configuration-and-model-management/
- https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/
- https://github.blog/changelog/2026-08-28-upcoming-changes-to-github-copilot-policies-and-billing/
- https://docs.github.com/en/rest/billing/usage?apiVersion=2022-11-28
- https://raw.githubusercontent.com/github/docs/main/content/rest/billing/usage.md
- https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
- https://docs.github.com/en/rest/copilot/copilot-usage-metrics?apiVersion=2022-11-28
- https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-usage-metrics/copilot-usage-metrics.md
- https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-usage-metrics/reconciling-usage-metrics.md
- https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage
- https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/billing-and-usage/individuals/billing.md
- https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/billing-and-usage/individuals/usage-limits.md
- https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-billing/models-and-pricing.md
- https://raw.githubusercontent.com/github/docs/main/content/billing/reference/billing-reports.md
- https://raw.githubusercontent.com/github/docs/main/content/billing/tutorials/automate-usage-reporting.md
- https://raw.githubusercontent.com/github/docs/main/content/billing/reference/product-and-sku-names.md
- https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/agents/cloud-agent/about-cloud-agent.md
- https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/hooks-reference.md
- https://raw.githubusercontent.com/github/docs/main/content/copilot/how-tos/copilot-sdk/features/usage-and-billing.md
- https://raw.githubusercontent.com/github/copilot-sdk/main/docs/auth/authenticate.md
- https://raw.githubusercontent.com/github/copilot-sdk/main/docs/auth/server-to-server-tokens.md
- https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies
- https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- https://github.com/customer-terms/github-generative-ai-services-terms
- https://github.com/customer-terms/general-terms
- https://github.com/customer-terms/github-copilot-product-specific-terms

### Cursor
- https://cursor.com/llms.txt
- https://cursor.com/docs/api.md
- https://cursor.com/docs/account/teams/admin-api.md
- https://cursor.com/docs/account/teams/dashboard.md
- https://cursor.com/docs/account/teams/pricing.md
- https://cursor.com/docs/account/teams/analytics-api.md
- https://cursor.com/docs/account/teams/analytics.md
- https://cursor.com/docs/account/organizations/organization-admin-api.md
- https://cursor.com/docs/account/enterprise/service-accounts.md
- https://cursor.com/docs/enterprise/opentelemetry-export.md
- https://cursor.com/docs/enterprise/opentelemetry-export/wire.md
- https://cursor.com/docs/enterprise/compliance-and-monitoring.md
- https://cursor.com/docs/enterprise/network-configuration.md
- https://cursor.com/docs/enterprise/privacy-and-data-governance.md
- https://cursor.com/docs/hooks.md
- https://cursor.com/docs/cli/reference/authentication.md
- https://cursor.com/docs/cli/reference/parameters.md
- https://cursor.com/docs/cli/reference/configuration.md
- https://cursor.com/docs/cli/reference/output-format.md
- https://cursor.com/docs/cli/changelog.md
- https://cursor.com/docs/cli/headless.md
- https://cursor.com/docs/cloud-agent/api/endpoints.md
- https://cursor.com/docs/cloud-agent/api/webhooks.md
- https://cursor.com/docs/sdk/typescript.md
- https://cursor.com/help/integrations/cli.md
- https://cursor.com/help/integrations/third-party.md
- https://cursor.com/help/models-and-usage/api-keys.md
- https://cursor.com/help/models-and-usage/usage-limits.md
- https://cursor.com/help/models-and-usage/token-rate.md
- https://cursor.com/help/account-and-billing/pricing.md
- https://cursor.com/help/troubleshooting/network.md
- https://cursor.com/terms-of-service
- https://cursor.com/acceptable-use-policy
- https://cursor.com/terms/msa

### Windsurf / Devin
- https://web.archive.org/web/20260613160644id_/https://devin.ai/windsurf/terms-of-service-individual
- https://cognition.com/terms-of-service
- https://cognition.com/legal/platform-terms-of-service
- https://cognition.com/legal/acceptable-use-policy
- https://docs.devin.ai/desktop/accounts/api-reference/api-introduction
- https://docs.devin.ai/desktop/accounts/api-reference/cascade-analytics
- https://docs.devin.ai/desktop/accounts/api-reference/user-page-analytics
- https://docs.devin.ai/desktop/accounts/api-reference/custom-analytics
- https://docs.devin.ai/desktop/accounts/api-reference/get-consumption
- https://docs.devin.ai/api-reference/v3/consumption/consumption-daily-users
- https://docs.devin.ai/desktop/accounts/usage
- https://docs.devin.ai/desktop/accounts/quota
- https://docs.devin.ai/admin/billing/usage.md
- https://docs.devin.ai/desktop/cascade/hooks
- https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks.md
- https://docs.devin.ai/desktop/troubleshooting/windsurf-proxy-configuration
- https://docs.devin.ai/cli/reference/configuration/config-file.md
- https://docs.devin.ai/cli/enterprise/windsurf-auth.md
- https://docs.devin.ai/cli/models.md
- https://docs.devin.ai/desktop/models
- https://docs.devin.ai/enterprise/security-access/personal-analytics.md

### JetBrains
- https://www.jetbrains.com/legal/docs/terms/jetbrains-ai-service/
- https://www.jetbrains.com/legal/docs/terms/acceptable-use-policy/
- https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html
- https://www.jetbrains.com/help/ai-assistant/bring-your-own-key-byok.html
- https://junie.jetbrains.com/docs/junie-cli.html
- https://junie.jetbrains.com/docs/byok.html
- https://junie.jetbrains.com/docs/environment-variables.html
- https://junie.jetbrains.com/docs/parameters.html
- https://junie.jetbrains.com/docs/junie-headless.html
- https://www.jetbrains.com/help/jetbrains-console/analytics-api-v2.html
- https://www.jetbrains.com/help/jetbrains-console/ai-analytics.html
- https://www.jetbrains.com/help/jetbrains-console/ai-credits-consumption.html
- https://blog.jetbrains.com/ai/2026/02/enhanced-ai-management-and-analytics-for-organizations/

### AWS (Amazon Q Developer, Kiro)
- https://kiro.dev/docs/getting-started/authentication/
- https://kiro.dev/docs/cli/headless/
- https://kiro.dev/docs/reference/slash-commands/
- https://kiro.dev/docs/billing/
- https://kiro.dev/docs/privacy-and-security/firewalls/
- https://kiro.dev/docs/enterprise/monitor-and-track/
- https://kiro.dev/docs/enterprise/monitor-and-track/user-activity/
- https://kiro.dev/docs/enterprise/monitor-and-track/user-activity/opentelemetry/
- https://kiro.dev/changelog/general/open-telemetry-exports/
- https://kiro.dev/license/
- https://aws.amazon.com/agreement/
- https://aws.amazon.com/service-terms/
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-tiers.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-developer-ide-end-of-support.html
- https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-admin-user-telemetry.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/user-activity-metrics.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/monitoring-cloudwatch.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/logging-using-cloudtrail.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/firewall.html
- https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html

### Mistral
- https://docs.mistral.ai/admin/billing-usage/subscriptions
- https://docs.mistral.ai/admin/user-management-finops/tier
- https://docs.mistral.ai/admin/admin-api/overview
- https://docs.mistral.ai/admin/admin-api/usage-metrics
- https://docs.mistral.ai/admin/security-access/admin-api
- https://docs.mistral.ai/mistral-vibe/introduction/configuration
- https://mistral.ai/pricing
- https://mistral.ai/news/mistral-vibe-2-0/
- https://github.com/mistralai/mistral-vibe (commit d4b3223)
- https://legal.mistral.ai/terms/row-consumer-terms
- https://legal.mistral.ai/terms/commercial-terms-of-service
- https://legal.mistral.ai/terms/additional-terms

### Perplexity
- https://web.archive.org/web/20260830042405id_/https://www.perplexity.ai/hub/legal/terms-of-service
- https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service
- https://www.perplexity.ai/hub/legal/enterprise-terms-of-service
- https://docs.perplexity.ai/docs/admin/computer-analytics-api
- https://www.perplexity.ai/help-center/en/articles/10354847-api-payment-and-billing (403 on re-check ⚠)
- https://www.perplexity.ai/help-center/en/articles/11844346-enterprise-usage-analytics

### Round 2: Z.ai (GLM Coding Plan, ZCode)
- https://docs.z.ai/devpack/quick-start
- https://docs.z.ai/devpack/overview
- https://docs.z.ai/devpack/faq
- https://docs.z.ai/devpack/teamplan
- https://docs.z.ai/legal-agreement/subscription-terms
- https://docs.z.ai/devpack/usage-policy
- https://docs.z.ai/devpack/tool/others
- https://docs.z.ai/devpack/extension/usage-query-plugin
- https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs (provider's own source; endpoints undocumented)
- https://zcode.z.ai/en/docs/usage-stats

### Round 2: Moonshot Kimi Code
- https://www.kimi.com/code/docs/en/
- https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html
- https://www.kimi.com/code/docs/en/kimi-code/membership.html
- https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html
- https://www.kimi.com/en/help/kimi-code/third-party-agents (⚡ conflicts with the docs site)
- https://www.kimi.com/en/help/kimi-code/benefits
- https://www.kimi.com/en/help/kimi-code/membership-guide
- https://www.kimi.com/user/agreement/modelUse (Model Service Agreement, Chinese, undated)
- https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py (provider's own source)
- https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/telemetry/transport.py
- https://moonshotai.github.io/kimi-cli/en/configuration/config-files.html
- https://github.com/MoonshotAI/kimi-code

### Round 2: MiniMax
- https://platform.minimax.io/docs/token-plan/intro.md
- https://platform.minimax.io/docs/token-plan/faq.md
- https://platform.minimaxi.com/docs/token-plan/faq.md
- https://platform.minimax.io/docs/token-plan/claude-code
- https://platform.minimax.io/docs/api-reference/text-anthropic-api.md
- https://platform.minimax.io/protocol/terms-of-service (effective 2026-03-30; read from raw HTML)

### Round 2: Alibaba Cloud Model Studio and Qwen Code
- https://www.alibabacloud.com/help/en/model-studio/coding-plan
- https://www.alibabacloud.com/help/en/model-studio/coding-plan-faq
- https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview
- https://help.aliyun.com/zh/model-studio/token-plan-personal-overview
- https://www.alibabacloud.com/help/en/model-studio/token-plan-team-overview
- https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
- https://qwenlm.github.io/qwen-code-docs/en/developers/development/telemetry/

### Round 2: Volcengine, Tencent Cloud, Baidu Qianfan, StepFun
- https://docs.volcengine.com/docs/82379/1925114 (read through the doc JSON API)
- https://www.volcengine.com/article/37156
- https://cloud.tencent.com/document/product/1772/128947
- https://cloud.tencent.com/document/product/1823/130103
- https://cloud.baidu.com/doc/qianfan/s/imlg0beiu
- https://cloud.baidu.com/news/news_e839687d-1cf7-4a5b-afbd-ea2f7bcd325d
- Baidu Qianfan Token Plan Personal doc (id `Dmrabu8b6`; URL not recorded ⚠)
- https://platform.stepfun.ai/docs/en/step-plan/overview
- https://platform.stepfun.ai/docs/en/step-plan/integrations/claude-code
- https://platform.stepfun.ai/docs/en/step-plan/paid-service-agreement

### Round 2: OpenCode Go, Cerebras Code
- https://opencode.ai/docs/go/
- https://opencode.ai/legal/terms-of-service
- https://www.cerebras.ai/code
- https://www.cerebras.ai/blog/introducing-cerebras-code

### Round 2: Ollama
- https://ollama.com/pricing
- https://ollama.com/terms
- https://ollama.com/blog/transparent-pricing
- https://docs.ollama.com/cloud
- https://docs.ollama.com/integrations/claude-code
- https://docs.ollama.com/api/authentication
- https://docs.ollama.com/api/usage
- https://docs.ollama.com/api/openai-compatibility
- https://docs.ollama.com/api/anthropic-compatibility
- https://docs.ollama.com/faq

### Round 2: xAI (SuperGrok, Grok Build)
- https://x.ai/legal/terms-of-service
- https://x.ai/legal/acceptable-use-policy
- https://x.ai/legal/terms-of-service-enterprise
- https://docs.x.ai/grok/faq
- https://x.ai/news/grok-build-cli
- https://docs.x.ai/build/overview
- https://docs.x.ai/build/settings/reference
- https://docs.x.ai/build/enterprise
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/24-monitoring-usage.md
- https://docs.x.ai/developers/cost-tracking
- https://x.ai/news/grok-opencode
- https://x.ai/news/grok-kilocode
- https://docs.warp.dev/agent-platform/inference/grok-subscription/
- https://vercel.com/docs/ai-gateway/coding-agents/grok-build

### Round 2: Microsoft
- https://support.microsoft.com/en-us/microsoft-365-copilot/about-microsoft-copilot-pro
- https://support.microsoft.com/en-us/microsoft-365-copilot/ai-credits-and-limits-for-microsoft-365-subscriptions
- https://www.microsoft.com/en-us/microsoft-copilot/for-individuals/termsofuse
- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/copilot-apis-overview
- https://learn.microsoft.com/en-us/legal/m365-copilot-apis/terms-of-use
- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail

### Round 2: Zed, Warp
- https://zed.dev/pricing
- https://zed.dev/docs/account/plans-and-pricing
- https://zed.dev/docs/ai/models
- https://zed.dev/terms
- https://zed.dev/acceptable-use-policies
- https://zed.dev/docs/ai/use-api-access
- https://zed.dev/docs/authentication
- https://zed.dev/docs/telemetry
- https://www.warp.dev/pricing
- https://www.warp.dev/blog/warp-new-pricing-flexibility-byok
- https://docs.warp.dev/support-and-community/plans-and-billing/pricing-faqs/
- https://www.warp.dev/terms-of-service
- https://docs.warp.dev/reference/cli/api-keys/
- https://docs.warp.dev/reference/api-and-sdk/
- https://docs.warp.dev/cli/models-and-usage/
- https://docs.warp.dev/agents/inference/bring-your-own-api-key/
- https://docs.warp.dev/agents/inference/custom-inference-endpoint/
- https://docs.warp.dev/enterprise/enterprise-features/analytics-api/
- https://docs.warp.dev/support-and-community/privacy-and-security/privacy/

### Round 2: Augment Code, Tabnine
- https://www.augmentcode.com/pricing
- https://docs.augmentcode.com/models/token-based-pricing
- https://docs.augmentcode.com/cli/setup-auggie/authentication
- https://docs.augmentcode.com/cli/reference
- https://docs.augmentcode.com/analytics/analytics-api
- https://www.augmentcode.com/legal/professional-terms-of-service
- https://www.augmentcode.com/legal/community-terms-of-service
- https://www.augmentcode.com/legal/enterprise-terms-of-service
- https://www.tabnine.com/pricing/
- https://www.tabnine.com/terms-of-use/
- https://docs.tabnine.com/main/welcome/readme/tabnine-subscription-plans
- https://docs.tabnine.com/main/administering-tabnine/managing-your-team/tabnine-apis
- https://docs.tabnine.com/main/administering-tabnine/managing-your-team/settings/access-tokens
- https://docs.tabnine.com/main/administering-tabnine/managing-your-team/settings/models-settings
- https://docs.tabnine.com/main/administering-tabnine/managing-your-team/user-management/service-accounts-and-token-limits
- https://docs.tabnine.com/main/getting-started/tabnine-cli/features/settings/settings-reference
- https://docs.tabnine.com/main/administering-tabnine/release-notes

### Round 2: Cline, Kilo Code
- https://cline.bot/cline-pass
- https://docs.cline.bot/getting-started/clinepass.md
- https://docs.cline.bot/api/overview
- https://docs.cline.bot/api/chat-completions
- https://docs.cline.bot/getting-started/cline-provider
- https://cline.bot/blog/one-api-key-for-claude-gemini-gpt-and-everything-else
- https://cline.bot/tos
- https://docs.cline.bot/enterprise-solutions/monitoring/opentelemetry.md
- https://kilo.ai/pricing/kilo-pass
- https://kilo.ai/docs/gateway
- https://kilo.ai/docs/gateway/authentication
- https://kilo.ai/docs/gateway/api-reference
- https://kilo.ai/docs/gateway/usage-and-billing
- https://kilo.ai/terms
- https://kilo.ai/inference/subscriptions
- https://kilo.ai/docs/code-with-ai/platforms/cli

### Round 2: Amp, Factory, Replit, Roo Code
- https://ampcode.com/pricing
- https://ampcode.com/docs/pricing
- https://ampcode.com/news/free-agent
- https://ampcode.com/news/subscriptions
- https://ampcode.com/news/no-more-byok
- https://ampcode.com/security
- https://ampcode.com/api/external
- https://ampcode.com/docs/cli/streaming-json
- https://ampcode.com/docs/models-and-subagents
- https://ampcode.com/terms
- https://ampcode.com/terms/aup
- https://docs.factory.ai/pricing/individuals
- https://docs.factory.ai/cli/byok/overview
- https://docs.factory.ai/droid-exec/overview
- https://docs.factory.ai/enterprise/telemetry-export
- https://factory.ai/terms-of-service
- https://replit.com/pricing
- https://docs.replit.com/billing/ai-billing.md
- https://docs.replit.com/replitai/replit-ai-integrations
- https://replit.com/terms-of-service
- https://github.com/RooCodeInc/Roo-Code
- https://roomote.dev/

### Leads only (not relied on as evidence)
- https://github.com/orgs/community/discussions/174325 (user-quoted GitHub support restriction notice; cited in this document only as an unverified lead)
- https://github.com/kirodotdev/Kiro/issues/7752 (user feature request)
- https://forum.cursor.com/t/support-for-otel-integration/162950
- https://forum.cursor.com/t/override-openai-base-url-not-working/168323
- https://forum.cursor.com/t/usage-page-to-token-amount-what/167153
- https://x.com/windsurf_ai/status/1925717425460306048
- https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch
- https://medium.com/@joe.njenga/windsurf-is-now-devin-desktop-i-spotted-it-in-claude-code-ide-06d9b96d23bd
- https://docs.getdx.com/connectors/codex-enterprise/
- Round 2:
  - https://jia.je/kb/en/software/coding_plan.html (third-party index of coding plans; used only to enumerate providers)
  - https://x.com/MiniMax_AI/status/2040431340961542460 (says the plan was built for third-party harnesses; not a contract term)
  - https://github.com/MiniMax-AI/MiniMax-M2/issues/88 (legacy `coding_plan/remains` reportedly needed a cookie)
  - https://github.com/ollama/ollama/issues/15663 (undocumented `/api/usage`)
  - https://x.com/ollama/status/2094664013993177514 (credit pricing announcement)
  - https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth (xAI OAuth allowlist, 403s)
  - https://ailimit.watch/tools/tabnine/ (Tabnine plan retirement dates)
  - Unlinked secondary reports: V2EX and landiannews on the Tencent Coding Plan sell-out; tokscale README on Auggie session snapshots; rulesync issue #3013 on Tabnine CLI as a Gemini CLI fork; an Alibaba developer-community article on Coding Plan vs Token Plan; third-party guides claiming Grok Build on the Free tier

### Internal references
- `docs/M15-ECONOMICS.md` (Claude Code credential-precedence probe on 2.1.268, lines 1604-1614)
- `docs/ARCHITECTURE.md` (lines 605, 789, 808; provider capability table)
- `docs/STATE.md` (lines 44-45)
- `CLAUDE.md` (hard rules 1-13, conventions)
- `src/lib/gateway/anthropic.ts:66-106`, `src/lib/gateway/handler.ts:46, 371-383`, `src/lib/gateway/observability.ts`, `src/lib/providers/vercel-gateway/adapter.ts:200-206`, `src/lib/providers/catalog.ts:180-182`
- `USAGE-Miner/src/tools/claude-code.ts:26-29, 34-40, 229-236`, `USAGE-Miner/src/cli.ts:459`, `USAGE-Miner/src/telemetry/always-on.ts:112`, `USAGE-Miner/src/tools/claude-profile.ts:147,158`
