import { sha256Hex } from "../ids";
import type { ResponseIntent, ResponseTarget } from "./types";

/** Shared parsed-intent binding for posting and read-only comparison. Never resolve refs or trust a supplied digest. */
export async function responseIntent(body: string, refs: Array<{ kind: string; key: string }>, target: ResponseTarget): Promise<ResponseIntent> {
  return {
    source: { msg_id: target.msg_id, rev: target.rev, author_id: target.author_id },
    stage: target.stage ?? "result",
    fingerprint: await sha256Hex(JSON.stringify({ body, refs })),
  };
}
