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
  | { authentication: "pass"; source: "aligned_dkim" | "cloudflare_arc"; domain: string; messageId: string; recipientsAuthenticated?: boolean; actionEligible?: boolean; actionReason?: string; results?: unknown }
  | { authentication: "unknown"; source: null; reason: string; results?: unknown };
const unknown = (reason: string): Extract<DkimProof, { authentication: "unknown" }> => ({ authentication: "unknown", source: null,
  reason: `authentication unknown: independent DKIM ${reason}` });

/** Cryptographic proof candidate only: callers MUST enforce membership, consent and
 * atomic replay deduplication before admission. Not SPF or universal DMARC.
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
    // Strict supported header subset: CR/LF only frame lines; HTAB is the
    // sole permitted C0 control within a field/fold. Refuse obsolete controls
    // and DEL before either parser/DNS, even in non-authoritative extensions.
    // Do not apply this to body bytes or reject UTF-8 header octets.
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return unknown("header framing");
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
  if (signatures.length > MAX_SIGNATURES || (!signatures.length && !fields.some(h => h.key === "arc-seal"))) return unknown("signature count");
  const semantic = fields.filter((h) => isSemantic(h.key));
  if (new Set(semantic.map((h) => h.key)).size !== semantic.length) return unknown("duplicate semantic header");
  const id = fields.find((h) => h.key === "message-id")?.value.trim();
  const messageId = safeMessageId(id ?? null);
  if (!id || !messageId || messageId !== id) return unknown("missing or ambiguous Message-ID");
  try {
    const verified = await verifyDkimInWorker(bytes, { sender: envelope, resolver, curTime: new Date(now),
      strict: true, minBitLength: 1024 });
    // Independent parser agreement: neither may accept a different outer identity.
    if (verified.fromFields !== 1 || verified.headerFrom.length !== 1
      || verified.headerFrom[0]!.trim().toLowerCase() !== envelope.trim().toLowerCase()) return unknown("parser disagreement");
    const date = Date.parse(fields.find(h => h.key === "date")?.value ?? "");
    const recent = Number.isFinite(date) && date <= now + 5 * 60_000 && now - date <= 72 * 3600_000;
    const actionState = (covered: boolean) => ({ actionEligible: covered && recent,
      actionReason: !covered ? "The signature lacks required header coverage; instructions were skipped."
        : !recent ? "The signed Date is missing, future-dated or older than 72 hours; instructions were skipped." : undefined });
    const ar = verified.arcResult;
    const last = verified.sets.at(-1);
    const ams = verified.highestSignature;
    const signedArc = new Set(ams?.signingHeaders?.headers.map(h => h.slice(0, h.indexOf(":")).toLowerCase()));
    const sealEvidence = fields.filter(h => h.key === "arc-seal").map(h => {
      const tags = Object.fromEntries(h.value.replace(/\r\n[ \t]+/g, " ").split(";").map(tag => {
        const at = tag.indexOf("="); return [tag.slice(0, at).trim(), tag.slice(at + 1).trim()];
      }));
      return { i: tags.i, cv: tags.cv, d: tags.d, s: tags.s };
    });
    const arcChecks = { sets: sealEvidence, parsedSets: verified.sets, instance: ar.i, sealAndChain: ar.status.result,
      messageSignature: ams?.status.result ?? "none", messageSignatureDomain: ams?.signingDomain,
      messageSignatureSelector: ams?.selector, signatureTimeValid: ams?.signatureTimeValid === true,
      completeBody: ams?.canonBodyLengthLimited === false, nonTesting: !!ams && !ams.status.testing,
      fromCovered: signedArc.has("from"), messageIdCovered: signedArc.has("message-id"),
      signedDateRecent: signedArc.has("date") && recent, pinnedSealer: typeof last?.d === "string" && last.d.toLowerCase() === "email.cloudflare.net",
      authserv: ar.authenticationResults?.mta?.toLowerCase() === "mx.cloudflare.net",
      alignedDmarc: ar.authenticationResults?.dmarc?.result === "pass" && ar.authenticationResults?.dmarc?.header?.from?.toLowerCase() === domain };
    if (arcChecks.sealAndChain === "pass" && arcChecks.messageSignature === "pass" && arcChecks.pinnedSealer
      && arcChecks.authserv && arcChecks.alignedDmarc && arcChecks.signatureTimeValid
      && arcChecks.completeBody && arcChecks.nonTesting && arcChecks.fromCovered && arcChecks.messageIdCovered) {
      return { authentication: "pass", source: "cloudflare_arc", domain, messageId,
        recipientsAuthenticated: ["to", "cc"].every(key => !fields.some(h => h.key === key) || signedArc.has(key)),
        ...actionState(["date", "to", "cc"].every(key => !fields.some(h => h.key === key) || signedArc.has(key))), results: { arc: arcChecks } };
    }
    let partial: DkimProof | undefined;
    for (const result of verified.results) {
      if (result.status.result !== "pass" || result.status.testing || result.signatureTimeValid !== true
        || result.signingDomain?.toLowerCase() !== domain || result.canonBodyLengthLimited !== false
        || !["rsa-sha256", "ed25519-sha256"].includes(result.algo ?? "")) continue;
      const signed = new Set(result.signingHeaders?.headers.map((h) => h.slice(0, h.indexOf(":")).toLowerCase()));
      // A replay key without signed Message-ID could be changed by a re-sender.
      if (!signed.has("message-id")) continue;
      const covered = semantic.every((h) => signed.has(h.key));
      const candidate: DkimProof = { authentication: "pass", source: "aligned_dkim", domain, messageId,
        recipientsAuthenticated: ["to", "cc"].every(key => !fields.some(h => h.key === key) || signed.has(key)),
        ...actionState(covered), results: { arc: arcChecks } };
      if (covered) return candidate;
      partial = candidate;
    }
    if (partial) return partial;
    return { ...unknown("no acceptable aligned signature or Cloudflare ARC verdict"), results: { arc: arcChecks, dkim: verified.results.map(r => ({ result: r.status.result, signingDomain: r.signingDomain, selector: r.selector,
      algo: r.algo, signatureTimeValid: r.signatureTimeValid, canonBodyLengthLimited: r.canonBodyLengthLimited })) } };
  } catch { return unknown("verification unavailable"); }
}
