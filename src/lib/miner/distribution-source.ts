import { MINER_SOURCE_REPOSITORY } from "./release";
import {
  CHECKSUMS_ASSET,
  MANIFEST_ASSET,
  isAssetUrlAllowed,
  pinnedDistribution,
  resolveDistribution,
  selectRelease,
  type GitHubRelease,
  type MinerDistribution,
  type MinerReleaseManifestLike,
} from "./distribution";

/**
 * Reading the miner's published releases.
 *
 * The only network call the website makes to GitHub, and the only one it ever
 * should: a fixed URL derived from a constant repository, never a path a
 * visitor can influence. Nothing here proxies a file. The site reads metadata
 * and links to GitHub; the bytes are served by GitHub, to the browser,
 * directly.
 *
 * It cannot fail loudly. A download page that 500s because an upstream API was
 * rate limited is worse than one showing the previous build, so every error
 * path ends at `pinnedDistribution()` -- the last build known to be
 * downloadable -- rather than at an exception.
 */

/** Long enough that a burst of visitors is one API call; short enough that a release shows up the same day. */
const REVALIDATE_SECONDS = 900;
const REQUEST_TIMEOUT_MS = 5_000;
/** A manifest is ~1 KB and a checksum file a few hundred bytes. */
const MAX_TEXT_ASSET_BYTES = 64 * 1024;

function repositorySlug(): string {
  return new URL(MINER_SOURCE_REPOSITORY).pathname.replace(/^\/+|\/+$/g, "");
}

function headers(): HeadersInit {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "usage-website",
  };
  // Optional, server-only, and never required: it exists so a busy deployment
  // is not sharing an anonymous rate limit with the rest of the platform. A
  // read of public release metadata needs no scopes at all.
  const token = process.env.USAGE_GITHUB_TOKEN;
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function fetchTextAsset(url: string | undefined): Promise<string | null> {
  if (!url || !isAssetUrlAllowed(url)) return null;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > MAX_TEXT_ASSET_BYTES ? null : text;
  } catch {
    return null;
  }
}

/**
 * The miner build the website currently offers.
 *
 * Cached by the fetch layer, so calling it from several places in one render
 * costs one request at most.
 */
export async function loadDistribution(): Promise<MinerDistribution> {
  const releases = await fetchJson<GitHubRelease[]>(
    `https://api.github.com/repos/${repositorySlug()}/releases?per_page=20`,
  );
  if (!Array.isArray(releases)) return pinnedDistribution();

  const release = selectRelease(releases);
  if (!release) return pinnedDistribution();

  const [manifestText, checksums] = await Promise.all([
    fetchTextAsset(release.assets.find((asset) => asset.name === MANIFEST_ASSET)?.browser_download_url),
    fetchTextAsset(release.assets.find((asset) => asset.name === CHECKSUMS_ASSET)?.browser_download_url),
  ]);

  let manifest: MinerReleaseManifestLike | null = null;
  if (manifestText) {
    try {
      manifest = JSON.parse(manifestText) as MinerReleaseManifestLike;
    } catch {
      manifest = null;
    }
  }

  return resolveDistribution({ release, manifest, checksums });
}
