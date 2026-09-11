import type { DeviceView } from "./device-view";
import { updateState, type UpdateState } from "./distribution";

/**
 * Which of three things to say about the miner: not installed, offline, or
 * online.
 *
 * One function rather than a condition per page, because the dashboard, the
 * providers page and the download page must agree. The rule that actually
 * matters is the last one: once a current miner is online, the page stops
 * shouting about downloading it. A permanent install button on an account
 * that is already mining is noise, and noise is what people learn to skip.
 *
 * Revoked pairings are never the answer. A revoked device is a row kept for
 * history, not a computer that will come back.
 */

export type MinerPresenceState = "none" | "offline" | "online";

export interface MinerPresenceDevice {
  id: string;
  name: string;
  /** As last reported by the device itself -- a claim, not a fact. */
  version: string | null;
  lastSeenAt: string | null;
}

export interface MinerPresence {
  state: MinerPresenceState;
  device: MinerPresenceDevice | null;
  update: UpdateState;
  /** "4 minutes ago", or null when it has never been seen. */
  lastSeenLabel: string | null;
  /** Whether a page should lead with a download button. */
  showDownloadCta: boolean;
}

function seenAt(view: DeviceView): number {
  return view.device.last_seen_at ? Date.parse(view.device.last_seen_at) : 0;
}

export function minerPresence(input: {
  devices: readonly DeviceView[];
  latestVersion: string;
  minimumVersion: string;
  now?: number;
}): MinerPresence {
  const now = input.now ?? Date.now();
  const live = input.devices.filter((view) => !view.revoked && !view.previousPairing);

  const chosen =
    live.find((view) => view.online) ??
    [...live].sort((a, b) => seenAt(b) - seenAt(a))[0] ??
    null;

  if (!chosen) {
    return { state: "none", device: null, update: "unknown", lastSeenLabel: null, showDownloadCta: true };
  }

  const device: MinerPresenceDevice = {
    id: chosen.device.id,
    name: chosen.device.name,
    version: chosen.device.app_version || null,
    lastSeenAt: chosen.device.last_seen_at,
  };

  const update = updateState({
    installed: device.version,
    latest: input.latestVersion,
    minimum: input.minimumVersion,
  });

  const online = chosen.online;

  return {
    state: online ? "online" : "offline",
    device,
    update,
    lastSeenLabel: formatLastSeen(device.lastSeenAt, now),
    // Offline still offers the download, because "reinstall it" is a real
    // answer to "it stopped running". Online does not -- unless the build is
    // too old for this server to accept, which is the one case where getting a
    // new one is the whole point.
    showDownloadCta: !online || update === "update_required",
  };
}

/** "just now", "12 minutes ago", "3 days ago". Null when never seen. */
export function formatLastSeen(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export const UPDATE_COPY: Record<UpdateState, { label: string | null; detail: string | null }> = {
  current: { label: null, detail: null },
  update_available: {
    label: "Update available",
    detail: "A newer build is published. Your miner keeps working until you install it.",
  },
  update_required: {
    label: "Update required",
    detail: "This build is older than USAGE supports. Install the current one to keep mining.",
  },
  // Deliberately silent. A build newer than anything published is normal for
  // whoever is testing the next one, and nagging them would be wrong.
  ahead: { label: null, detail: null },
  unknown: { label: null, detail: null },
};
