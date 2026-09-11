import type { Metadata } from "next";
import Link from "next/link";
import { PlatformNote } from "@/components/miner-download";
import { Panel } from "@/components/ui";
import { loadDistribution } from "@/lib/miner/distribution-source";
import {
  compareVersions,
  formatBytes,
  formatReleaseDate,
  type DistributionFile,
  type MinerDistribution,
} from "@/lib/miner/distribution";
import { MINER_PREPARED_VERSION, MINER_SOURCE_REPOSITORY } from "@/lib/miner/release";
import { NPM_PACKAGE_NAME, NPX_COMMAND, loadNpmPackage } from "@/lib/miner/npm-package";

/**
 * Download USAGE Miner.
 *
 * The official way to get the miner. Nobody should have to find a CI artifact,
 * understand what an artifact is, or know that GitHub Actions exists -- so
 * everything this page says comes from a published release, and if there
 * isn't one, it says that too rather than pointing at a build only the owner
 * can see.
 *
 * The page is arranged around one sentence: download, install, sign in,
 * connect a provider, use AI. No command to copy, no token to paste, no base
 * URL, no header. Anything that reads like configuration has failed the brief.
 *
 * It is also honest where it matters. The build is unsigned, so Windows will
 * warn; that warning is correct, and the page says so next to the checksum
 * that lets someone check the bytes instead of trusting the label. It does not
 * tell anyone to turn SmartScreen off.
 */

export const revalidate = 900;

export const metadata: Metadata = {
  title: "Download USAGE Miner for Windows",
  description:
    "Use AI normally. USAGE verifies eligible compute. A Windows app that routes the AI tools already on your machine through USAGE.",
};

const STEPS = [
  {
    title: "Install Miner",
    body: "A per-user install. No administrator rights, no service, and it does not start with Windows.",
  },
  {
    title: "Sign in to USAGE",
    body: "The app opens your browser, you approve this PC, and it finishes on its own. There is no key to copy.",
  },
  {
    title: "Connect an eligible AI provider",
    body: "Your own provider account, connected once on the website. Connecting is not yet earning -- it is what makes earning possible.",
  },
  {
    title: "Start your AI tool with USAGE",
    body: "Claude Code and Codex are launched by the app, one click each, so the routing lives in that session and nowhere else.",
  },
  {
    title: "Watch verified compute live",
    body: "Your dashboard fills in as you work. Nothing else to do.",
  },
];

const TRUST = [
  {
    title: "Open source",
    body: "Apache-2.0, built by a GitHub-hosted workflow from a commit anyone can read.",
  },
  {
    title: "No provider key on your PC",
    body: "Your provider credential stays on USAGE's servers. The app never receives it and never writes it to a file.",
  },
  {
    title: "The device credential stays local",
    body: "Encrypted with Windows DPAPI and scoped to your user account. It is never printed and never logged.",
  },
  {
    title: "Compute, not conversations",
    body: "USAGE records models, token counts and timestamps. Prompts, responses, tool arguments and source code are not recorded.",
  },
  {
    title: "Local metadata is not verified compute",
    body: "What the app observes on your machine is shown separately from what USAGE routed and verified itself. They are never added together.",
  },
  {
    title: "Only eligible verified compute earns",
    body: "Free compute, unpriced models and self-reported usage are measured where possible and earn nothing.",
  },
];

function SigningBadge({ distribution }: { distribution: MinerDistribution }) {
  if (distribution.signed) {
    return (
      <span className="rounded-sm border border-[var(--verified)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--verified)]">
        Signed Windows build
      </span>
    );
  }
  return (
    <span className="rounded-sm border border-[var(--border-strong)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">
      Beta · unsigned build
    </span>
  );
}

function Checksum({ file }: { file: DistributionFile }) {
  return (
    <div className="border-t border-[var(--border)] pt-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[11px] font-medium">{file.name}</span>
        <span className="tnum text-[11px] text-[var(--muted)]">{formatBytes(file.bytes)}</span>
      </div>
      {file.sha256 ? (
        <code className="tnum mt-1 block overflow-x-auto text-[10px] leading-relaxed break-all text-[var(--muted)]">
          {file.sha256}
        </code>
      ) : (
        <p className="mt-1 text-[10px] text-[var(--muted)]">
          This release published no checksum for this file.
        </p>
      )}
      {!file.reproducible && (
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--muted)]">
          Rebuilding the installer yields a different hash — the in-box Windows C# compiler stamps a
          fresh module id into every build. The miner executable it contains does rebuild
          byte-for-byte.
        </p>
      )}
    </div>
  );
}

export default async function DownloadPage() {
  const [distribution, npm] = await Promise.all([loadDistribution(), loadNpmPackage()]);
  const setup = distribution.setup;
  const releaseDate = formatReleaseDate(distribution.publishedAt);
  // True only while a newer build exists that nobody can download yet.
  const preparedAhead = compareVersions(MINER_PREPARED_VERSION, distribution.version) > 0;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="tnum text-sm font-medium tracking-[0.3em]">
          USAGE
        </Link>
        <Link
          href="/sign-up"
          className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--verified)] hover:text-[var(--foreground)]"
        >
          Create an account
        </Link>
      </header>

      <h1 className="text-3xl font-medium tracking-tight">USAGE Miner for Windows</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Use AI normally. USAGE verifies eligible compute.
      </p>

      {setup ? (
        <div className="mt-6">
          <a
            href={setup.url}
            className="inline-block rounded-md bg-[var(--foreground)] px-5 py-2.5 text-sm font-medium text-[var(--background)]"
          >
            Download for Windows
          </a>
          <p className="tnum mt-2 text-[11px] text-[var(--muted)]">
            Windows 10 / 11 · x64 · version {distribution.version} · {formatBytes(setup.bytes)}
            {releaseDate ? ` · released ${releaseDate}` : ""}
          </p>
          <div className="mt-3">
            <SigningBadge distribution={distribution} />
          </div>
          <PlatformNote />
        </div>
      ) : (
        <p className="mt-6 text-xs text-[var(--muted)]">No build is published yet.</p>
      )}

      {preparedAhead && (
        <p className="mt-4 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
          Version {MINER_PREPARED_VERSION} is built and waiting to be published. Until it is, this
          page offers {distribution.version} — the newest build that actually exists at a public
          URL. This notice disappears by itself when {MINER_PREPARED_VERSION} is released.
        </p>
      )}

      {npm.published && (
        <Panel className="mt-8" title="Already have Node? Skip the installer">
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            One command opens the same window, and Windows shows no warning — not because the
            warning was suppressed, but because nothing unknown is executed. The code runs under the
            node.exe you already have, and npm checks its integrity.
          </p>
          <code className="mt-2 block overflow-x-auto rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
            {NPX_COMMAND}
          </code>
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--faint)]">
            Version {npm.version} on npm, published straight from the build workflow with a
            provenance attestation, so anyone can check which commit and which run produced it.
            Windows only.{" "}
            <a
              href={`https://www.npmjs.com/package/${NPM_PACKAGE_NAME}`}
              className="text-[var(--routed)] hover:underline"
            >
              Package
            </a>
            .
          </p>
        </Panel>
      )}

      <div className="mt-8 space-y-3">
        <Panel title="How it works">
          <ol className="space-y-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span className="tnum mt-0.5 text-[11px] text-[var(--muted)]">{index + 1}</span>
                <span>
                  <span className="block text-xs font-medium">{step.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--muted)]">
                    {step.body}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>

        <Panel title="What you are trusting">
          <ul className="space-y-2.5">
            {TRUST.map((item) => (
              <li key={item.title}>
                <span className="block text-xs font-medium">{item.title}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--muted)]">
                  {item.body}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        {!distribution.signed && (
          <Panel title="Windows will warn you, and it is right to">
            <p className="text-[11px] leading-relaxed text-[var(--muted)]">
              This beta installer is not code-signed — USAGE has no code-signing certificate yet —
              so SmartScreen shows &ldquo;unrecognised publisher&rdquo;. Treat every unsigned
              download with suspicion, including this one. What you can check instead is the file
              itself: compare its SHA-256 against the value below before you run it.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
              Signing, when it arrives, will let this page name a publisher rather than ask you to
              check a hash. It is not a promise that Windows will stop asking: SmartScreen weighs a
              publisher&apos;s reputation as well as its identity, and a new certificate has none.
            </p>
            <code className="mt-2 block overflow-x-auto rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
              certutil -hashfile {setup?.name ?? "USAGE-Miner-Windows-x64-Setup.exe"} SHA256
            </code>
          </Panel>
        )}

        <Panel title="Checksums">
          <div className="space-y-3">
            {distribution.files.map((file) => (
              <Checksum key={file.name} file={file} />
            ))}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--muted)]">
            {distribution.nodeVersion
              ? `Built on Node ${distribution.nodeVersion}, which is embedded in the artifact. `
              : ""}
            Every figure here is read from{" "}
            <a href={distribution.releaseUrl} className="text-[var(--routed)] hover:underline">
              release {distribution.tag}
            </a>{" "}
            itself, and the same values are served at{" "}
            <Link href="/api/miner/distribution" className="text-[var(--routed)] hover:underline">
              /api/miner/distribution
            </Link>
            .
          </p>
        </Panel>

        <Panel title="After installation">
          <ol className="space-y-1.5 text-[11px] leading-relaxed text-[var(--muted)]">
            <li>1. Open USAGE Miner.</li>
            <li>2. Click Sign in.</li>
            <li>3. Approve this PC in the browser tab that opens.</li>
            <li>4. Return to the Miner.</li>
            <li>5. Select Start with USAGE on the AI tool you want to use.</li>
          </ol>
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--faint)]">
            You will never be asked to paste an API key, a credential, a token or an environment
            variable. If something asks you to, it is not USAGE.
          </p>
        </Panel>

        <Panel title="What it does to your machine">
          <ul className="space-y-2 text-[11px] leading-relaxed text-[var(--muted)]">
            <li>
              Installs to <code>%LOCALAPPDATA%\Programs\USAGE Miner</code> and adds one Start Menu
              entry. Nothing outside your own user account is touched.
            </li>
            <li>
              <strong>Claude Code is started by USAGE, not configured by it.</strong> The routing
              lives in that session&apos;s environment and is gone when you close the tool — nothing
              is written to your Claude Code settings, your own sign-in is left alone, and no
              credential touches your disk.
            </li>
            <li>
              Codex is configured instead, because its config file can name a credential
              (<code>env_key</code>) rather than contain one. What was there is backed up first, and
              turning mining off puts it back exactly.
            </li>
            <li>
              The device credential can only route requests, read its own configuration, send a
              heartbeat and replace itself. There is no ability to change account settings, read a
              provider key, create a proof, or alter a reward — not disabled, not expressible.
            </li>
            <li>
              If a tool already points at a custom endpoint, the app stops and asks rather than
              overwriting it.
            </li>
            <li>
              Uninstalling offers to restore every tool&apos;s original settings first. Your saved
              sign-in in <code>%APPDATA%\USAGE</code> is kept unless you ask for it to go.
            </li>
            <li>No service, no scheduled task, and it does not start with Windows.</li>
          </ul>
        </Panel>

        <Panel title="Advanced">
          <ul className="space-y-2 text-[11px] leading-relaxed text-[var(--muted)]">
            {distribution.files
              .filter((file) => file.name !== setup?.name)
              .map((file) => (
                <li key={file.name}>
                  <a href={file.url} className="text-[var(--routed)] hover:underline">
                    {file.name}
                  </a>{" "}
                  — the standalone executable, {formatBytes(file.bytes)}. No installer, no Start Menu
                  entry, nothing written outside your profile. Run it and it opens the same window.
                </li>
              ))}
            {distribution.stableUrl && (
              <li>
                <code className="break-all">{distribution.stableUrl}</code> — a URL that always
                resolves to the current installer, for scripted installs.
              </li>
            )}
            <li>
              <a href={distribution.releaseUrl} className="text-[var(--routed)] hover:underline">
                Release {distribution.tag}
              </a>{" "}
              — notes, every asset, and <code>SHA256SUMS.txt</code>.
            </li>
            <li>
              <a href={MINER_SOURCE_REPOSITORY} className="text-[var(--routed)] hover:underline">
                Source
              </a>{" "}
              — Apache-2.0, in its own repository, and <code>npm run package</code> rebuilds it.
            </li>
          </ul>
        </Panel>
      </div>

      <p className="mt-6 text-[11px] leading-relaxed text-[var(--faint)]">
        Beta. USAGE Points are off-chain, non-transferable and carry no monetary value. USAGE
        measures compute metadata; we do not store your prompts or AI responses.
      </p>
    </main>
  );
}
