interface ArcHeader { parsed: Record<string, { value?: string | number }>; }
interface ArcEntry { i: number; "arc-seal": ArcHeader; "arc-message-signature": ArcHeader; messageSignature?: import("mailauth").DKIMResult; }
interface ArcData { chain?: ArcEntry[]; lastEntry?: ArcEntry; error?: unknown; }
declare module "mailauth/lib/arc/index.js" {
  export function arc(data: ArcData, options: import("mailauth").DKIMVerifyOptions): Promise<{
    status: { result: string }; i?: number; signature?: import("mailauth").DKIMResult;
    authenticationResults?: { mta?: string; dmarc?: { result?: string; header?: { from?: string } } };
  }>;
}
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
    arc: ArcData;
    fromFields: number;
    headerFrom: string[];
    results: DKIMResult[];
    verifySignature(signature: PreparedSignature, fallback?: boolean): Promise<DKIMResult>;
  }
}
