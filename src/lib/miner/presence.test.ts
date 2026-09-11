import { describe, expect, it } from "vitest";
import type { DeviceView } from "./device-view";
import { UPDATE_COPY, formatLastSeen, minerPresence } from "./presence";
import type { MinerDeviceRow } from "@/lib/supabase/database.types";

/**
 * M16D §6: the dashboard says one of three things, and stops selling a
 * download to someone who is already mining.
 */

const NOW = Date.parse("2026-09-11T12:00:00Z");

function view(overrides: {
  id?: string;
  name?: string;
  version?: string;
  lastSeenAt?: string | null;
  online?: boolean;
  revoked?: boolean;
  previousPairing?: boolean;
}): DeviceView {
  const device = {
    id: overrides.id ?? "device-1",
    user_id: "user-1",
    name: overrides.name ?? "DESKTOP-DENIS",
    platform: "win32",
    app_version: overrides.version ?? "0.4.5",
    credential_id: null,
    enabled_tools: [],
    public_key: null,
    public_key_algorithm: null,
    public_key_registered_at: null,
    os: "Windows 11",
    tool_state: [],
    last_usage_event_at: null,
    device_trust_level: "attested",
    created_at: "2026-09-01T00:00:00Z",
    last_seen_at: overrides.lastSeenAt === undefined ? "2026-09-11T11:59:00Z" : overrides.lastSeenAt,
    revoked_at: overrides.revoked ? "2026-09-10T00:00:00Z" : null,
  } satisfies MinerDeviceRow;

  return {
    device,
    online: overrides.online ?? true,
    revoked: overrides.revoked ?? false,
    previousPairing: overrides.previousPairing ?? false,
    attested: true,
    tools: [],
    today: {} as DeviceView["today"],
    lastUsageEventAt: null,
  };
}

const base = { latestVersion: "0.4.5", minimumVersion: "0.3.0", now: NOW };

describe("minerPresence", () => {
  it("offers the download when no device has ever paired", () => {
    const presence = minerPresence({ devices: [], ...base });
    expect(presence.state).toBe("none");
    expect(presence.showDownloadCta).toBe(true);
    expect(presence.device).toBeNull();
  });

  it("does not count a revoked pairing as a computer", () => {
    const presence = minerPresence({ devices: [view({ revoked: true })], ...base });
    expect(presence.state).toBe("none");
  });

  it("does not count a superseded pairing of the same computer", () => {
    const presence = minerPresence({ devices: [view({ previousPairing: true })], ...base });
    expect(presence.state).toBe("none");
  });

  it("says offline, and when it was last seen", () => {
    const presence = minerPresence({
      devices: [view({ online: false, lastSeenAt: "2026-09-11T09:00:00Z" })],
      ...base,
    });
    expect(presence.state).toBe("offline");
    expect(presence.lastSeenLabel).toBe("3 hours ago");
    // Reinstalling is a real answer to "it stopped running".
    expect(presence.showDownloadCta).toBe(true);
  });

  it("stops offering a download once a current miner is online", () => {
    const presence = minerPresence({ devices: [view({})], ...base });
    expect(presence.state).toBe("online");
    expect(presence.update).toBe("current");
    expect(presence.showDownloadCta).toBe(false);
  });

  it("prefers the online device over a more recently seen offline one", () => {
    const presence = minerPresence({
      devices: [
        view({ id: "offline", name: "OLD-PC", online: false, lastSeenAt: "2026-09-11T11:59:59Z" }),
        view({ id: "online", name: "THIS-PC", online: true, lastSeenAt: "2026-09-11T11:50:00Z" }),
      ],
      ...base,
    });
    expect(presence.state).toBe("online");
    expect(presence.device?.name).toBe("THIS-PC");
  });

  it("offers an update to an online miner, without taking over the page", () => {
    const presence = minerPresence({ devices: [view({ version: "0.4.4" })], ...base });
    expect(presence.update).toBe("update_available");
    expect(presence.showDownloadCta).toBe(false);
    expect(UPDATE_COPY[presence.update].label).toBe("Update available");
  });

  it("does shout when the build is below what this server supports", () => {
    const presence = minerPresence({ devices: [view({ version: "0.2.0" })], ...base });
    expect(presence.update).toBe("update_required");
    expect(presence.showDownloadCta).toBe(true);
  });

  it("says nothing to someone running a build newer than anything published", () => {
    // The owner's own machine while 0.4.5 sat unpublished.
    const presence = minerPresence({
      devices: [view({ version: "0.4.5" })],
      latestVersion: "0.3.0",
      minimumVersion: "0.3.0",
      now: NOW,
    });
    expect(presence.update).toBe("ahead");
    expect(UPDATE_COPY.ahead.label).toBeNull();
    expect(presence.showDownloadCta).toBe(false);
  });
});

describe("formatLastSeen", () => {
  it("reads as a sentence, not a timestamp", () => {
    expect(formatLastSeen("2026-09-11T11:59:30Z", NOW)).toBe("just now");
    expect(formatLastSeen("2026-09-11T11:48:00Z", NOW)).toBe("12 minutes ago");
    expect(formatLastSeen("2026-09-11T11:00:00Z", NOW)).toBe("1 hour ago");
    expect(formatLastSeen("2026-09-08T12:00:00Z", NOW)).toBe("3 days ago");
  });

  it("has nothing to say about a device never seen", () => {
    expect(formatLastSeen(null, NOW)).toBeNull();
    expect(formatLastSeen("not a date", NOW)).toBeNull();
  });
});
