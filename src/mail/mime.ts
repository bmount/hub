export type MimeInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo: string | null;
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

// Minimal RFC 5322 message: ASCII plain text, 7bit, CRLF line endings.
export function buildMime(m: MimeInput): string {
  if (!BODY_SAFE.test(m.text)) throw new Error("body must be ASCII");
  const lines = [
    header("From", m.from),
    header("To", m.to),
    header("Subject", m.subject),
    header("Date", m.date.toUTCString()),
    header("Message-ID", m.messageId),
  ];
  if (m.inReplyTo) lines.push(header("In-Reply-To", m.inReplyTo), header("References", m.inReplyTo));
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    `Auto-Submitted: ${m.inReplyTo ? "auto-replied" : "auto-generated"}`,
  );
  const body = m.text.replace(/\r?\n/g, "\r\n");
  return `${lines.join("\r\n")}\r\n\r\n${body}\r\n`;
}
