import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Vercel deployment identity.
 *
 * Every Vercel Function invocation carries an OIDC token, signed by Vercel's
 * identity provider, on the `x-vercel-oidc-token` request header. Verifying it
 * against Vercel's JWKS tells us *cryptographically* which project, team and
 * environment is executing — something a local process cannot forge, because it
 * cannot mint a token for someone else's project with `environment=production`.
 *
 * This is a trust SIGNAL, not the trust root. The root is the receipt signing
 * key (see ./production): a stolen OIDC token still cannot sign a receipt, and
 * the signing key is what a verifier ultimately checks.
 */

export const VERCEL_OIDC_HEADER = "x-vercel-oidc-token";

export interface VercelDeploymentIdentity {
  issuer: string;
  owner?: string;
  ownerId?: string;
  project?: string;
  projectId?: string;
  environment?: string;
}

export type OidcCheck =
  | { state: "not_configured" }
  | { state: "missing_token" }
  | { state: "verified"; identity: VercelDeploymentIdentity }
  | { state: "failed"; reason: string };

export interface OidcExpectation {
  issuer: string;
  projectId?: string;
  ownerId?: string;
  environment: string;
}

/** Reads the expectation from server configuration. Absent means "not configured". */
export function oidcExpectation(): OidcExpectation | null {
  const issuer = process.env.USAGE_VERCEL_OIDC_ISSUER?.trim();
  if (!issuer) return null;
  return {
    issuer,
    projectId: process.env.USAGE_VERCEL_PROJECT_ID?.trim() || undefined,
    ownerId: process.env.USAGE_VERCEL_OWNER_ID?.trim() || undefined,
    environment: process.env.USAGE_VERCEL_ENVIRONMENT?.trim() || "production",
  };
}

// One remote key set per issuer, cached for the life of the process. jose
// handles key rotation and caching internally.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = keySets.get(issuer);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(`${issuer.replace(/\/+$/, "")}/.well-known/jwks`));
  keySets.set(issuer, created);
  return created;
}

/** Test seam: verification is network-dependent, so it is injectable. */
export type JwtVerifier = (token: string, expectation: OidcExpectation) => Promise<JWTPayload>;

const defaultVerifier: JwtVerifier = async (token, expectation) => {
  const { payload } = await jwtVerify(token, keySetFor(expectation.issuer), {
    issuer: expectation.issuer,
  });
  return payload;
};

export async function checkVercelDeploymentIdentity(
  token: string | null,
  expectation: OidcExpectation | null,
  verifier: JwtVerifier = defaultVerifier,
): Promise<OidcCheck> {
  if (!expectation) return { state: "not_configured" };
  if (!token) return { state: "missing_token" };

  let payload: JWTPayload;
  try {
    payload = await verifier(token, expectation);
  } catch (error) {
    return {
      state: "failed",
      reason: error instanceof Error ? error.message : "token verification failed",
    };
  }

  const identity: VercelDeploymentIdentity = {
    issuer: String(payload.iss ?? ""),
    owner: typeof payload.owner === "string" ? payload.owner : undefined,
    ownerId: typeof payload.owner_id === "string" ? payload.owner_id : undefined,
    project: typeof payload.project === "string" ? payload.project : undefined,
    projectId: typeof payload.project_id === "string" ? payload.project_id : undefined,
    environment: typeof payload.environment === "string" ? payload.environment : undefined,
  };

  // A development token pulled to a laptop is a perfectly valid token; it is
  // simply not the production deployment, and must not pass as one.
  if (identity.environment !== expectation.environment) {
    return { state: "failed", reason: `environment is ${identity.environment ?? "unknown"}` };
  }
  if (expectation.projectId && identity.projectId !== expectation.projectId) {
    return { state: "failed", reason: "project id does not match" };
  }
  if (expectation.ownerId && identity.ownerId !== expectation.ownerId) {
    return { state: "failed", reason: "owner id does not match" };
  }

  return { state: "verified", identity };
}
