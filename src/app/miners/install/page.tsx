import Link from "next/link";
import { AppNav, PrivacyNote } from "@/components/product";
import { Panel } from "@/components/ui";
import {
  MINER_RELEASE,
  downloadUrl,
  formatBytes,
  primaryDownload,
  type MinerReleaseFile,
} from "@/lib/miner/release";

export const dynamic = "force-static";

/**
 * Download USAGE Miner.
 *
 * The whole page is arranged around one sentence: download, install, sign in,
 * enable, use AI. No command to copy, no token to paste, no base URL, no
 * header. Anything that reads like configuration has failed the brief.
 *
 * It is also honest in the places that matter. The build is unsigned, so
 * Windows will warn; that warning is correct and the page says so, next to the
 * checksum that lets someone check the bytes rather than trust the label.
 */

const STEPS = [
  {
    title: "Download and open it",
    body: "A per-user install. No administrator rights, no service, and it does not start with Windows.",
  },
  {
    title: "Sign in",
    body: "The app opens your browser, you approve the device, and it finishes on its own. There is no key to copy.",
  },
  {
    title: "Turn on mining",
    body: "It finds the AI tools already installed on your machine. One click each.",
  },
  {
    title: "Use AI normally",
    body: "Nothing else to do. Your compute is measured and verified as you work.",
  },
];

function Checksum({ file }: { file: MinerReleaseFile }) {
  return (
    <div className="border-t border-[var(--border)] pt-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[11px] font-medium">{file.name}</span>
        <span className="tnum text-[11px] text-[var(--muted)]">{formatBytes(file.bytes)}</span>
      </div>
      <code className="tnum mt-1 block overflow-x-auto text-[10px] leading-relaxed break-all text-[var(--muted)]">
        {file.sha256}
      </code>
      {!file.reproducible && (
        <p className="mt-1 text-[10px] text-[var(--muted)]">
          Rebuilding this wrapper yields a different hash — the in-box Windows C# compiler stamps a
          fresh module id into every build. The miner executable it contains does rebuild
          byte-for-byte.
        </p>
      )}
    </div>
  );
}

export default function InstallMinerPage() {
  const primary = primaryDownload();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6">
      <AppNav />

      <h1 className="text-3xl font-medium tracking-tight">USAGE Miner</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Points the AI tools already on your computer at USAGE, so the compute you were going to use
        anyway can be verified. Windows, version {MINER_RELEASE.version}.
      </p>

      {primary ? (
        <div className="mt-6">
          <a
            href={downloadUrl(primary)}
            className="inline-block rounded-md bg-[var(--foreground)] px-5 py-2.5 text-sm font-medium text-[var(--background)]"
          >
            Download for Windows
          </a>
          <p className="mt-2 text-[11px] text-[var(--muted)]">
            {primary.name} · {formatBytes(primary.bytes)} · Windows 10 and 11, 64-bit
          </p>
        </div>
      ) : (
        <p className="mt-6 text-xs text-[var(--muted)]">No build is published yet.</p>
      )}

      <div className="mt-8 space-y-3">
        <Panel title="What happens">
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

        <Panel title="Windows will warn you, and it is right to">
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            This build is not code-signed — USAGE has no code-signing certificate yet — so
            SmartScreen shows &ldquo;unrecognised publisher&rdquo;. Treat every unsigned download
            with suspicion, including this one. What you can check instead is the file itself:
            compare its SHA-256 against the value below before you run it.
          </p>
          <code className="mt-2 block overflow-x-auto rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
            certutil -hashfile {primary?.name ?? "USAGE-Miner.exe"} SHA256
          </code>
        </Panel>

        <Panel title="Checksums">
          <div className="space-y-3">
            {MINER_RELEASE.files.map((file) => (
              <Checksum key={file.name} file={file} />
            ))}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--muted)]">
            Built {new Date(MINER_RELEASE.builtAt).toISOString().slice(0, 10)} on Node{" "}
            {MINER_RELEASE.nodeVersion}, which is embedded in the artifact. The same manifest is
            served at{" "}
            <Link href="/api/miner/release" className="text-[var(--routed)] hover:underline">
              /api/miner/release
            </Link>
            .
          </p>
        </Panel>

        <Panel title="What it does to your machine">
          <ul className="space-y-2 text-[11px] leading-relaxed text-[var(--muted)]">
            <li>
              Installs to <code>%LOCALAPPDATA%\Programs\USAGE Miner</code> and adds one Start Menu
              entry. Nothing outside your own user account is touched.
            </li>
            <li>
              Turning on mining changes two settings in the AI tool&apos;s own config file. What was
              there is backed up first, and turning mining off puts it back exactly.
            </li>
            <li>
              Stores this device&apos;s credential encrypted with Windows DPAPI, scoped to your user
              account. It is never written to a config file, never printed, and never logged.
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

        <Panel title="Prefer the source?">
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            The miner is in the repository under <code>miner/</code>, and{" "}
            <code>npm run package</code> rebuilds this executable. It is byte-for-byte reproducible:
            a build from the same source on the same Node version hashes to the value above.
          </p>
        </Panel>
      </div>

      <div className="mt-6 space-y-3">
        <PrivacyNote />
        <Link href="/miners" className="inline-block text-xs text-[var(--routed)] hover:underline">
          ← My miners
        </Link>
      </div>
    </main>
  );
}
