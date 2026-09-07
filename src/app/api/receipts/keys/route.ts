import { expectedIssuer, publishedPublicKeys } from "@/lib/trust/production";

/**
 * Published receipt verification keys.
 *
 * Deliberately public and unauthenticated: a proof anyone can check is only
 * meaningful if anyone can fetch the key to check it with. Public keys reveal
 * nothing — the private half never leaves the deployment.
 *
 * Key ids allow rotation: an old receipt keeps verifying against the key it was
 * signed with, as long as that key stays listed here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { issuer: expectedIssuer(), keys: publishedPublicKeys() },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
