import {
  MINER_RELEASE,
  MINER_RELEASE_TAG,
  MINER_SOURCE_REPOSITORY,
  type MinerReleaseManifest,
} from "./release";

/**
 * Which miner build the website may offer, and what its bytes hash to.
 *
 * The manifest compiled into this server (`release.generated.ts`) was written
 * by the miner's packaging script back when the miner lived in this
 * repository. It does not any more, so a compiled constant can only describe a
 * build this deployment happened to be cut alongside -- which is how the site
 * came to advertise 0.3.0 while the miner was at 0.4.5.
 *
 * The direction of the dependency is inverted here: the site reads what a
 * published GitHub release actually contains. A version, a size and a checksum
 * are facts about bytes somebody can download, and the only honest source for
 * them is the release those bytes are attached to.
 *
 * Two rules follow, and both are tested:
 *
 *   1. NEVER show a checksum that did not come from the same release as the
 *      download link beside it. A hash that cannot match teaches people that a
 *      mismatch is probably nothing.
 *   2. A draft release is not a download. Drafts are invisible to everyone but
 *      the owner, so a page built from one offers a 404 to every reader.
 *
 * When no release can be read -- none published, GitHub unreachable, rate
 * limited -- this falls back to the last build that IS downloadable and says
 * so in `source`. It never invents a newer one.
 */

export type DistributionSource = "release" | "pinned";

export interface DistributionFile {
  name: string;
  bytes: number;
  /** Lowercase hex, from the release itself. Null when the release states none. */
  sha256: string | null;
  /** Whether rebuilding from the same source yields these exact bytes. */
  reproducible: boolean;
  url: string;
}

export interface MinerDistribution {
  source: DistributionSource;
  product: string;
  version: string;
  tag: string;
  channel: string;
  platform: string;
  /** When the release was published; null for the pinned fallback. */
  publishedAt: string | null;
  prerelease: boolean;
  signed: boolean;
  signingNote: string;
  nodeVersion: string | null;
  files: DistributionFile[];
  /** The installer, which is what a person should download. */
  setup: DistributionFile | null;
  releaseUrl: string;
  /**
   * `/releases/latest/download/<asset>` -- stable across versions, so it can be
   * printed in documentation. GitHub resolves it only for the release marked
   * latest, and a prerelease is never that, so this is null for a prerelease.
   */
  stableUrl: string | null;
}

/**
 * Published asset names, deliberately without a version in them.
 *
 * A versioned name means every release changes every link. A stable name means
 * `releases/latest/download/<name>` keeps working, which is the only kind of
 * URL worth printing in documentation. What the file IS stays knowable: the
 * version is in the tag, in the PE version resource, and in release.json.
 */
export const SETUP_ASSET = "USAGE-Miner-Windows-x64-Setup.exe";
export const STANDALONE_ASSET = "USAGE-Miner-Windows-x64.exe";
export const CHECKSUMS_ASSET = "SHA256SUMS.txt";
export const MANIFEST_ASSET = "release.json";

/** Hosts a release asset may be fetched from. Nothing else is followed. */
const ASSET_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export interface GitHubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** `sha256:<hex>` on assets uploaded since GitHub began recording it. */
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  assets: GitHubReleaseAsset[];
}

/** `0.4.5` from `v0.4.5`, and from `v0.4.5-beta.2`. */
export function versionFromTag(tag: string): string {
  const withoutPrefix = tag.replace(/^v/, "");
  const [version] = withoutPrefix.split("-");
  return version ?? withoutPrefix;
}

/** -1, 0, 1. Numeric per segment, so 0.10.0 is above 0.9.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    versionFromTag(value)
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export type UpdateState =
  /** Running the published build. */
  | "current"
  /** Older than what is published, but still supported. */
  | "update_available"
  /** Below the minimum this server supports. */
  | "update_required"
  /** Newer than anything published -- a local build, or an unpublished one. */
  | "ahead"
  | "unknown";

/**
 * What to tell someone about the build they are running.
 *
 * The version comes from a device's own heartbeat, so it is a claim rather
 * than a fact, and it decides only which words a page shows. Whether an old
 * build may still route requests is decided server-side against
 * `MINIMUM_MINER_VERSION` -- never here.
 */
export function updateState(input: {
  installed: string | null | undefined;
  latest: string;
  minimum: string;
}): UpdateState {
  if (!input.installed) return "unknown";
  if (compareVersions(input.installed, input.minimum) < 0) return "update_required";
  const against = compareVersions(input.installed, input.latest);
  if (against < 0) return "update_available";
  if (against > 0) return "ahead";
  return "current";
}

/** `sha256sum` output: `<hex>  <name>`, one per line. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (match) out.set(match[2]!, match[1]!.toLowerCase());
  }
  return out;
}

function digestOf(asset: GitHubReleaseAsset): string | null {
  const digest = asset.digest ?? null;
  if (!digest) return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  return match ? match[1]!.toLowerCase() : null;
}

function isSetup(asset: { name: string }): boolean {
  return asset.name.toLowerCase().includes("setup");
}

/** Only assets that are a download, in a stable order: installer first. */
function downloadable(assets: readonly GitHubReleaseAsset[]): GitHubReleaseAsset[] {
  return assets
    .filter((asset) => asset.name.toLowerCase().endsWith(".exe"))
    .sort((a, b) => Number(isSetup(b)) - Number(isSetup(a)));
}

/**
 * The newest release a visitor could actually download.
 *
 * Drafts are excluded because nobody but the owner can see them. Prereleases
 * are included -- the miner is beta, and excluding them would leave the site
 * with nothing to offer.
 */
export function selectRelease(releases: readonly GitHubRelease[]): GitHubRelease | null {
  const candidates = releases.filter(
    (release) => !release.draft && downloadable(release.assets).length > 0,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, release) => {
    const a = Date.parse(release.published_at ?? "") || 0;
    const b = Date.parse(newest.published_at ?? "") || 0;
    if (a !== b) return a > b ? release : newest;
    return compareVersions(release.tag_name, newest.tag_name) > 0 ? release : newest;
  });
}

/**
 * The build to offer when no release can be read.
 *
 * The compiled manifest, published under the platform repository before the
 * miner had one of its own. Those assets still exist at those URLs, so this is
 * a real download rather than a placeholder -- just an older one.
 */
export function pinnedDistribution(
  manifest: MinerReleaseManifest = MINER_RELEASE,
): MinerDistribution {
  const repository = "https://github.com/Deniscoke/USAGE";
  const files: DistributionFile[] = manifest.files.map((file) => ({
    name: file.name,
    bytes: file.bytes,
    sha256: file.sha256,
    reproducible: file.reproducible,
    url: `${repository}/releases/download/${MINER_RELEASE_TAG}/${file.name}`,
  }));
  return {
    source: "pinned",
    product: manifest.product,
    version: manifest.version,
    tag: MINER_RELEASE_TAG,
    channel: manifest.channel,
    platform: manifest.platform,
    publishedAt: null,
    prerelease: true,
    signed: manifest.signed,
    signingNote: manifest.signingNote,
    nodeVersion: manifest.nodeVersion,
    files,
    setup: files.find((file) => isSetup(file)) ?? files[0] ?? null,
    releaseUrl: `${repository}/releases/tag/${MINER_RELEASE_TAG}`,
    stableUrl: null,
  };
}

/** Whether a release asset URL may be fetched. GitHub's own hosts, nothing else. */
export function isAssetUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ASSET_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * A `release.json` asset as read from a release.
 *
 * Partial because it is data from outside this codebase: an older release
 * carries fewer fields, and a future one may carry more. Nothing here is
 * trusted for anything but display.
 */
export type MinerReleaseManifestLike = Partial<MinerReleaseManifest>;

export interface ResolveInput {
  release: GitHubRelease | null;
  /** `release.json` from the same release, when it carries one. */
  manifest?: MinerReleaseManifestLike | null;
  /** `SHA256SUMS.txt` from the same release. */
  checksums?: string | null;
}

/**
 * Turn one published release into what the site shows.
 *
 * Every checksum comes from the release being described: its own manifest
 * first, then its checksum file, then the digest GitHub recorded on upload. A
 * checksum from anywhere else -- including the manifest compiled into this
 * server -- would describe different bytes than the link beside it.
 */
export function resolveDistribution(input: ResolveInput): MinerDistribution {
  const { release } = input;
  if (!release) return pinnedDistribution();

  const manifest = input.manifest ?? null;
  const sums = input.checksums ? parseChecksums(input.checksums) : new Map<string, string>();
  const manifestFiles = new Map((manifest?.files ?? []).map((file) => [file.name, file] as const));
  const version = manifest?.version ?? versionFromTag(release.tag_name);

  const files: DistributionFile[] = downloadable(release.assets).map((asset) => {
    const stated = manifestFiles.get(asset.name);
    return {
      name: asset.name,
      bytes: stated?.bytes ?? asset.size,
      sha256: stated?.sha256?.toLowerCase() ?? sums.get(asset.name) ?? digestOf(asset),
      // Unknown means not reproducible, not "probably fine".
      reproducible: stated?.reproducible ?? false,
      url: asset.browser_download_url,
    };
  });

  const setup = files.find((file) => isSetup(file)) ?? files[0] ?? null;

  return {
    source: "release",
    product: manifest?.product ?? "USAGE Miner",
    version,
    tag: release.tag_name,
    channel: manifest?.channel ?? (release.prerelease ? "beta" : "stable"),
    platform: manifest?.platform ?? "win32-x64",
    publishedAt: release.published_at,
    prerelease: release.prerelease,
    // Signed is never inferred. A release says so only if its own manifest
    // does, and that manifest is rewritten by the workflow after Authenticode
    // verification -- not by anything a human types.
    signed: manifest?.signed === true,
    signingNote:
      manifest?.signingNote ??
      "Not code-signed. Windows SmartScreen will warn about an unrecognised publisher. Verify the SHA-256 before running.",
    nodeVersion: manifest?.nodeVersion ?? null,
    files,
    setup,
    releaseUrl: release.html_url,
    stableUrl:
      !release.prerelease && setup && setup.name === SETUP_ASSET
        ? `${MINER_SOURCE_REPOSITORY}/releases/latest/download/${SETUP_ASSET}`
        : null,
  };
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** `11 September 2026`, or null. A build date is only useful if it reads as one. */
export function formatReleaseDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
