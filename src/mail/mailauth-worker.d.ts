// Narrow declarations for the pinned mailauth parser entry used by the Workers adapter.
declare module "mailauth/lib/dkim/dkim-verifier.js" {
  import { Writable } from "node:stream";
  import type { DKIMResult, DKIMVerifyOptions } from "mailauth";
  export interface PreparedSignature {
    algorithm: string;
    signAlgo: string;
    hashAlgo: string;
  }
  export class DkimVerifier extends Writable {
    constructor(options: DKIMVerifyOptions);
    fromFields: number;
    headerFrom: string[];
    results: DKIMResult[];
    verifySignature(signature: PreparedSignature, fallback?: boolean): Promise<DKIMResult>;
  }
}
