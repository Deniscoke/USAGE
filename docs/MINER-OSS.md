# Splitting the miner into a public repository

The miner has to be public before it can be signed, and it ought to be public
regardless: it is a program that holds a credential, edits your AI tools'
configuration, and talks to a server on your behalf. Asking people to trust that
without letting them read it is asking for something we would not give.

**Done.** The miner now lives at
[github.com/Deniscoke/USAGE-Miner](https://github.com/Deniscoke/USAGE-Miner) —
public, Apache-2.0, with its own CI and release workflow. This document is kept
as the record of how the boundary was drawn and what was checked.

`miner/` is still present in this repository and still builds. It is not deleted
until the public repository has produced a signed release; until then this is
the fallback, and the two are kept in step by hand.

---

## 1. The boundary

The dividing line is not "what is secret" — most of the backend is unremarkable.
It is **what an attacker gains by reading it**.

Reading the miner tells you how a credential is stored and what a device may do.
That knowledge does not help you: DPAPI is not weaker for being understood, and
the scopes are enforced server-side. Reading the reward engine tells you exactly
what to fabricate to earn points you did not earn. One of those is safe to
publish and the other is not.

### PUBLIC — `USAGE-Miner`

| Component | Why it is safe, and why it should be public |
|---|---|
| `src/api.ts` | HTTP client for documented endpoints. Publishes nothing not already in the API. |
| `src/secrets.ts` | DPAPI storage. Security by obscurity would be the alternative, and it is not security. |
| `src/tools/*` | Adapters that edit Claude Code and Codex configuration. **This is the code most deserving of scrutiny** — it writes to files users own. |
| `src/cli.ts`, `src/ui.ts`, `src/ui-page.ts` | Launcher and local window, including the loopback guards. |
| `src/migrate.ts` | Cleanup of the pre-0.3.0 plaintext credential. |
| `src/log.ts` | The allowlist that decides what may be written to a log file. |
| `scripts/package.mjs`, `scripts/installer.mjs` | Reproducible build and installer. Required for SignPath's origin verification, and required for anyone to check our checksums. |
| `.github/workflows/release.yml`, `ci.yml` | The build SignPath verifies, and a fork-safe CI that holds no secrets. |

### PRIVATE — `USAGE`

| Component | Why it stays private |
|---|---|
| `src/lib/protocol/reward-policy.ts`, `emission.ts` | Publishing the exact reward function publishes the exact shape of an optimal farm. |
| `src/lib/pricing/**` | Pricing snapshots decide what compute is worth. |
| `src/lib/db/reconciliation.ts`, fraud status | Detection logic that is useless once evaded. |
| `src/lib/secrets/**`, `src/lib/providers/connections.ts` | Provider credential storage. |
| Receipt signing key handling | The root of trust. Never in a repository at all. |
| Epoch settlement, dashboard, ingestion | Server-side, and of no use to a client. |

**A published reward policy is a published exploit.** Everything else about
proofs stays verifiable: the receipt format, the signature, and the public keys
are already open at `/api/receipts/keys`, so anyone can check that a proof is
genuine without being able to compute what it is worth.

---

## 2. The contract between them

The miner may use **only** these, and they must be documented and versioned:

```
POST /api/miner/pair                 start device pairing
POST /api/miner/pair/poll            collect the credential once approved
POST /api/miner/credential/rotate    replace this device's credential
GET  /api/miner/config               routing configuration for this device
POST /api/miner/heartbeat            liveness and which tools are active
GET  /api/miner/release              current version and checksums
POST /api/gateway/provider/<id>/**   route a request through a connection
POST /api/gateway/anthropic/**       route through USAGE's own gateway
GET  /api/receipts/keys              public verification keys
```

Rules that make the split real rather than cosmetic:

* **No build-time dependency on private source.** `miner/` already imports
  nothing from `src/` — verified by the build, which bundles only from
  `miner/src`. That property is what makes the move mechanical.
* **`miner-protocol-v1` is a contract.** Breaking it needs a new version and a
  `minimumMinerVersion` bump, because an old public build must keep working.
* **The server never sends anything that decides what runs.** Routing values
  only: a URL, a protocol, a connection id. A public miner makes this checkable
  by anyone, which is the point.
* **The build no longer writes into the platform repository.** It used to
  generate `src/lib/miner/release.generated.ts`; now `release.json` beside the
  binaries is the manifest, published as a release asset. The dependency points
  one way: the site consumes what the build produced.

---

## 3. How it was actually moved

`git subtree split` was rejected in favour of `git filter-repo`, which is what
GitHub documents for this and which can also drop paths. The reason mattered:
`miner/node_modules` had been committed once and removed later, so a subtree
split would have carried thousands of third-party blobs into a new public
repository.

```bash
git clone --no-local <platform> USAGE-Miner && cd USAGE-Miner
python -m git_filter_repo --path miner/ --path-rename miner/:      # keep only the miner, at the root
python -m git_filter_repo --path node_modules/ --invert-paths --force
```

Six commits survived, 22 files, 57 blobs across all of history.

**Every blob in every commit was then scanned** for API keys, JWTs, Supabase and
Vercel tokens, GitHub tokens, AWS keys, private-key blocks, credentials embedded
in URLs, and Postgres connection strings — and for filenames like `.env`, `*.pem`
and `credential.dpapi` ever having existed. Nothing was found. The scan reports
paths, never values, so running it cannot itself leak anything.

The first attempt at the filter did the opposite of what was intended —
`--invert-paths` applies to *all* `--path` arguments, so it kept the entire
private platform and dropped the miner. It was caught by inspecting the result
before doing anything with it, which is the only reason to inspect.

Commit messages were kept verbatim. Several describe changes that spanned both
halves — a migration, a reward-policy fix — but they contain no algorithm and no
secret, and everything they state is already public on the site. Rewriting them
to hide that a change touched two components would have been less honest, not
more careful.

Then, in this repository — **still outstanding**:

1. Replace `miner/` with a README pointing at the new one.
2. Take `USAGE_MINER_DOWNLOAD_BASE` from the new repository's releases.
3. Fetch `release.json` from the release asset rather than importing a generated
   file. The miner's build no longer writes into this repository, so this is the
   remaining half of that change.
4. Keep `docs/MINER.md` here; it describes the product, not the code.

**Do not delete `miner/` until the public repository has produced a signed
release.** Until then this repository is the fallback.

### What the split proved

The standalone executable built in the new repository hashes to
`74a0dcb9…` — and so does the one built by the GitHub-hosted Windows runner on
CI. Same source, two machines, identical bytes. That is what makes a signature
worth having: it attests to a file anyone can independently reconstruct.

---

## 4. Licence

**Apache-2.0**, chosen deliberately over MIT for two clauses MIT lacks:

* **Patent grant (§3).** Contributors grant patent rights, and lose them if they
  sue over the software. MIT is silent, which leaves a contributor free to
  contribute and then assert a patent.
* **Trademark reservation (§6).** Anyone may fork the miner; nobody gets the
  USAGE name. That matters more than usual here — this program holds a
  credential and talks to a provider on a user's behalf, so being able to tell
  whose build you are running is a security property, not branding.

`LICENSE` and `NOTICE` are in `miner/` and travel with the subtree.

**The Apache licence covers `miner/` only.** The platform is separate and
private; `NOTICE` says so, so a reader cannot mistake one for the other.

---

## 5. SignPath requirements, as they actually read

Taken from SignPath Foundation's own terms rather than assumed. Mandatory
unless marked otherwise.

| Requirement | Status |
|---|---|
| OSI-approved licence, no commercial dual-licensing | **Met** — Apache-2.0 |
| No proprietary, non-open-source component | **Met** — the private platform is a separate repository reached only over HTTP |
| Actively maintained | Met |
| Already released in the form to be signed | **Met** — `v0.3.0-beta.1` |
| Functionality described on the download page | Met — `/miners/install` and the README |
| No malware or unwanted programs | Met |
| Team maintains the repository and does its own signing | Met |
| Only artifacts built from own source and build scripts | **Met** — release builds come from a GitHub-hosted runner; a local build is never published |
| No features designed to identify or exploit vulnerabilities | Not applicable |
| Data collection described in a privacy policy, shown at install, disableable | **Partly** — described in the README, on the download page, and in the app; the installer dialog does not yet state it, and it is disableable only by not enabling mining |
| Must not modify system configuration without proper warnings | Met — every change is announced, backed up and reversible |
| Uninstall facility | Met |
| **Multi-factor authentication** on SignPath and the source repository, for all team members | **Owner action** — explicitly required by the terms |
| Author / reviewer / approver roles defined | Owner action |
| **Code signing policy page** on the project homepage, listing team members and roles, with privacy details and SignPath attribution | **Not written** — explicitly required by the terms |
| Signed binaries carry enforced product name and version metadata | **Met as of 0.3.1** — both executables previously identified as "Node.js / node.exe" |
| Every release manually approved for signing | Built into SignPath |

MFA and the code-signing policy page are quoted requirements in SignPath's
terms, not inferences.

### GitHub origin verification

The SignPath GitHub App confirms that a build was performed by a GitHub
workflow rather than by something holding an API token; that the origin metadata
comes from GitHub rather than the build script, so it cannot be forged; that the
artifact was stored as a workflow artifact before submission; and, for
open-source projects, that every job leading to the signing request ran on
GitHub-hosted agents. `release.yml` satisfies all four, and additionally
validates the ref before touching a secret so a signing credential is never
handed to a run that was not going to produce a release.
