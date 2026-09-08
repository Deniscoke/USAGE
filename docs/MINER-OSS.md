# Splitting the miner into a public repository

The miner has to be public before it can be signed, and it ought to be public
regardless: it is a program that holds a credential, edits your AI tools'
configuration, and talks to a server on your behalf. Asking people to trust that
without letting them read it is asking for something we would not give.

This document is the plan. **Nothing has been moved.** `miner/` is still in this
repository and still builds from here.

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
| `.github/workflows/release-miner.yml` | The build SignPath verifies. |

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
* **One shared constant crosses today:** `src/lib/miner/release.generated.ts` is
  written by the miner's build and read by the website. After the split, the
  website reads it from the release's `release.json` asset instead.

---

## 3. Moving it, when the plan is approved

```bash
# History matters: the migration commits explain why the launcher exists.
git subtree split --prefix=miner -b miner-only
# push miner-only to the new repository's main
```

Then, in this repository:

1. Replace `miner/` with a README pointing at the new one.
2. Take `USAGE_MINER_DOWNLOAD_BASE` from the new repository's releases.
3. Fetch `release.json` from the release rather than importing a generated file.
4. Keep `docs/MINER.md` here; it describes the product, not the code.

**Do not delete `miner/` until the public repository has produced a release that
matches a local build's checksum.** Until then this repository is the fallback.

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
