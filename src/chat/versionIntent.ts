import { sha256Hex } from "../ids";

/** Exact parsed target and replacement text (null retracts), before mutable ref/mention resolution.
 * Read heads, session ids and resolved titles are not new intents. Preserve target aliases verbatim.
 */
export function versionIntentFingerprint(v: { msg: string; body: string | null }): Promise<string> {
  return sha256Hex(JSON.stringify({ msg: v.msg, body: v.body }));
}
