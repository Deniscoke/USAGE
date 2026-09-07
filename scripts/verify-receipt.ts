/**
 * Verify a USAGE Proof Receipt.
 *
 *   npm run usage:verify-receipt -- <path-to-receipt.json>
 *
 * Needs nothing but the receipt and a public key: no database, no secrets, no
 * USAGE server. That is the point — a proof anyone can check.
 */
import { readFile } from "node:fs/promises";
import { verifyUsageReceipt, type SignedProofReceipt } from "../src/lib/domain/receipt";
import { expectedIssuer, publishedPublicKeys } from "../src/lib/trust/production";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<number> {
  const target = process.argv[2];
  if (!target) {
    line("Usage: npm run usage:verify-receipt -- <path-to-receipt.json>");
    return 1;
  }

  const signed = JSON.parse(await readFile(target, "utf8")) as SignedProofReceipt;
  const publicKeys = publishedPublicKeys();

  if (Object.keys(publicKeys).length === 0) {
    line("No public keys configured. Set USAGE_RECEIPT_PUBLIC_KEYS to verify.");
    return 1;
  }

  const result = verifyUsageReceipt(signed, {
    publicKeys,
    expectedIssuer: expectedIssuer(),
  });

  line(result.valid ? "VALID SIGNATURE" : "INVALID");
  line();
  line(`issuer         : ${result.issuer ?? "(none)"}`);
  line(`issuer key id  : ${result.issuerKeyId ?? "(none)"}`);
  line(`receipt version: ${signed.receipt.receiptVersion}`);
  line(`receipt id     : ${result.receiptId ?? "(none)"}`);
  line(`generation id  : ${result.generationId ?? "(none)"}`);
  line(`canonical hash : ${result.canonicalHash ?? "(none)"}`);
  line(`proof status   : ${signed.receipt.proofStatus}`);
  line(`economic status: ${signed.receipt.economicStatus}`);
  line(
    `tokens         : ${signed.receipt.inputTokens ?? "?"} in / ` +
      `${signed.receipt.cachedReadTokens ?? "?"} cached / ${signed.receipt.outputTokens ?? "?"} out`,
  );
  line(
    `cost           : ${
      signed.receipt.costMicroUsd === null
        ? `unknown (${signed.receipt.costBasis})`
        : `${signed.receipt.costMicroUsd} micro-USD (${signed.receipt.costBasis})`
    }`,
  );

  if (!result.valid) {
    line();
    for (const failure of result.failures) line(`  - ${failure}`);
  }
  return result.valid ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
