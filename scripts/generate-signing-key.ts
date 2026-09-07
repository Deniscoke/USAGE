/**
 * Generate a USAGE receipt signing key pair.
 *
 *   npm run usage:signing-key
 *
 * The PRIVATE key is printed once and never written to disk by this script.
 * Paste it into Vercel as a SENSITIVE environment variable; it must exist only
 * in trusted hosted infrastructure. The PUBLIC key is not a secret: publish it
 * so anyone can verify a USAGE proof without trusting us.
 */
import { generateSigningKeyPair } from "../src/lib/domain/signing";

const keyId = process.argv[2] ?? `usage-prod-${new Date().toISOString().slice(0, 10)}`;
const pair = generateSigningKeyPair(keyId);

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

line("USAGE receipt signing key");
line("=========================");
line();
line(`Key id: ${pair.keyId}`);
line();
line("PRIVATE — paste into Vercel as a Sensitive env var, then forget it:");
line();
line(`  USAGE_RECEIPT_SIGNING_KEY_ID=${pair.keyId}`);
line(`  USAGE_RECEIPT_SIGNING_PRIVATE_KEY=${pair.privateKeyBase64}`);
line();
line("PUBLIC — safe to publish and to commit alongside verification tooling:");
line();
line(`  USAGE_RECEIPT_PUBLIC_KEYS={"${pair.keyId}":"${pair.publicKeyBase64}"}`);
line();
line("Never place the private key in .env.example, git, or a client bundle.");
line("Rotation: issue a new key id, add it to the public key map, and switch");
line("the signing variables. Old receipts keep verifying against the old key.");
