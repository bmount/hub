import { addressParser, type Header } from "postal-mime";
import { normalizeEmail } from "../db/identities";
import type { SendResult } from "./send";

/** Bind the envelope identity to exactly one outer RFC 5322 From mailbox.
 * This is a necessary identity check, NOT authentication. Inner forwarded
 * messages and Authentication-Results/ARC headers are never proof.
 */
export function envelopeMatchesFrom(envelope: string, headers: Header[]): boolean {
  const from = headers.filter((h) => h.key.toLowerCase() === "from");
  if (from.length !== 1) return false;
  const addresses = addressParser(from[0]!.value);
  return addresses.length === 1 && !addresses[0]!.group
    && normalizeEmail(addresses[0]!.address ?? "") === normalizeEmail(envelope);
}

export type SenderProof =
  | { authentication: "pass"; source: "cloudflare_reply"; reason: null }
  | { authentication: "unknown"; source: null; reason: string };

/** Cloudflare's reply gate proves DMARC only on success. A failure can be
 * transport, MIME, consent, duplicate reply or the References limit, not just
 * authentication. Never classify it as DMARC fail or inspect exception text.
 * Until an independent trusted verifier exists, unknown stays quarantined.
 */
export function proofFromReply(result: SendResult): SenderProof {
  return result === "sent"
    ? { authentication: "pass", source: "cloudflare_reply", reason: null }
    : { authentication: "unknown", source: null,
        reason: `authentication unknown: Cloudflare reply proof unavailable (notification=${result}); no DMARC failure inferred` };
}
