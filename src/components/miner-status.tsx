import Link from "next/link";
import type { MinerDistribution } from "@/lib/miner/distribution";
import { UPDATE_COPY, type MinerPresence } from "@/lib/miner/presence";

/**
 * The miner, as the rest of the site sees it: not installed, offline, online.
 *
 * Shared so the dashboard and the providers page cannot disagree, and so the
 * rule about not selling a download to someone already mining lives in one
 * place. The states differ in what they ask for, not just in colour:
 *
 *   none     -- install it; that is the whole message
 *   offline  -- what happened, and the two things that fix it
 *   online   -- which computer, which build, when it last spoke
 */

function DownloadButton({ label }: { label: string }) {
  return (
    <Link
      href="/download"
      className="inline-block rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
    >
      {label}
    </Link>
  );
}

function UpdateNotice({ presence }: { presence: MinerPresence }) {
  const copy = UPDATE_COPY[presence.update];
  if (!copy.label) return null;
  const urgent = presence.update === "update_required";
  return (
    <div className="mt-3 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2">
      <p
        className="text-[10px] uppercase tracking-[0.12em]"
        style={{ color: urgent ? "var(--warn)" : "var(--routed)" }}
      >
        {copy.label}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{copy.detail}</p>
      <Link
        href="/download"
        className="mt-2 inline-block text-[11px] text-[var(--routed)] hover:underline"
      >
        Download the current build →
      </Link>
    </div>
  );
}

export function MinerStatus({
  presence,
  distribution,
}: {
  presence: MinerPresence;
  distribution: MinerDistribution;
}) {
  if (presence.state === "none") {
    return (
      <div>
        <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">
          Not installed
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
          USAGE Miner runs on the computer where you use AI. It finds the tools already installed,
          starts them through USAGE, and your compute is verified as you work.
        </p>
        <div className="mt-3">
          <DownloadButton label="Download for Windows" />
        </div>
      </div>
    );
  }

  const device = presence.device;

  if (presence.state === "offline") {
    return (
      <div>
        <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">
          Offline
          {presence.lastSeenLabel ? ` · last seen ${presence.lastSeenLabel}` : ""}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
          {device?.name} is not reporting. The app is probably closed — it does not start with
          Windows, by design. Nothing is lost while it is off; compute simply is not observed.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link
            href={device ? `/miners/${device.id}` : "/miners"}
            className="rounded-md border border-[var(--border-strong)] px-4 py-2 text-xs text-[var(--muted)] hover:border-[var(--verified)] hover:text-[var(--foreground)]"
          >
            Open troubleshooting
          </Link>
          <DownloadButton label="Download latest version" />
        </div>
        <UpdateNotice presence={presence} />
      </div>
    );
  }

  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--verified)" }}>
        ● Online
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
        <dt className="text-[var(--faint)]">Device</dt>
        <dd>
          {device ? (
            <Link href={`/miners/${device.id}`} className="hover:underline">
              {device.name}
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-[var(--faint)]">Version</dt>
        <dd className="tnum">
          {device?.version ?? "unknown"}
          {presence.update === "current" ? (
            <span className="ml-2 text-[10px] text-[var(--faint)]">current</span>
          ) : null}
        </dd>
        <dt className="text-[var(--faint)]">Last heartbeat</dt>
        <dd>{presence.lastSeenLabel ?? "—"}</dd>
      </dl>
      <UpdateNotice presence={presence} />
      {presence.update === "current" && distribution.source === "pinned" && (
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--faint)]">
          Release metadata could not be read just now, so this compares against the last build known
          to be published.
        </p>
      )}
    </div>
  );
}

/**
 * The step after connecting a provider.
 *
 * A connected provider is not mining, and a page that implies otherwise is
 * making a promise the account cannot keep. This says what is missing and only
 * appears while it is actually missing.
 */
export function InstallMinerNextStep({ presence }: { presence: MinerPresence }) {
  if (presence.state === "online") return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
        Next: install USAGE Miner
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
        A connected provider makes mining possible; it does not start it. USAGE Miner routes the
        desktop AI tools already on your computer — Claude Code and Codex — through the provider you
        just connected, so their compute can be verified.
        {presence.state === "offline" ? " Your miner is currently offline." : ""}
      </p>
      <div className="mt-3">
        <DownloadButton label="Download Miner for Windows" />
      </div>
    </div>
  );
}
