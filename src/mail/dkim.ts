import { Buffer } from "node:buffer";
import { verifyDkimInWorker } from "./dkim-worker";
import type { DNSResolver } from "mailauth";
import { envelopeMatchesFrom } from "./proof";
import { safeMessageId } from "./mime";

import { MAX_RAW_MAIL_BYTES } from "./raw";
import { createDkimResolver } from "./dkim-dns";
export { createDkimResolver } from "./dkim-dns";
export const MAX_DKIM_BYTES = MAX_RAW_MAIL_BYTES;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SIGNATURES = 6;
// These affect stored content, addressed-mail permissions, reply targets or threading.
// All outer MIME Content-* fields need coverage, not just the current parser's
// Content-Type/Encoding/Disposition: ID/Description and future MIME extensions
// must not acquire unsigned semantic authority as parsing/rendering evolves.
// Inner part headers are already covered by the complete DKIM body hash.
// Unknown transport/authentication headers are evidence only, never authority.
const SEMANTIC = new Set(["from", "sender", "reply-to", "to", "cc", "bcc", "subject", "date", "message-id",
  "in-reply-to", "references", "mime-version"]);
const isSemantic = (key: string) => SEMANTIC.has(key) || key.startsWith("content-");
export type DkimProof =
  | { authentication: "pass"; source: "aligned_dkim"; domain: string; messageId: string }
  | { authentication: "unknown"; source: null; reason: string };
const unknown = (reason: string): DkimProof => ({ authentication: "unknown", source: null,
  reason: `authentication unknown: independent DKIM ${reason}` });

/** Cryptographic proof candidate only: callers MUST enforce membership, consent and
 * atomic replay deduplication before admission. Not SPF, ARC or universal DMARC.
 * Verifies original bytes through mailauth's strict RFC verifier, never reserialized MIME.
 */
export async function verifyIndependentDkim(bytes: Uint8Array, envelope: string, now: number,
  resolver: DNSResolver = createDkimResolver()): Promise<DkimProof> {
  if (bytes.byteLength > MAX_DKIM_BYTES) return unknown("message too large");
  // Strict CRLF outer headers avoid disagreement between MIME and DKIM parsers.
  const prefix = Buffer.from(bytes.subarray(0, MAX_HEADER_BYTES + 4)).toString("latin1");
  const end = prefix.indexOf("\r\n\r\n");
  if (end < 0 || end > MAX_HEADER_BYTES) return unknown("header limit or framing");
  const lines = prefix.slice(0, end).split("\r\n");
  const fields: Array<{ key: string; originalKey: string; value: string }> = [];
  for (const line of lines) {
    if (/[\r\n\x00]/.test(line)) return unknown("header framing");
    if (/^[ \t]/.test(line)) {
      if (!fields.length) return unknown("header framing");
      fields[fields.length - 1]!.value += `\r\n${line}`;
    } else {
      const match = /^([!-9;-~]+):([^\r\n]*)$/.exec(line);
      if (!match) return unknown("header framing");
      fields.push({ key: match[1]!.toLowerCase(), originalKey: match[1]!, value: match[2]! });
    }
  }
  if (!envelopeMatchesFrom(envelope, fields)) return unknown("From/envelope mismatch");
  const domain = envelope.trim().toLowerCase().split("@").pop()!;
  const signatures = fields.filter((h) => h.key === "dkim-signature");
  if (!signatures.length || signatures.length > MAX_SIGNATURES) return unknown("signature count");
  const semantic = fields.filter((h) => isSemantic(h.key));
  if (new Set(semantic.map((h) => h.key)).size !== semantic.length) return unknown("duplicate semantic header");
  const id = fields.find((h) => h.key === "message-id")?.value.trim();
  const messageId = safeMessageId(id ?? null);
  if (!id || !messageId || messageId !== id) return unknown("missing or ambiguous Message-ID");
  try {
    const verified = await verifyDkimInWorker(bytes, { sender: envelope, resolver, curTime: new Date(now),
      strict: true, minBitLength: 2048 });
    // Independent parser agreement: neither may accept a different outer identity.
    if (verified.fromFields !== 1 || verified.headerFrom.length !== 1
      || verified.headerFrom[0]!.trim().toLowerCase() !== envelope.trim().toLowerCase()) return unknown("parser disagreement");
    for (const result of verified.results) {
      if (result.status.result !== "pass" || result.status.testing || result.signatureTimeValid !== true
        || result.signingDomain?.toLowerCase() !== domain || result.canonBodyLengthLimited !== false
        || !["rsa-sha256", "ed25519-sha256"].includes(result.algo ?? "")) continue;
      const signed = new Set(result.signingHeaders?.headers.map((h) => h.slice(0, h.indexOf(":")).toLowerCase()));
      if (!semantic.every((h) => signed.has(h.key))) continue;
      return { authentication: "pass", source: "aligned_dkim", domain, messageId };
    }
    return unknown("no acceptable aligned full-coverage signature");
  } catch { return unknown("verification unavailable"); }
}
