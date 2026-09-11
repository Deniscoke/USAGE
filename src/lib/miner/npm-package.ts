/**
 * Whether the miner can be run with `npx`, and at what version.
 *
 * The npm package exists for one reason: the Windows installer is unsigned, so
 * SmartScreen warns about it, and it will keep warning until a signing
 * identity exists and has accumulated reputation. `npx usage-miner` does not
 * hide that warning, it removes the reason for it -- no unknown binary is
 * executed, the code runs under the Node the developer already has.
 *
 * Read from the registry rather than asserted here, for the same reason the
 * download page reads GitHub releases: a page must not offer a command that
 * fails for the person who types it. Until the package is published, the site
 * says nothing about it.
 */

export const NPM_PACKAGE_NAME = "usage-miner";
export const NPX_COMMAND = `npx ${NPM_PACKAGE_NAME}`;

export interface NpmPackage {
  published: boolean;
  version: string | null;
  /** When the registry entry last changed. Null when unknown. */
  modifiedAt: string | null;
}

const UNPUBLISHED: NpmPackage = { published: false, version: null, modifiedAt: null };

/** The abbreviated registry document: dist-tags and little else. */
interface AbbreviatedPackument {
  "dist-tags"?: { latest?: string };
  modified?: string;
}

export function readPackument(document: unknown): NpmPackage {
  if (!document || typeof document !== "object") return UNPUBLISHED;
  const packument = document as AbbreviatedPackument;
  const version = packument["dist-tags"]?.latest;
  if (typeof version !== "string" || version.length === 0) return UNPUBLISHED;
  return {
    published: true,
    version,
    modifiedAt: typeof packument.modified === "string" ? packument.modified : null,
  };
}

const REVALIDATE_SECONDS = 900;
const REQUEST_TIMEOUT_MS = 5_000;

export async function loadNpmPackage(): Promise<NpmPackage> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}`, {
      // The abbreviated document: a fraction of the size, and all this needs.
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    // 404 is the honest answer before the first publish, not an error.
    if (!response.ok) return UNPUBLISHED;
    return readPackument(await response.json());
  } catch {
    return UNPUBLISHED;
  }
}
