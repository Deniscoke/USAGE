import type { Metadata } from "next";
import Link from "next/link";
import { CopyCommand } from "@/components/copy-command";
import { PlatformNote } from "@/components/miner-download";
import { Panel } from "@/components/ui";
import { MINER_SOURCE_REPOSITORY } from "@/lib/miner/release";
import { NPM_PACKAGE_NAME, NPX_COMMAND, loadNpmPackage } from "@/lib/miner/npm-package";

/**
 * Get USAGE Miner.
 *
 * One way in: a command. The Windows installer and standalone executable are
 * unsigned, so SmartScreen stops every first-time user on them -- correctly --
 * and there is no honest way around that until a signing identity exists and
 * has reputation. `npx` removes the reason for the warning instead of asking
 * people to click through it: nothing unknown is executed, the code runs under
 * the node.exe they already trust, and npm checks its integrity.
 *
 * So this page no longer offers the .exe files at all. They still exist on the
 * GitHub release for anyone who goes looking; the site does not send a newcomer
 * into a warning dialog. The version shown is read from the npm registry, so
 * the page never offers a command that fails for the person who types it.
 */

export const revalidate = 900;

export const metadata: Metadata = {
  title: "Get USAGE Miner",
  description:
    "Use AI normally. USAGE verifies eligible compute. One command starts USAGE Miner on Windows, with no installer and no warning dialog.",
};

const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

const STEPS = [
  {
    title: "Run the command",
    body: "In PowerShell or Terminal. It downloads the current release from npm and opens the USAGE Miner window. Nothing is installed system-wide.",
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
    body: "Your dashboard fills in as you work. Run the same command whenever you want to mine again; it always starts the newest release.",
  },
];

const TRUST = [
  {
    title: "Open source, with provenance",
    body: "Apache-2.0. Every npm version is published by a GitHub-hosted workflow with a provenance attestation, so anyone can check which commit produced it.",
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
    title: "Only eligible verified compute earns",
    body: "Free compute, unpriced models and self-reported usage are measured where possible and earn nothing.",
  },
];

export default async function DownloadPage() {
  const npm = await loadNpmPackage();

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

      <h1 className="text-3xl font-medium tracking-tight">Get USAGE Miner</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Use AI normally. USAGE verifies eligible compute. One command, no installer, no warning
        dialog.
      </p>

      {npm.published ? (
        <div className="mt-6">
          <p className="text-[11px] text-[var(--muted)]">Paste into PowerShell or Terminal:</p>
          <div className="mt-2">
            <CopyCommand command={NPX_COMMAND} label="Start USAGE Miner" />
          </div>
          <p className="tnum mt-2 text-[11px] text-[var(--muted)]">
            Windows 10 / 11 · version {npm.version} on npm
          </p>
          <PlatformNote />

          <p className="mt-4 text-[11px] leading-relaxed text-[var(--muted)]">
            Needs Node.js 20 or newer. No Node yet?{" "}
            <a href={NODE_DOWNLOAD_URL} className="text-[var(--routed)] hover:underline">
              Install the LTS from nodejs.org
            </a>
            , open a new terminal window, then run the command.
          </p>
        </div>
      ) : (
        <p className="mt-6 text-xs text-[var(--muted)]">
          USAGE Miner is not published yet. This page shows the command the moment it is.
        </p>
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

        <Panel title="Why a command and not a download">
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            USAGE has no code-signing certificate yet, so any .exe it offered would stop you at a
            Windows SmartScreen warning — and Windows would be right to ask. The command removes the
            reason for that warning rather than hiding it: nothing unknown is executed, the code runs
            under the node.exe you already trust, and npm checks its integrity on the way.
          </p>
          {npm.published && (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
              Prefer a permanent command? <code>npm install -g {NPM_PACKAGE_NAME}</code>, then{" "}
              <code>usage</code>. Update it later with the same install command.
            </p>
          )}
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

        <Panel title="What it does to your machine">
          <ul className="space-y-2 text-[11px] leading-relaxed text-[var(--muted)]">
            <li>
              Its sign-in and settings live in <code>%APPDATA%\USAGE</code>. Nothing outside your own
              user account is touched, and nothing needs administrator rights.
            </li>
            <li>
              <strong>Your AI tools are started by USAGE, not reconfigured by it.</strong> The routing
              lives in the environment of the session it launches and is gone when you close the tool;
              your own sign-in is left alone and no credential touches your disk.
            </li>
            <li>
              The one exception is a switch you turn on yourself: &ldquo;Measure Claude Code
              everywhere&rdquo; adds telemetry-only settings to <code>~/.claude/settings.json</code>{" "}
              and puts back what was there when you turn it off.
            </li>
            <li>
              The device credential can only route requests, read its own configuration, send a
              heartbeat and replace itself. It cannot change account settings, read a provider key,
              create a proof, or alter a reward.
            </li>
            <li>No service, no scheduled task, and it does not start with Windows.</li>
          </ul>
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--faint)]">
            You will never be asked to paste an API key, a credential, a token or an environment
            variable. If something asks you to, it is not USAGE.
          </p>
        </Panel>

        <Panel title="Source">
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            <a href={MINER_SOURCE_REPOSITORY} className="text-[var(--routed)] hover:underline">
              USAGE Miner on GitHub
            </a>{" "}
            — the code, release notes and build workflow.{" "}
            {npm.published && (
              <>
                <a
                  href={`https://www.npmjs.com/package/${NPM_PACKAGE_NAME}`}
                  className="text-[var(--routed)] hover:underline"
                >
                  The npm package
                </a>{" "}
                shows each version&apos;s provenance.
              </>
            )}
          </p>
        </Panel>
      </div>

      <p className="mt-6 text-[11px] leading-relaxed text-[var(--faint)]">
        Beta. USAGE Points are off-chain, non-transferable and carry no monetary value. USAGE
        measures compute metadata; we do not store your prompts or AI responses.
      </p>
    </main>
  );
}
