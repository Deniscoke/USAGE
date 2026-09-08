import Link from "next/link";
import { AppNav, PrivacyNote } from "@/components/product";
import { Panel } from "@/components/ui";
import { MINER_VERSION } from "@/lib/miner/release";

export const dynamic = "force-static";

/**
 * Installing the miner.
 *
 * Honest about what this beta is: a small command-line program, unsigned,
 * Windows-only. Saying so is better than a polished page that gets a
 * SmartScreen warning nobody was warned about.
 */
export default function InstallMinerPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6">
      <AppNav />

      <h1 className="text-3xl font-medium tracking-tight">Install USAGE Miner</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        USAGE Miner points your AI tools at USAGE so their compute can be verified. It signs in
        through your browser, so there is no key to copy.
      </p>

      <div className="mt-8 space-y-3">
        <Panel title={`Windows · version ${MINER_VERSION}`}>
          <ol className="list-decimal space-y-3 pl-4 text-xs leading-relaxed text-[var(--muted)]">
            <li>
              Install it from the repository:
              <code className="mt-1.5 block overflow-x-auto rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
                git clone https://github.com/Deniscoke/USAGE &amp;&amp; cd USAGE/miner &amp;&amp;
                npm install &amp;&amp; npm run build &amp;&amp; npm link
              </code>
            </li>
            <li>
              Connect this machine to your account:
              <code className="mt-1.5 block rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
                usage sign-in
              </code>
              It shows a short code and opens this site. Approve the device, and it finishes on its
              own.
            </li>
            <li>
              Turn on mining for a tool:
              <code className="mt-1.5 block rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
                usage enable claude-code
              </code>
            </li>
            <li>Use your AI tool exactly as before.</li>
          </ol>
        </Panel>

        <Panel title="What it does to your machine">
          <ul className="space-y-2 text-[11px] leading-relaxed text-[var(--muted)]">
            <li>
              Adds two settings to your tool&apos;s own config file so it sends requests to USAGE.
              The previous contents are backed up first, and{" "}
              <code className="tnum">usage disable</code> puts them back exactly.
            </li>
            <li>
              Stores its credential encrypted with Windows DPAPI, scoped to your user account. It is
              never written to a config file or printed.
            </li>
            <li>
              If a tool already points somewhere custom, it stops and asks rather than overwriting.
            </li>
            <li>
              Prefer not to change anything at all? <code className="tnum">usage run claude-code</code>{" "}
              starts the tool with USAGE for that session only.
            </li>
          </ul>
        </Panel>

        <Panel title="Beta, and unsigned">
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            This build is not code-signed: USAGE has no code-signing certificate yet, so Windows may
            warn about an unrecognised publisher. That warning is correct, and you should treat any
            unsigned download with suspicion. Installing from source, as above, is why the
            instructions look the way they do.
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
