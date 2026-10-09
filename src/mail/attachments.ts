// Attachment evidence only: no execution, Markdown/HTML interpretation, URL fetch or authority.
import type { Attachment } from "postal-mime";
import { cutText } from "../mcp/render";

export const MAX_ATTACHMENT_TEXT_CHARS = 20_000;
export const MAX_ATTACHMENT_TOTAL_CHARS = 60_000;
export type AttachmentEvidence = {
  filename: string | null; mime_type: string; size: number;
  text?: string; text_encoding?: "utf-8";
  text_status?: "complete" | "truncated" | "unsupported_type" | "invalid_utf8";
};

/** PostalMime decodes transfer encoding but does not expose attachment charset.
 * Retain strict UTF-8 (including ASCII) only, never silently replace undecodable bytes.
 * Limits are UTF-16 units, excluding metadata; the original ingress byte cap still applies.
 */
export function retainAttachmentEvidence(parts: Attachment[]): AttachmentEvidence[] {
  let remaining = MAX_ATTACHMENT_TOTAL_CHARS;
  return parts.map(a => {
    const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content)
      : a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content);
    const result: AttachmentEvidence = { filename: a.filename ?? null, mime_type: a.mimeType, size: bytes.byteLength };
    if (a.mimeType !== "text/plain" && a.mimeType !== "text/markdown") return { ...result, text_status: "unsupported_type" };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { return { ...result, text_status: "invalid_utf8" }; }
    const excerpt = cutText(text, Math.min(MAX_ATTACHMENT_TEXT_CHARS, remaining));
    remaining -= excerpt.text.length;
    return { ...result, text: excerpt.text, text_encoding: "utf-8", text_status: excerpt.cut ? "truncated" : "complete" };
  });
}

/** List responses stay metadata-only even when detail evidence is retained. */
export function attachmentMetadata(json: string): string {
  return JSON.stringify((JSON.parse(json) as AttachmentEvidence[]).map(({ text: _text, ...metadata }) => metadata));
}

export function attachmentCoverage(a: AttachmentEvidence): string {
  switch (a.text_status) {
    case "complete": return "UTF-8 text retained";
    case "truncated": return "UTF-8 text truncated by attachment limits";
    case "unsupported_type": return "text not retained: unsupported MIME type";
    case "invalid_utf8": return "text not retained: invalid UTF-8";
    default: return "text not retained (legacy metadata only)";
  }
}
