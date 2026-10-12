import { sha256Hex } from "../ids";
import { mask } from "./redact";

/** Compare causes without forwarding messages or stack text. Not a source-map symbolication. */
export function messageTemplate(s: string): string {
  return mask(s.slice(0, 4000)).toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "#")
    .replace(/\b[0-9a-f]{12,}\b/g, "#")
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '"…"')
    .replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

export async function exceptionFingerprint(e: { name?: string; message?: string; stack?: string }): Promise<string> {
  // Ignore the first (message) line and unstable bundle coordinates; keep the top three call sites.
  const frames = (e.stack ?? "").slice(0, 8000).split("\n").filter(s => /^\s*at\s/.test(s)).slice(0, 3)
    .map(s => messageTemplate(s.replace(/:\d+:\d+(?=\)?\s*$)/, "")));
  return sha256Hex(JSON.stringify([e.name ?? "Error", messageTemplate(e.message ?? ""), frames]));
}
