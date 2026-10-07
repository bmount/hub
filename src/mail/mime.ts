export type MimeInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo: string | null;
  /** Earlier message ids in the thread, oldest first; defaults to inReplyTo alone. */
  references?: string[];
  /** People's and agents' own writing: UTF-8 allowed (base64 body, encoded subject). Sign-in mail stays ASCII. */
  utf8?: boolean;
};

const HEADER_SAFE = /^[\x20-\x7e]*$/;
const BODY_SAFE = /^[\t\r\n\x20-\x7e]*$/;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/;

function header(name: string, value: string): string {
  if (!HEADER_SAFE.test(value)) throw new Error(`unsafe ${name} header`);
  return `${name}: ${value}`;
}

export function safeMessageId(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return MESSAGE_ID.test(t) ? t : null;
}

const b64 = (s: string) => { let out = ""; for (const b of new TextEncoder().encode(s)) out += String.fromCharCode(b); return btoa(out); };

/** RFC 2047 for a subject that isn't plain ASCII; control characters are refused either way. */
function subjectHeader(subject: string): string {
  if (/[\x00-\x1f\x7f]/.test(subject)) throw new Error("unsafe Subject header");
  return HEADER_SAFE.test(subject) ? header("Subject", subject) : `Subject: =?UTF-8?B?${b64(subject)}?=`;
}

// Minimal RFC 5322 message: plain text, CRLF line endings. ASCII as 7bit; UTF-8 (when allowed) as base64.
export function buildMime(m: MimeInput): string {
  const ascii = BODY_SAFE.test(m.text);
  if (!ascii && !m.utf8) throw new Error("body must be ASCII");
  const lines = [
    header("From", m.from),
    header("To", m.to),
    m.utf8 ? subjectHeader(m.subject) : header("Subject", m.subject),
    header("Date", m.date.toUTCString()),
    header("Message-ID", m.messageId),
  ];
  const refs = (m.references?.length ? m.references : m.inReplyTo ? [m.inReplyTo] : []).filter((r) => MESSAGE_ID.test(r)).slice(-10);
  if (m.inReplyTo) lines.push(header("In-Reply-To", m.inReplyTo));
  if (refs.length) lines.push(header("References", refs.join(" ")));
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${ascii ? "7bit" : "base64"}`,
    `Auto-Submitted: ${m.inReplyTo ? "auto-replied" : "auto-generated"}`,
  );
  const crlf = m.text.replace(/\r?\n/g, "\r\n");
  const body = ascii ? crlf : (b64(crlf).match(/.{1,76}/g) ?? []).join("\r\n");
  return `${lines.join("\r\n")}\r\n\r\n${body}\r\n`;
}
