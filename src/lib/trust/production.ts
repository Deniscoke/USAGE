import { publicKeyFromPrivate } from "@/lib/domain/signing";
import {
  checkVercelDeploymentIdentity,
  oidcExpectation,
  VERCEL_OIDC_HEADER,
  type JwtVerifier,
  type OidcCheck,
} from "./vercel-oidc";

/**
 * The root of trust for production proof issuance.
 *
 * EXPLICITLY NOT the root of trust: `USAGE_TRUST_ENVIRONMENT=production`. Any
 * user can set an environment variable on their own machine, so an env flag can
 * never be evidence that a receipt came from USAGE infrastructure. It is kept
 * only as a readable signal in diagnostics.
 *
 * The actual root is possession of the receipt signing private key, which
 * exists only as a sensitive environment variable on the hosted deployment. A
 * local gateway has no such key, therefore cannot produce a signature that
 * verifies against the published USAGE public key, therefore cannot mint a
 * CONFIRMED proof — whatever it claims about itself.
 *
 * Vercel OIDC deployment identity is layered on top when configured: it proves
 * cryptographically which project/team/environment is executing. When it is
 * configured and fails, issuance is refused (fail closed).
 */

export const DEFAULT_ISSUER = "usage://issuer/production";

export interface ProductionIssuer {
  issuer: string;
  keyId: string;
  privateKeyBase64: string;
}

export interface TrustAssessment {
  /** May this process sign production receipts? */
  canIssueProduction: boolean;
  issuer: ProductionIssuer | null;
  signals: {
    signingKeyPresent: boolean;
    keyIdPresent: boolean;
    /** Recorded, never sufficient. */
    environmentHint: string | null;
    oidc: OidcCheck["state"];
  };
  reasons: string[];
}

function signingIssuer(): ProductionIssuer | null {
  const privateKeyBase64 = process.env.USAGE_RECEIPT_SIGNING_PRIVATE_KEY?.trim();
  const keyId = process.env.USAGE_RECEIPT_SIGNING_KEY_ID?.trim();
  if (!privateKeyBase64 || !keyId) return null;

  // A non-empty string is not a key. Deriving the public half proves the value
  // is actually usable -- otherwise this claims it can issue proofs and then
  // throws on the first one, which is a worse failure than refusing up front.
  try {
    publicKeyFromPrivate(privateKeyBase64);
  } catch {
    return null;
  }

  return {
    issuer: process.env.USAGE_RECEIPT_ISSUER?.trim() || DEFAULT_ISSUER,
    keyId,
    privateKeyBase64,
  };
}

export async function assessTrust(
  headers?: Headers,
  verifier?: JwtVerifier,
): Promise<TrustAssessment> {
  const reasons: string[] = [];
  const issuer = signingIssuer();

  const expectation = oidcExpectation();
  const oidc = await checkVercelDeploymentIdentity(
    headers?.get(VERCEL_OIDC_HEADER) ?? null,
    expectation,
    verifier,
  );

  if (!issuer) {
    reasons.push(
      process.env.USAGE_RECEIPT_SIGNING_PRIVATE_KEY?.trim()
        ? "the configured signing key is not a usable Ed25519 private key"
        : "no production signing key is present in this environment",
    );
  }
  if (oidc.state === "failed") reasons.push(`deployment identity rejected: ${oidc.reason}`);
  if (oidc.state === "missing_token") reasons.push("deployment identity token was not presented");

  // Configured OIDC must pass. Unconfigured OIDC means the signing key alone is
  // the root, which is documented in docs/ARCHITECTURE.md.
  const oidcOk = oidc.state === "verified" || oidc.state === "not_configured";

  return {
    canIssueProduction: Boolean(issuer) && oidcOk,
    issuer,
    signals: {
      signingKeyPresent: Boolean(issuer),
      keyIdPresent: Boolean(issuer?.keyId),
      environmentHint: process.env.USAGE_TRUST_ENVIRONMENT?.trim() || null,
      oidc: oidc.state,
    },
    reasons,
  };
}

/**
 * Published verification keys, by key id. Public by design: anyone checking a
 * USAGE receipt needs them, and they reveal nothing.
 *
 * Configured as JSON (`{"key-id":"base64-spki"}`). On a signing deployment the
 * key's own public half is derived automatically so the two can never drift.
 */
export function publishedPublicKeys(): Record<string, string> {
  const keys: Record<string, string> = {};

  const configured = process.env.USAGE_RECEIPT_PUBLIC_KEYS?.trim();
  if (configured) {
    try {
      const parsed: unknown = JSON.parse(configured);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") keys[keyId] = value;
        }
      }
    } catch {
      // A malformed key map must not take the process down; it simply means no
      // configured keys, and verification will fail loudly instead.
    }
  }

  const issuer = signingIssuer();
  if (issuer) {
    try {
      keys[issuer.keyId] = publicKeyFromPrivate(issuer.privateKeyBase64);
    } catch {
      // An unusable private key is caught at signing time.
    }
  }

  return keys;
}

export function expectedIssuer(): string {
  return process.env.USAGE_RECEIPT_ISSUER?.trim() || DEFAULT_ISSUER;
}
