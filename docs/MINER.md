# USAGE Miner — Windows beta

The miner exists so that using AI can be verified without anyone configuring
anything. The measure of success for this milestone is a sentence, not a
feature list:

> Download → install → sign in → enable mining → use AI.

No npm. No PowerShell. No terminal. No copied token. No base URL. No headers.

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
| `~/.claude/settings.json`, `~/.codex/config.toml` | Routing settings, when mining is on | Restored, if you say yes |

No service. No scheduled task. No autostart. No administrator rights, ever —
per-user install, `HKCU` only.

The credential is encrypted with Windows DPAPI at `CurrentUser` scope: another
account on the same machine cannot read it, and a copied file is useless
elsewhere. It is never written to a config file, never printed, and never
logged. The log has an allowlist of fields and scrubs anything token-shaped as a
last line of defence.

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
4. **Enable mining** for each tool it found. If a tool already points somewhere
   custom, it says so and asks before replacing it — and backs up what was there.
5. **Use your AI tool normally.**

### Error states, and what the user actually sees

| Situation | What happens |
|---|---|
| Not signed in | The window offers Sign in. Nothing else is enabled. |
| No provider connected | "Connect a provider" instead of an enable button. |
| Device revoked at `/miners` | The account panel shows the server's rejection; mining stops working because the token no longer authenticates. |
| Offline | "Could not reach USAGE. Check your connection." Local state still renders. |
| Tool not installed | Listed, greyed, no action. |
| Tool points at a foreign endpoint | Shown as a conflict; Enable becomes Replace, behind a confirmation naming the current endpoint. |
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
| Verifiable automated build on GitHub-hosted runners | **Prepared** — `.github/workflows/release-miner.yml`, currently manual-dispatch and unsigned |
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
