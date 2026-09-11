"use client";

import { useSyncExternalStore } from "react";
import { OTHER_PLATFORM_NOTE, detectPlatform, type VisitorPlatform } from "@/lib/miner/platform";

/**
 * "This is a Windows installer", said only to the people it helps.
 *
 * Client-side on purpose. The download page is otherwise cacheable for
 * everyone, and varying a whole page on a user-agent header to add one
 * sentence would cost every visitor a personalised render. So the page ships
 * the same HTML to everybody -- download button included -- and this note
 * appears afterwards for a visitor whose browser is not Windows.
 *
 * It never hides the download. Someone on a Mac fetching an installer for the
 * PC in the next room is doing something reasonable.
 *
 * `useSyncExternalStore` rather than an effect: the platform is a value that
 * exists on the client and not on the server, which is exactly what the server
 * snapshot argument is for. Nothing here ever changes after the first read, so
 * the subscribe function has nothing to subscribe to.
 */

const neverChanges = () => () => {};
const onServer = (): VisitorPlatform => "unknown";
const onClient = (): VisitorPlatform => detectPlatform(navigator.userAgent);

export function PlatformNote() {
  const platform = useSyncExternalStore(neverChanges, onClient, onServer);

  if (platform !== "other") return null;

  return (
    <p
      role="status"
      className="mt-3 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]"
    >
      {OTHER_PLATFORM_NOTE}
    </p>
  );
}
