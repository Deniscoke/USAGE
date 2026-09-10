# USAGE Miner — Windows beta

The miner exists so that using AI can be verified without anyone configuring
anything. The measure of success for this milestone is a sentence, not a
feature list:

> Download → install → sign in → start your AI tool through USAGE → use AI.

No npm. No PowerShell. No terminal. No copied token. No base URL. No headers.
No credential written to any configuration file.

Everything below is either how that is achieved, or an honest account of where
it is not achieved yet.

---

## 1. What ships

| Artifact | What it is |
|---|---|
| `USAGE-Miner-<version>.exe` | The whole application, one file. |
| `USAGE-Miner-<version>-Setup.exe` | Per-user installer with the above embedded. |
| `SHA256SUMS.txt`, `release.json` | Checksums over the exact published bytes. |

Both are produced by `npm run package` inside `miner/`, and the same command
writes `src/lib/miner/release.generated.ts`, which is what the download page and
`/api/miner/release` serve. A checksum on the site is never typed by a human.

### Why Node SEA, and not a rewrite

The miner's pairing flow, credential handling and tool adapters are the parts
that have been reviewed and tested. Rewriting them in C# or Electron to change
the *user interface* would have thrown that away and doubled the surface where a
credential can leak. Node's Single Executable Application support embeds the
existing code in a copy of the Node runtime, so:

* the user installs nothing — the runtime is inside the file;
* there is one implementation of every security-relevant path;
* the binary is byte-for-byte reproducible (`useCodeCache: false`), so anyone
  can rebuild it from source and compare hashes.

The cost is size: ~87 MB, almost all of it Node. That is the price of not asking
a beta user to install a runtime, and it is the right trade.

The installer wrapper is **not** reproducible: the C# compiler that ships inside
Windows has no `/deterministic` switch, so it stamps a fresh module id into every
build. `release.json` marks that per file rather than leaving someone to
discover it as an apparent mismatch.

### The desktop window

A loopback HTTP server, rendered in the user's own browser. No GUI toolkit, no
second UI framework to keep current, and the process exits when you quit.

Its whole security argument is local:

* bound to `127.0.0.1` on an ephemeral port — never a fixed port, never `0.0.0.0`;
* every request must carry a 24-byte random session nonce minted at startup;
* a request whose `Origin` is not this exact server is refused, so a page the
  user has open cannot drive the miner even if it guessed the port;
* `/open` takes a target *name* from a fixed allowlist, never a URL;
* the page builds every node with `textContent` — no `innerHTML` anywhere.

Covered by `miner/src/ui.test.ts`.

---

## 1b. Metering: how usage gets tracked

Since 0.4.0 the miner is the local AI usage meter for the account, and the
mechanism is deliberately boring:

```
AI tool --official OpenTelemetry (OTLP/JSON, logs only)--> 127.0.0.1:<random>
                                                              | per-session bearer secret
                                                              v
                                                     flatten (scalars only)
                                                              v
                                                     allowlist per tool
                                                              v
                                                  LocalUsageObservation v1
                                                              v
                                            sign (device Ed25519, DPAPI-held)
                                                              v
                                POST /api/miner/telemetry -- or DPAPI buffer, <=2000, <=72h
```

**The receiver treats localhost as hostile.** Every other program running as
you can reach 127.0.0.1. So each launched session gets a fresh 32-byte bearer
secret handed only to the child process's environment; the long-lived miner
credential is never the receiver's secret and never present in that module;
bodies are capped at 1 MB and requests at 20/s; `/v1/metrics` and
`/v1/traces` are acknowledged and discarded; protobuf is refused (415) so a
tool is told to use JSON.

**Two privacy gates, independent of each other.** The OTLP flattener keeps
scalar attributes only -- a message list or a raw API body is an array or a
map, and never reaches an adapter. The allowlist then keeps exactly the fields
named in one table per tool. `prompt`, `response`, `user.email`,
`user.account_uuid`, `organization.id`, `session.id`, `tool_input`,
`arguments`, `output`, paths -- all present on the real wire from these tools
-- are dropped by never being named. The observation type has no slot for
them. Tested by sending them.

**Opt-in, per app.** Detected never means enabled. The user ticks each app;
the choice is recorded locally and on the server, where the metering method
and verification ceiling are looked up in the server's own registry -- a
device that claims more is ignored.

**A device signature proves origin, not truth.** The user owns the machine,
the key and the pipe. A signed observation of ten million tokens is a signed
lie if they want it to be. That is why a device upload can reach
`device_attested` and no higher, and why nothing in `local_usage_observations`
is read by scoring, settlement or the ledger -- the table has no economic
columns to read.

**Exact correlation or nothing.** When an observation carries the provider's
own request id (Claude Code does; Gemini and Codex do not — Codex reports the
model and counts only, confirmed on the wire), the server looks
for a record it produced itself with the identical id. On a match the
observation becomes `provider_correlated` and the trusted event gains
`local_telemetry` as a provenance source. Its reward columns are not in the
update. There is no "same token count and roughly the same minute" path.

**Verified against a real run.** Claude Code 2.1.261, one tiny prompt:
5 OTLP requests, 116 log records, 58 distinct attribute keys on the wire
including `prompt`, `response`, `user.email`, `user.account_uuid`,
`organization.id`. One observation out: model, four token counts, cost
estimate, `request_id`. Nothing else.

## 2. What the miner is not

**USAGE Miner is not a trusted usage reporter.** It never submits token counts,
cost, generation ids, verification status, protocol compute, mining score or
Usage Points. It configures routing and gets out of the way; USAGE measures what
it observes at the gateway.

It also holds no provider credential. The device gets one scoped `usgm_` token of
its own. An OpenRouter key, an Anthropic key and the gateway key stay server-side
— that separation is the entire reason for routing through USAGE rather than
around it.

And nothing it does is remotely steerable. The server sends declarative routing
values (a URL, a protocol, a connection id). Tool adapters are compiled in. There
is no field in any server response that decides what runs, and no update path
that downloads and executes anything.

---

## 3. What it puts on your machine

| Path | What | Removed on uninstall |
|---|---|---|
| `%LOCALAPPDATA%\Programs\USAGE Miner\` | The executable and uninstaller | Yes |
| `%AppData%\Microsoft\Windows\Start Menu\Programs\USAGE Miner.lnk` | Start Menu entry | Yes |
| `HKCU\...\Uninstall\USAGEMiner` | Add/Remove Programs entry | Yes |
| `%APPDATA%\USAGE\credential.dpapi` | This device's token, DPAPI-encrypted | Only if you say yes |
| `%APPDATA%\USAGE\miner.log` | Local event log, no secrets | Only if you say yes |
| `%TEMP%\usage-miner-setup.log` | One line, only if install or uninstall failed | No |
| `…\Start Menu\Programs\Claude Code - USAGE Mining.lnk` | Shortcut. Holds the argument `run claude-code`, never a credential | Yes |
| `~/.codex/config.toml` | A provider block naming `USAGE_MINER_TOKEN`, when Codex mining is on | Restored, if you say yes |
| `~/.claude/settings.json` | **Nothing.** Claude Code is launched, not configured | n/a |

No service. No scheduled task. No autostart. No administrator rights, ever —
per-user install, `HKCU` only.

The credential is encrypted with Windows DPAPI at `CurrentUser` scope: another
account on the same machine cannot read it, and a copied file is useless
elsewhere. It is never written to a config file, never placed in a shortcut,
never printed, and never logged. The log has an allowlist of fields and scrubs
anything token-shaped as a last line of defence.

### Two ways to route a tool, and why Claude Code only gets one

**LAUNCHED.** The miner starts the tool and puts the routing in that child
process's environment. It exists while the tool runs and is gone when it exits.
Nothing is written to disk. This is how **Claude Code** works, and the only way
it works.

**CONFIGURED.** The tool's own config file is edited — and may only *name* a
credential, never contain one. **Codex** can do this: `env_key =
"USAGE_MINER_TOKEN"` points at an environment variable the launcher sets.

Claude Code's settings file takes literal environment values and has no
`env_key` equivalent, so configuring it persistently would mean writing the
device's miner token into `~/.claude/settings.json` in plaintext — a second copy
of a credential otherwise held under DPAPI, in a file that gets copied into
dotfile repositories and pasted into bug reports.

Builds 0.2.x did exactly that. **0.3.0 removes the capability rather than
documenting it**: `enableMining` refuses for Claude Code, and there is no flag
to override it. An adapter that cannot configure a tool without writing a secret
reports `persistentConfig: "unsafe"`, and the refusal is enforced at the CLI and
at the loopback API as well, so a local caller cannot reach a path the UI does
not offer.

### Upgrading from 0.2.x

First run cleans up, in this order and no other:

1. **Detect** — only if the settings actually carry USAGE's own header. A file
   the user wrote, or one pointing at somebody else's proxy, is never touched.
2. **Remove** — restoring the rollback copy when one exists, so unrelated Claude
   Code configuration comes back exactly; otherwise removing only the three keys
   USAGE set.
3. **Rotate** — because a secret that has sat in a readable file must be assumed
   read. A fresh credential is minted and the old one revoked in the same
   server-side operation.

Idempotent and fail-safe: a clean machine does nothing, a failed cleanup does
not rotate (that would replace a known-exposed credential with a
newly-exposed one), and a failed rotation leaves the cleanup standing with a
working credential to retry from.

### What a device credential may do

`miner:route`, `miner:config`, `miner:heartbeat`, `miner:rotate` — the whole
list, checked on every request and constrained by a database check so an unknown
scope cannot even be stored.

There is no scope for changing account settings, retrieving a provider secret,
creating a proof, altering a reward, settling points, or reaching another user's
data. Those abilities are not disabled for miners; they are not expressible.

Uninstall offers to restore each AI tool's original settings **first**, by calling
the miner's own tested `disable` path rather than a second copy of that logic in
the installer. The sign-in is left in place by default: it is the user's data,
and a reinstall should not force a fresh pairing. Removing the device from the
account is a separate, deliberate act at `/miners`.

---

## 4. First run

1. **Open it.** SmartScreen warns — see §5. The window opens in your browser.
2. **Sign in.** One button. It opens `/pair`, where you are already signed in,
   and shows a short code. Approve the device; the app finishes on its own.
   The credential travels over the poll channel, never in a URL and never
   through a copy-paste.
3. **Connect a provider,** if you have not. The app links to `/providers/add`;
   OpenRouter is one click.
4. **Start Claude Code with USAGE** — the button in the app, or the Start Menu
   entry the installer adds. Routing lives in that session and nothing is
   written to disk. For Codex, enable mining instead: its config can name the
   credential. If a tool already points somewhere custom, the app says so and
   asks before replacing it — and backs up what was there.
5. **Use your AI tool normally.**

### Error states, and what the user actually sees

| Situation | What happens |
|---|---|
| Not signed in | The window offers Sign in. Nothing else is enabled. |
| No provider connected | "Connect a provider" instead of an enable button. |
| Device revoked at `/miners` | The account panel shows the server's rejection; mining stops working because the token no longer authenticates. |
| Offline | "Could not reach USAGE. Check your connection." Local state still renders. |
| Tool not installed | Listed, greyed, no action. |
| Tool points at a foreign endpoint | Shown as a conflict; for Codex, Enable becomes Replace behind a confirmation naming the current endpoint. Claude Code is launched, so a foreign endpoint is simply reported and left alone. |
| Asked to configure Claude Code persistently | Refused, at every surface, with the launcher named. There is no override flag. |
| Upgrading from 0.2.x | The stored credential is removed, the previous settings restored, and the credential rotated. Reported in the window and in the CLI. |
| Tool config unreadable | Reported as-is. Nothing is written over something we could not parse. |
| Credential unreadable (different Windows account, restored file) | "Sign in again." No attempt to guess. |
| Build older than the server's minimum | "A newer USAGE Miner is available." Nothing auto-downloads. |
| Anything unexpected | "Something went wrong." No stack trace — it can carry paths and request bodies. |

---

## 5. Code signing

**This build is not signed, and the download page says so.** Windows SmartScreen
will report an unrecognised publisher, and that warning is correct. Pretending
otherwise would be the single most damaging thing this project could do to its
own credibility, so the page leads with the warning and gives the SHA-256 and the
`certutil` command to check it.

Note that a *broken* signature is worse than none: injecting the SEA blob
invalidates the signature Node.js ships on `node.exe`, so the build strips the
certificate table entirely rather than leaving Windows to report a tampered
binary.

**A signature is identity, not silence.** When signing lands, this page will be
able to say *Signed by: <publisher>*. It will not say Windows has stopped
warning: SmartScreen weighs a publisher's reputation as well as its identity,
and a new certificate starts with none. Claiming otherwise would set up exactly
the disappointment that makes people ignore the next warning.

### Options, assessed

| Option | Cost | Reality |
|---|---|---|
| **Azure Artifact Signing** (formerly Trusted Signing) | $9.99/mo, 5,000 signatures | Cheapest credible route. No hardware token: signing happens in Azure. Individual developers are limited to the **USA and Canada**; organizations also get the EU and UK. Short-lived certificates, so the signing key is never on a build machine. |
| **SignPath Foundation** | Free for qualifying OSS | OV certificates via Sectigo, through a managed pipeline with build-provenance requirements. Revocable, including retroactively. Realistic once USAGE is genuinely open source with a public CI build. |
| **Certum Open Source Code Signing** | ~€100/yr incl. hardware token | Cheap OV. Builds SmartScreen reputation over time rather than granting it. Requires a physical token, which makes CI signing awkward. |
| **Commercial EV** (DigiCert, Sectigo direct) | $300–700/yr | Immediate SmartScreen reputation. Hardware token or cloud HSM mandatory since 2023. Overpriced for a beta. |
| **Stay unsigned** | Free | What this build does. Honest, and unacceptable as a permanent answer. |

**Recommendation.** Azure Artifact Signing, contingent on jurisdiction — USAGE
is developed from Slovakia, so the individual tier (USA/Canada only) does not
apply and this needs an EU-registered organization. If that is not near-term,
SignPath Foundation is the right fallback and costs nothing, at the price of
making the build pipeline public. Either way, signing is a prerequisite for
telling anyone outside a small beta to download this.

### SignPath Foundation: what it would actually take

The repository is already public and there is now a release history, which were
the two things that used to disqualify it. What remains:

| Requirement | Status |
|---|---|
| Public repository | **Met** — github.com/Deniscoke/USAGE |
| Already released in the form to be signed | **Met** — `v0.2.0-beta.1` |
| OSI-approved licence, no commercial dual-licensing | **NOT MET — there is no `LICENSE` file at all.** Without one the code is "all rights reserved", which is not open source and cannot qualify. Choosing a licence is the owner's decision, not a build detail. |
| Verifiable automated build on GitHub-hosted runners | **Prepared** — `.github/workflows/release.yml` in the public `Deniscoke/USAGE-Miner` repository (the one canonical miner release pipeline; the platform repository carries none). Signing steps are gated on the dispatch input and run only when the `release` environment holds the SignPath token; secrets are passed via `with:`/`env:`, never referenced in `if:`. |
| Artifact uploaded as a workflow artifact before signing | **Prepared** — `actions/upload-artifact@v4`, then `signpath/github-action-submit-signing-request@v2` |
| Author / reviewer / approver roles, MFA on GitHub and SignPath | **Owner action.** A solo project may hold all three roles; MFA is not optional |
| Published code-signing policy page | **Not written** |
| Every signing request individually approved | Built into SignPath; nothing to do here |

SignPath's guarantee is worth understanding, because it is the reason the
workflow exists before the certificate does: the GitHub App confirms to
SignPath that a particular GitHub-hosted runner executed a particular workflow
at a particular commit, and that the artifact was stored by GitHub before it was
submitted. Origin metadata comes from GitHub, not from the build script, so a
build cannot lie about where it came from. That is a stronger claim than "this
hash came from a laptop", and it is worth having whether or not a signature ever
gets attached.

**Nothing here has been applied for, registered, or purchased.** The workflow
runs only on manual dispatch and skips signing unless `SIGNPATH_API_TOKEN`
exists, so it cannot start producing something that claims to be signed.

**The signing key is not the receipt key.** Executable signing and Proof of Usage
signing are separate trust systems with separate keys, separate lifetimes and
separate blast radii. They must never share material. A compromised signing cert
means bad binaries; a compromised receipt key means fabricated proofs. Nothing
should let one become the other.

### MSIX and the Microsoft Store

Evaluated, and **not** the path for this beta.

*For:* Store submission is now free for both individual and company developer
accounts. Store-distributed packages are signed by Microsoft, which removes the
SmartScreen problem entirely and gives users a familiar install and update path.
MSIX uninstall is guaranteed clean by the OS.

*Against, decisively:* MSIX gives a packaged app a virtualized view of the file
system and registry — writes are redirected to per-user locations. The miner's
entire function is to edit **another application's** configuration
(`~/.claude/settings.json`, `~/.codex/config.toml`) so that a *different* process
reads the change. Getting that to work needs the `unvirtualizedResources`
restricted capability, which is subject to Store review, and it is exactly the
behaviour Store certification scrutinises. A beta whose core mechanic depends on
an exception request is not a beta that ships this month.

*Revisit when:* the tool adapters can configure routing without touching another
app's files on disk — for example, if the AI tools grow a supported per-project
or environment-scoped configuration mechanism. Until then, MSIX would be fighting
the packaging model rather than using it.

---

## 6. Why there is no `usage://` protocol handler

Considered for "click a button on the site, the app opens and pairs". Rejected
for this beta: registering a protocol handler means any web page in any browser
can invoke the local app with an argument of its choosing, which is a new
attack surface bought for the sake of removing one already-easy step.

Pairing does not need it. The app opens the browser itself, and the browser
posts the approval back through the server — the direction that does not require
the web to be able to reach the desktop. Revisit only if a flow genuinely starts
on the web and cannot be inverted.

---

## 7. Updates

The server publishes what it considers current at `/api/miner/release`: version,
minimum supported version, sizes, SHA-256, and a download URL. `/api/miner/config`
already tells a paired device whether it is below the minimum.

The miner **reads** this and says "a newer version is available". It does not
download it, and it does not run it. Auto-update is a code-execution channel; it
does not get built before the binaries are signed, and when it is built it will
verify a signature rather than a URL.

---

## 8. Verified

Run on Windows 11, build 0.2.0:

| Check | Result |
|---|---|
| Standalone exe on a machine with no Node on PATH | Runs; the runtime is inside it |
| Two builds from the same source | Identical SHA-256 (miner exe) |
| Clean install, silent | Files, Start Menu entry, Add/Remove entry all created |
| Upgrade over an existing install | Succeeds, replaces both binaries |
| Uninstall, silent | Install directory, shortcut and registry key all gone |
| A `settings.json` USAGE never wrote | Byte-identical before and after the whole cycle |
| Desktop server without the session nonce | 403 on every route |
| Desktop server with a foreign `Origin` | 403 |
| `/open` with an arbitrary URL | Refused; allowlist only |
| `/enable` before sign-in | 401 |
| State returned to the page | Contains no credential |

Not automated, and checked by hand: the interactive dialogs (install
confirmation, replace-a-foreign-endpoint confirmation, restore-on-uninstall,
delete-my-sign-in). They need a desktop session.

---

## 9. Building a release

```bash
cd miner
npm install
npm run typecheck && npm test
npm run package
```

Artifacts land in `miner/dist/artifacts/`. A plain build leaves the website's
manifest alone; cutting a release is `npm run package -- --publish`, which
rewrites `src/lib/miner/release.generated.ts`. Commit that, publish the exact
bytes it describes, and set `MINER_RELEASE_TAG` in `src/lib/miner/release.ts` to
the tag you published under.

The flag exists because the installer wrapper is not reproducible: without it,
every routine `npm run package` would repoint the live download page at a
checksum matching nothing anyone can download.

The executables are far too large for git and for a serverless bundle, so they
are published as release assets. `USAGE_MINER_DOWNLOAD_BASE` repoints the
download links for a fork or a staging build; without it they resolve to the
tagged GitHub release for the version in the manifest.

Verifying a download:

```bash
certutil -hashfile USAGE-Miner-0.2.0-Setup.exe SHA256
```

## 7. Map once (designed, not built)

The current flow starts an AI app *from* USAGE Miner so the session-only
telemetry environment can be injected. The target flow is: turn mapping on
once, then use the app normally.

Claude Code supports this today through two documented pieces: OpenTelemetry
settings in `settings.json` `env` (`CLAUDE_CODE_ENABLE_TELEMETRY`,
`OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
`OTEL_EXPORTER_OTLP_ENDPOINT`), and `otelHeadersHelper` — a command Claude Code
runs at startup and every 29 minutes (`CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS`)
whose JSON output becomes the OTLP headers. Dynamic headers apply to
`http/json`, which is what the receiver speaks.

Design:

| Piece | Holds |
| --- | --- |
| `settings.json` (written with consent, backed up, removable) | endpoint `http://127.0.0.1:<fixed port>/v1/logs`, protocol, exporter flags, `otelHeadersHelper` = path of the installed `USAGE-Miner-x.y.z.exe otel-headers` |
| `otel-headers` command | prints `{"Authorization":"Bearer <short-lived session secret>"}` obtained from the running tray process over loopback; exits non-zero when USAGE Miner is not running |
| USAGE Miner (per-user, in the tray while mapping is on) | DPAPI miner credential, device key, the receiver on a fixed loopback port, mints and rotates the session secret |

No long-lived credential ever enters Claude's configuration: the helper
returns a secret that is only valid while the tray process runs, and the
tray process is what holds the DPAPI credential. No service, no autostart
without an explicit switch, no change to routing (mapping mode leaves Claude
on its own sign-in and provider; verified routing stays a separate,
explicit choice). It is a milestone of its own: a tray lifecycle, a fixed
port with the same nonce/Origin protections, the helper command, an
uninstall path that restores `settings.json`, and tests for all of it.

## 8. Installation identity (designed, not applied)

A pairing credential binds one device row to one account; an installation is
the copy of USAGE Miner on a computer and outlives credentials. 0.4.2 mints a
random `installation.json` id and sends it when pairing. The server-side
half — `miner_devices.installation_id text null`, and `approve()` reusing the
caller's unrevoked device row with the same installation id instead of
inserting — is a schema change and waits for approval like every other one.
Until then a re-pair creates a new device row; the website marks older live
pairings "previous pairing" and never deletes them. A deliberate sign-out and
sign-in to a different account is a new association by design.
