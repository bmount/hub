import { Buffer } from "node:buffer";
import { verifyDkimInWorker } from "./dkim-worker";
import type { DNSResolver } from "mailauth";
import { envelopeMatchesFrom } from "./proof";
import { safeMessageId } from "./mime";

import { MAX_RAW_MAIL_BYTES, readBoundedMail } from "./raw";
export const MAX_DKIM_BYTES = MAX_RAW_MAIL_BYTES;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SIGNATURES = 6;
// These affect stored content, addressed-mail permissions, reply targets or threading.
// Unknown transport/authentication headers are evidence only, never authority.
const SEMANTIC = new Set(["from", "sender", "reply-to", "to", "cc", "bcc", "subject", "date", "message-id",
  "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding", "content-disposition"]);
export type DkimProof =
  | { authentication: "pass"; source: "aligned_dkim"; domain: string; messageId: string }
  | { authentication: "unknown"; source: null; reason: string };
const unknown = (reason: string): DkimProof => ({ authentication: "unknown", source: null,
  reason: `authentication unknown: independent DKIM ${reason}` });

/** Fixed HTTPS authority, per-message budget and no fallback to native DNS or mail headers.
 * DNSSEC AD is not required: trust is the configured HTTPS resolver, not sender input.
 * CNAME answers and escaped TXT records are deliberately unsupported (fail closed).
 */
export function createDkimResolver(fetcher: typeof fetch = fetch): DNSResolver {
  let lookups = 0;
  const deadline = Date.now() + 5000;
  return async (name, type) => {
    if (type !== "TXT" || ++lookups > MAX_SIGNATURES || name.length > 253
      || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\._domainkey\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(name)) throw new Error("key query refused");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("key lookup deadline");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(2000, remaining));
    try {
      const url = new URL("https://cloudflare-dns.com/dns-query");
      url.searchParams.set("name", name); url.searchParams.set("type", "TXT");
      const response = await fetcher(url, { headers: { accept: "application/dns-json" },
        signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/dns-json")) throw new Error("key lookup refused");
      const bytes = await readBoundedMail(response.body!, 16 * 1024);
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data.Status !== 0 || data.TC === true || !Array.isArray(data.Question) || data.Question.length !== 1
        || data.Question[0].type !== 16 || data.Question[0].name.replace(/\.$/, "").toLowerCase() !== name.toLowerCase()
        || !Array.isArray(data.Answer) || data.Answer.length > 16) throw new Error("key lookup unavailable");
      const records: string[][] = [];
      for (const answer of data.Answer) {
        if (answer.type !== 16 || answer.name.replace(/\.$/, "").toLowerCase() !== name.toLowerCase()
          || typeof answer.data !== "string" || !/^"[^"\\]*"(?:\s+"[^"\\]*")*$/.test(answer.data)) throw new Error("unsupported key answer");
        records.push([...answer.data.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]!));
      }
      if (!records.length) throw new Error("key absent");
      return records;
    } finally { clearTimeout(timer); }
  };
}

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
  const semantic = fields.filter((h) => SEMANTIC.has(h.key));
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
