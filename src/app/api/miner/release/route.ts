import {
  MINER_RELEASE,
  MINIMUM_MINER_VERSION,
  MINER_PROTOCOL_VERSION,
  downloadUrl,
} from "@/lib/miner/release";

/**
 * What build is current, and what its bytes hash to.
 *
 * Public and unauthenticated on purpose: a checksum you have to sign in to read
 * is not a checksum anyone will use. Nothing here is user-specific, and nothing
 * here is a secret -- it is a version, a URL and a hash.
 *
 * An installed miner reads this to know it is out of date. It does NOT read it
 * to know what to run: there is no update URL the server can point a device at
 * and no code path that downloads and executes anything. Updating is something
 * a person does, deliberately, by installing a new build they can verify.
 */

export const runtime = "nodejs";
export const dynamic = "force-static";

export function GET() {
  return Response.json(
    {
      product: MINER_RELEASE.product,
      version: MINER_RELEASE.version,
      channel: MINER_RELEASE.channel,
      platform: MINER_RELEASE.platform,
      protocolVersion: MINER_PROTOCOL_VERSION,
      minimumMinerVersion: MINIMUM_MINER_VERSION,
      builtAt: MINER_RELEASE.builtAt,
      nodeVersion: MINER_RELEASE.nodeVersion,
      signed: MINER_RELEASE.signed,
      signingNote: MINER_RELEASE.signingNote,
      files: MINER_RELEASE.files.map((file) => ({
        ...file,
        url: downloadUrl(file),
      })),
    },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=300",
        // A release manifest is exactly the kind of thing a third-party tool
        // should be able to read directly.
        "access-control-allow-origin": "*",
      },
    },
  );
}
