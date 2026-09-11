import { loadDistribution } from "@/lib/miner/distribution-source";
import { MINIMUM_MINER_VERSION, MINER_PROTOCOL_VERSION } from "@/lib/miner/release";

/**
 * What build the website offers, where it is, and what it hashes to.
 *
 * Public and unauthenticated on purpose: a checksum you have to sign in to
 * read is not a checksum anyone will use. Nothing here is user-specific and
 * nothing here is a secret -- it is a version, a URL, a size and a hash, all
 * of them already public on the release itself.
 *
 * An installed miner may read this to learn it is out of date. It does NOT
 * read it to learn what to run: there is no update URL the server can point a
 * device at, and no code path anywhere that downloads and executes anything.
 * Updating is something a person does, deliberately, by installing a build
 * they can verify.
 *
 * `minimumMinerVersion` is repeated here for convenience only. What an old
 * build is actually allowed to do is decided server-side on every request, not
 * by whatever this endpoint said.
 */

export const runtime = "nodejs";
export const revalidate = 900;

export async function GET() {
  const distribution = await loadDistribution();

  return Response.json(
    {
      product: distribution.product,
      version: distribution.version,
      tag: distribution.tag,
      channel: distribution.channel,
      platform: distribution.platform,
      publishedAt: distribution.publishedAt,
      prerelease: distribution.prerelease,
      signed: distribution.signed,
      signingNote: distribution.signingNote,
      nodeVersion: distribution.nodeVersion,
      // "release" means these figures came from the release they describe;
      // "pinned" means no release could be read and this is the last build
      // known to be downloadable.
      source: distribution.source,
      protocolVersion: MINER_PROTOCOL_VERSION,
      minimumMinerVersion: MINIMUM_MINER_VERSION,
      downloadUrl: distribution.setup?.url ?? null,
      stableDownloadUrl: distribution.stableUrl,
      releaseUrl: distribution.releaseUrl,
      files: distribution.files,
    },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=900",
        // Release metadata is exactly the kind of thing a third-party tool
        // should be able to read directly.
        "access-control-allow-origin": "*",
      },
    },
  );
}
