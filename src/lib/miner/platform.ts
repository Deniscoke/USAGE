/**
 * Is this visitor on the platform the miner runs on?
 *
 * Used for one thing: telling a Mac or Linux visitor, before they download 87
 * megabytes, that this build will not run for them. It is not a gate. The
 * download stays on the page and stays clickable, because a user agent is a
 * string a browser chooses to send and plenty of good reasons exist to fetch a
 * Windows installer from something that is not Windows.
 */

export type VisitorPlatform = "windows" | "other" | "unknown";

export function detectPlatform(userAgent: string | null | undefined): VisitorPlatform {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  // Windows on ARM reports "Windows NT" too, and the miner is x64 only -- but
  // x64 emulation is transparent on those machines, so it is not worth a
  // separate warning.
  if (ua.includes("windows nt") || ua.includes("win64") || ua.includes("windows phone")) {
    return "windows";
  }
  if (/mac os x|macintosh|android|linux|iphone|ipad|cros/.test(ua)) return "other";
  return "unknown";
}

/** The one sentence a non-Windows visitor needs. */
export const OTHER_PLATFORM_NOTE =
  "USAGE Miner is currently available for Windows. The download below is a Windows 10 and 11 installer; macOS and Linux builds do not exist yet.";
