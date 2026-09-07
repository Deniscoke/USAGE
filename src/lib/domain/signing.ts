import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

/**
 * Receipt signing keys.
 *
 * Ed25519: small keys, small signatures, no parameter choices to get wrong, and
 * deterministic — the same receipt signed twice produces the same bytes, which
 * matters when a proof may be re-derived and compared.
 *
 * Keys travel as base64 DER (PKCS#8 private, SPKI public) so they survive being
 * pasted into an environment variable without newline mangling. The PRIVATE key
 * exists only in trusted hosted infrastructure; the PUBLIC key is not a secret
 * and is meant to be published so anyone can check a USAGE proof.
 */

export interface SigningKeyPair {
  keyId: string;
  privateKeyBase64: string;
  publicKeyBase64: string;
}

export function generateSigningKeyPair(keyId: string): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyBase64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

export function signPayload(payload: string, privateKeyBase64: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  // Ed25519 signs the message directly; there is no separate digest algorithm.
  return nodeSign(null, Buffer.from(payload, "utf8"), key).toString("base64");
}

export function verifyPayload(
  payload: string,
  signatureBase64: string,
  publicKeyBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return nodeVerify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    // A malformed key or signature is a failed verification, not a crash.
    return false;
  }
}

export function publicKeyFromPrivate(privateKeyBase64: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
}
