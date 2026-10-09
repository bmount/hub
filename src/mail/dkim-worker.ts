import { Buffer } from "node:buffer";
import { finished } from "node:stream/promises";
import { DkimVerifier, type PreparedSignature } from "mailauth/lib/dkim/dkim-verifier.js";
import type { DKIMVerifyOptions } from "mailauth";

/** mailauth 7.1.1 uses Node's rsa-sha256 digest alias in crypto.verify().
 * Workers supports the digest name sha256, but not that alias. Translate ONLY
 * that spelling at the native API boundary after mailauth prepared the signature.
 * No custom cryptography/canonicalization, no global crypto patch, no weakening
 * of strict mode. Public parsed a= remains rsa-sha256 and all library checks run.
 * This private interface is version-pinned and guarded by signed runtime fixtures.
 */
class WorkerDkimVerifier extends DkimVerifier {
  override async verifySignature(signature: PreparedSignature, fallback?: boolean) {
    const original = signature.algorithm;
    if (signature.signAlgo === "rsa" && signature.hashAlgo === "sha256" && original === "rsa-sha256") {
      signature.algorithm = "sha256";
    }
    try { return await super.verifySignature(signature, fallback); }
    finally { signature.algorithm = original; }
  }
}

export async function verifyDkimInWorker(bytes: Uint8Array, options: DKIMVerifyOptions) {
  const verifier = new WorkerDkimVerifier(options);
  const complete = finished(verifier);
  verifier.end(Buffer.from(bytes));
  await complete;
  return { fromFields: verifier.fromFields, headerFrom: verifier.headerFrom, results: verifier.results };
}
