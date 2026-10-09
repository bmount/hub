import { sha256Hex } from "../ids";

/** Exact submitted ordinary-post intent, not mutable rendering/resolution or a refreshed read head.
 * Worker passes explicit refs (including unresolved ones); direct DO callers use their supplied refs.
 * Keep the parsed reply reference verbatim: changing even an alias requires reconciliation.
 */
export function postIntentFingerprint(p: { body: string; reply_to: string | null; refs: Array<{ kind: string; key: string }> }): Promise<string> {
  return sha256Hex(JSON.stringify({ body: p.body, reply_to: p.reply_to, refs: p.refs.map(({ kind, key }) => ({ kind, key })) }));
}
