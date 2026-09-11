import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MINER_PREPARED_VERSION,
  MINER_RELEASE,
  MINER_RELEASE_TAG,
  MINER_VERSION,
  downloadUrl,
  formatBytes,
  primaryDownload,
} from "./release";
import { compareVersions } from "./distribution";

/**
 * The release manifest is what the download page promises about bytes it does
 * not itself serve. If it drifts from the build, the page tells people to
 * verify a checksum that cannot match -- which is worse than publishing none,
 * because it trains them to ignore a mismatch.
 */

const HEX_64 = /^[0-9a-f]{64}$/;

describe("miner release manifest", () => {
  it("never advertises a version the miner workspace has not reached", () => {
    // The published manifest may lag the workspace while a version is in
    // development (0.4.0 built and tested, not yet released); it must never
    // lead it, because that would be a download link to bytes that do not
    // exist. Compared numerically, not as strings.
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "miner", "package.json"), "utf8"),
    ) as { version: string };
    const parts = (v: string) => v.split(".").map(Number);
    const [a, b] = [parts(MINER_VERSION), parts(pkg.version)];
    const published = a[0] * 1e6 + a[1] * 1e3 + a[2];
    const workspace = b[0] * 1e6 + b[1] * 1e3 + b[2];
    expect(published).toBeLessThanOrEqual(workspace);
  });

  it("publishes a real checksum for every artifact", () => {
    expect(MINER_RELEASE.files.length).toBeGreaterThan(0);
    for (const file of MINER_RELEASE.files) {
      expect(file.sha256, file.name).toMatch(HEX_64);
      expect(file.bytes, file.name).toBeGreaterThan(1_000_000);
      expect(file.name).toContain(MINER_VERSION);
    }
  });

  it("names no two artifacts the same", () => {
    const names = MINER_RELEASE.files.map((file) => file.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("records the runtime the artifact contains", () => {
    // A hash means nothing without knowing what was hashed. The artifact IS a
    // Node build with our script injected, so the Node version is part of it.
    expect(MINER_RELEASE.nodeVersion).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(Number.isNaN(Date.parse(MINER_RELEASE.builtAt))).toBe(false);
  });

  it("never claims to be signed while it is not", () => {
    // The one field that must not quietly become true. Flipping it requires a
    // real certificate and a real signing step, not an edit here.
    expect(MINER_RELEASE.signed).toBe(false);
    expect(MINER_RELEASE.signingNote).toMatch(/not code-signed/i);
  });

  it("publishes under a tag that names this version", () => {
    // The tag is set by hand when a release is cut. If it stops matching the
    // manifest, every download link on the site points at the wrong build --
    // or at nothing.
    expect(MINER_RELEASE_TAG).toContain(MINER_VERSION);
    expect(MINER_RELEASE_TAG.startsWith("v")).toBe(true);
    // A beta must not be published under a tag that reads like a stable one.
    expect(MINER_RELEASE.channel).toBe("beta");
    expect(MINER_RELEASE_TAG).toMatch(/beta/);
  });

  it("offers the installer as the primary download", () => {
    const primary = primaryDownload();
    expect(primary?.name).toMatch(/setup/i);
  });
});

describe("the prepared version", () => {
  it("is a version and nothing else", () => {
    // Never a size, a date or a checksum. Those are facts about bytes and may
    // only come from the release that carries them.
    expect(MINER_PREPARED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is never behind the build this server can already offer", () => {
    // It marks a build that exists but is not published yet, so it may lead
    // the pinned fallback and must never trail it -- that would be a notice
    // telling people a newer build is coming when it is already here.
    expect(compareVersions(MINER_PREPARED_VERSION, MINER_VERSION)).toBeGreaterThanOrEqual(0);
  });
});

describe("downloadUrl", () => {
  const original = process.env.USAGE_MINER_DOWNLOAD_BASE;
  afterEach(() => {
    if (original === undefined) delete process.env.USAGE_MINER_DOWNLOAD_BASE;
    else process.env.USAGE_MINER_DOWNLOAD_BASE = original;
  });

  it("points at the release for this exact version by default", () => {
    delete process.env.USAGE_MINER_DOWNLOAD_BASE;
    const file = MINER_RELEASE.files[0]!;
    const url = downloadUrl(file);
    expect(url.startsWith("https://")).toBe(true);
    expect(url).toContain(MINER_VERSION);
    expect(url.endsWith(file.name)).toBe(true);
  });

  it("can be repointed for a fork or a staging build", () => {
    process.env.USAGE_MINER_DOWNLOAD_BASE = "https://downloads.example/miner";
    const file = MINER_RELEASE.files[0]!;
    expect(downloadUrl(file)).toBe(`https://downloads.example/miner/${file.name}`);
  });
});

describe("formatBytes", () => {
  it("reads as a download size, not a byte count", () => {
    expect(formatBytes(91_582_976)).toBe("87 MB");
  });
});
