import { describe, expect, it } from "vitest";
import {
  CHECKSUMS_ASSET,
  MANIFEST_ASSET,
  SETUP_ASSET,
  STANDALONE_ASSET,
  compareVersions,
  formatBytes,
  formatReleaseDate,
  isAssetUrlAllowed,
  parseChecksums,
  pinnedDistribution,
  resolveDistribution,
  selectRelease,
  updateState,
  versionFromTag,
  type GitHubRelease,
} from "./distribution";
import { MINIMUM_MINER_VERSION } from "./release";

/**
 * M16D: what the download page is allowed to say.
 *
 * The page makes two promises a visitor cannot check for themselves -- this
 * link gives you these bytes, and those bytes hash to this value. Everything
 * here exists so those two can never come from different places.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function release(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: "v0.4.5",
    draft: false,
    prerelease: true,
    published_at: "2026-09-11T10:00:00Z",
    html_url: "https://github.com/Deniscoke/USAGE-Miner/releases/tag/v0.4.5",
    assets: [
      {
        name: SETUP_ASSET,
        size: 91_678_208,
        browser_download_url: `https://github.com/Deniscoke/USAGE-Miner/releases/download/v0.4.5/${SETUP_ASSET}`,
      },
      {
        name: STANDALONE_ASSET,
        size: 91_660_800,
        browser_download_url: `https://github.com/Deniscoke/USAGE-Miner/releases/download/v0.4.5/${STANDALONE_ASSET}`,
      },
      {
        name: CHECKSUMS_ASSET,
        size: 182,
        browser_download_url: `https://github.com/Deniscoke/USAGE-Miner/releases/download/v0.4.5/${CHECKSUMS_ASSET}`,
      },
    ],
    ...overrides,
  };
}

describe("selectRelease", () => {
  it("ignores a draft, because nobody but the owner can download one", () => {
    // The exact state of v0.4.5 while this was written: built, attached to a
    // draft, invisible to every visitor. Offering it would be a 404 with a
    // version number on it.
    expect(selectRelease([release({ draft: true })])).toBeNull();
  });

  it("ignores a release with nothing to download", () => {
    expect(selectRelease([release({ assets: [] })])).toBeNull();
  });

  it("takes the newest published release, prereleases included", () => {
    const older = release({ tag_name: "v0.3.0-beta.1", published_at: "2026-09-08T00:00:00Z" });
    const newer = release({ tag_name: "v0.4.5", published_at: "2026-09-11T10:00:00Z" });
    expect(selectRelease([older, newer])?.tag_name).toBe("v0.4.5");
    expect(selectRelease([newer, older])?.tag_name).toBe("v0.4.5");
  });

  it("falls back to the version when two releases share a timestamp", () => {
    const a = release({ tag_name: "v0.4.5", published_at: "2026-09-11T10:00:00Z" });
    const b = release({ tag_name: "v0.10.0", published_at: "2026-09-11T10:00:00Z" });
    expect(selectRelease([a, b])?.tag_name).toBe("v0.10.0");
  });
});

describe("resolveDistribution", () => {
  it("offers the installer, from the release the checksum came from", () => {
    const resolved = resolveDistribution({
      release: release(),
      checksums: `${HASH_A}  ${SETUP_ASSET}\n${HASH_B}  ${STANDALONE_ASSET}\n`,
    });
    expect(resolved.source).toBe("release");
    expect(resolved.version).toBe("0.4.5");
    expect(resolved.setup?.name).toBe(SETUP_ASSET);
    expect(resolved.setup?.sha256).toBe(HASH_A);
    expect(resolved.setup?.url).toContain("/releases/download/v0.4.5/");
    // The checksum file is metadata, not a download offered to a person.
    expect(resolved.files.map((file) => file.name)).not.toContain(CHECKSUMS_ASSET);
  });

  it("prefers the release's own manifest over every other source", () => {
    const resolved = resolveDistribution({
      release: release(),
      manifest: {
        version: "0.4.5",
        nodeVersion: "v24.13.1",
        files: [{ name: SETUP_ASSET, bytes: 91_678_208, sha256: HASH_A, reproducible: false }],
      },
      checksums: `${HASH_B}  ${SETUP_ASSET}\n`,
    });
    expect(resolved.setup?.sha256).toBe(HASH_A);
    expect(resolved.nodeVersion).toBe("v24.13.1");
  });

  it("reads the digest GitHub recorded when the release states no checksum", () => {
    const withDigest = release();
    withDigest.assets[0]!.digest = `sha256:${HASH_A}`;
    expect(resolveDistribution({ release: withDigest }).setup?.sha256).toBe(HASH_A);
  });

  it("says it does not know a checksum rather than inventing one", () => {
    const resolved = resolveDistribution({ release: release() });
    expect(resolved.setup?.sha256).toBeNull();
  });

  it("never borrows a checksum from the compiled manifest", () => {
    // The bug this whole module exists to prevent: 0.3.0's hashes shown
    // beside a 0.4.5 download link.
    const pinned = pinnedDistribution();
    const resolved = resolveDistribution({ release: release() });
    const pinnedHashes = new Set(pinned.files.map((file) => file.sha256));
    for (const file of resolved.files) {
      expect(pinnedHashes.has(file.sha256 ?? "")).toBe(false);
    }
  });

  it("never claims to be signed unless the release's manifest says so", () => {
    expect(resolveDistribution({ release: release() }).signed).toBe(false);
    expect(resolveDistribution({ release: release(), manifest: { signed: false } }).signed).toBe(false);
    expect(resolveDistribution({ release: release(), manifest: { signed: true } }).signed).toBe(true);
  });

  it("offers no stable latest URL for a prerelease, because GitHub resolves none", () => {
    // `releases/latest/download/...` skips prereleases entirely. Publishing
    // that link for one would be a 404 in the documentation.
    expect(resolveDistribution({ release: release({ prerelease: true }) }).stableUrl).toBeNull();
  });

  it("offers the stable latest URL once a release is the repository's latest", () => {
    const resolved = resolveDistribution({ release: release({ prerelease: false }) });
    expect(resolved.stableUrl).toBe(
      `https://github.com/Deniscoke/USAGE-Miner/releases/latest/download/${SETUP_ASSET}`,
    );
    expect(resolved.channel).toBe("stable");
  });

  it("offers no stable URL while the installer still carries a versioned name", () => {
    const versioned = release({
      prerelease: false,
      assets: [
        {
          name: "USAGE-Miner-0.4.5-Setup.exe",
          size: 91_678_208,
          browser_download_url: "https://github.com/Deniscoke/USAGE-Miner/releases/download/v0.4.5/USAGE-Miner-0.4.5-Setup.exe",
        },
      ],
    });
    expect(resolveDistribution({ release: versioned }).stableUrl).toBeNull();
  });

  it("falls back to a build that really is downloadable when there is no release", () => {
    const resolved = resolveDistribution({ release: null });
    expect(resolved.source).toBe("pinned");
    expect(resolved.setup?.url).toContain(resolved.tag);
    expect(resolved.setup?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseChecksums", () => {
  it("reads the format sha256sum and certutil users already know", () => {
    const map = parseChecksums(`${HASH_A}  ${SETUP_ASSET}\n${HASH_B} *${STANDALONE_ASSET}\n\n`);
    expect(map.get(SETUP_ASSET)).toBe(HASH_A);
    expect(map.get(STANDALONE_ASSET)).toBe(HASH_B);
  });

  it("ignores anything that is not a checksum line", () => {
    expect(parseChecksums("not a hash  file.exe\n# comment\n").size).toBe(0);
  });
});

describe("isAssetUrlAllowed", () => {
  it("follows GitHub's own hosts and nothing else", () => {
    expect(isAssetUrlAllowed(`https://github.com/x/y/releases/download/v1/${CHECKSUMS_ASSET}`)).toBe(true);
    expect(isAssetUrlAllowed("https://objects.githubusercontent.com/blob")).toBe(true);
    expect(isAssetUrlAllowed("https://evil.example/SHA256SUMS.txt")).toBe(false);
    expect(isAssetUrlAllowed("http://github.com/x")).toBe(false);
    expect(isAssetUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isAssetUrlAllowed("not a url")).toBe(false);
  });
});

describe("versions", () => {
  it("reads a version out of a tag", () => {
    expect(versionFromTag("v0.4.5")).toBe("0.4.5");
    expect(versionFromTag("v0.3.0-beta.1")).toBe("0.3.0");
  });

  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.4.5", "0.4.5")).toBe(0);
    expect(compareVersions("0.4.4", "0.4.5")).toBe(-1);
  });
});

describe("updateState", () => {
  const latest = "0.4.5";
  const minimum = MINIMUM_MINER_VERSION;

  it("says nothing about a device that has not reported a version", () => {
    expect(updateState({ installed: null, latest, minimum })).toBe("unknown");
  });

  it("offers an update to an older supported build", () => {
    expect(updateState({ installed: "0.4.4", latest, minimum })).toBe("update_available");
  });

  it("requires an update below the minimum this server supports", () => {
    expect(updateState({ installed: "0.2.0", latest, minimum })).toBe("update_required");
  });

  it("leaves a current build alone", () => {
    expect(updateState({ installed: "0.4.5", latest, minimum })).toBe("current");
  });

  it("does not nag a build newer than anything published", () => {
    // Exactly the owner's machine today: 0.4.5 installed, 0.3.0 published.
    expect(updateState({ installed: "0.4.5", latest: "0.3.0", minimum })).toBe("ahead");
  });
});

describe("presentation", () => {
  it("reads sizes as a download size", () => {
    expect(formatBytes(91_678_208)).toBe("87 MB");
  });

  it("reads a release date as a date", () => {
    expect(formatReleaseDate("2026-09-11T10:00:00Z")).toBe("11 September 2026");
    expect(formatReleaseDate(null)).toBeNull();
    expect(formatReleaseDate("not a date")).toBeNull();
  });

  it("names the manifest asset the workflow publishes", () => {
    expect(MANIFEST_ASSET).toBe("release.json");
  });
});
