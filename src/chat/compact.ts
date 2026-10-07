import { DATA_NOTE, MCP_TEXT_LIMIT, cleanLines, cleanText, cutText } from "../mcp/render";
import { LIMITS } from "./rules";
import type { NameTag, TagOf } from "./handles";
import type { MsgView, StoredRef, ViewRef } from "./types";

/** Second line of every chat text: which lines the hub wrote (messaging spec 11.3, 13). */
export const CHAT_NOTE = "Lines starting with [# are written by the hub. A message's text follows its header and continues on lines indented by two spaces.";
export const CHARS_PER_TOKEN = 4;
export const BODY_CUT = 600;

/** Characters a budget in tokens buys, never more than one MCP result holds. */
export function textBudget(budget: number): number {
  return Math.min(budget * CHARS_PER_TOKEN, MCP_TEXT_LIMIT - 300);
}

export function hhmm(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/** Short form of a canonical key; keys are hub-built from validated names, hex, and ULIDs. */
export function refShort(r: StoredRef): string {
  if (r.kind === "commit") {
    const at = r.key.indexOf("@");
    return `${r.key.slice(0, at)}@${r.key.slice(at + 1, at + 8)}`;
  }
  if (r.kind === "ticket") return r.key;
  if (r.kind === "session") return `session:${r.key}`;
  return `msg:${r.key.slice(r.key.indexOf("/") + 1)}`;
}

export function refsLine(refs: ViewRef[]): string | null {
  if (refs.length === 0) return null;
  const one = (r: ViewRef) => {
    if (r.no_access) return `${refShort(r)} (no access)`;
    return r.title ? `${refShort(r)} ${JSON.stringify(cutText(cleanText(r.title), 80).text)}` : refShort(r);
  };
  return `  refs: ${refs.map(one).join(", ")}`;
}

/** Spec 11.3: one server-written header per message. Nothing in it comes from message text. */
export function header(m: MsgView, tag: NameTag, channel?: string): string {
  const parts: string[] = [];
  if (channel) parts.push(`#${channel}`);
  parts.push(`#${m.seq}`, hhmm(m.created_at), `@${tag.handle}`);
  if (tag.kind === "agent") {
    parts.push("agent");
    if (tag.operator_handle) parts.push(`op:@${tag.operator_handle}`);
    if (tag.session_label) parts.push(`run:${tag.session_label}`);
    parts.push(`hop${m.hop}`);
  }
  if (tag.via_assistant) parts.push("via-assistant");
  if (m.root_seq !== null) parts.push(`in:#${m.root_seq}`);
  if (m.retracted) parts.push("retracted");
  else if (m.edited) parts.push(`edited:r${m.rev}`);
  if (m.hop_limited && m.mentions.length > 0) parts.push("hop-limit");
  return `[${parts.join(" ")}]`;
}

const escapeLead = (l: string) => (l.startsWith("[#") ? `\\${l}` : l);

/** Header, then the cleaned body: first line after the header, later lines indented, so no body line starts with `[#`. */
export function messageBlock(m: MsgView, tag: NameTag, o: { c: string; channel?: boolean; cut?: number; refs?: ViewRef[] }): string[] {
  const head = header(m, tag, o.channel ? o.c : undefined);
  if (m.retracted) return [head];
  const clean = cleanLines(m.body);
  const { text, cut } = cutText(clean, o.cut ?? BODY_CUT);
  const out = text.split("\n").map((l, i) => (i === 0 ? (l ? `${head} ${escapeLead(l)}` : head) : `  ${escapeLead(l)}`));
  if (cut) out.push(`  (+${clean.length - text.length} chars, chat.thread c=${o.c} msg=${m.seq})`);
  const refs = refsLine(o.refs ?? []);
  if (refs) out.push(refs);
  if (m.root_seq === null && m.reply_count > 0) out.push(`  replies: ${m.reply_count}, latest #${m.last_reply_seq} (chat.thread c=${o.c} msg=${m.seq})`);
  return out;
}

export type RenderInput = {
  title: string; c: string; messages: MsgView[]; tagOf: TagOf; refs: Map<number, ViewRef[]>; budget: number;
  keep: "oldest" | "newest"; has_more: boolean; full?: number | null;
  /** message number -> the cursor to continue from after showing it (reads after a cursor). */
  cursors?: Record<number, number>;
};
export type Rendered = { text: string; shown: number[]; next_after: number | null; next_before: number | null };

/**
 * A page of messages within a token budget. `keep: "oldest"` (reading after a cursor, threads) drops from the end;
 * `keep: "newest"` (the latest page) drops from the start. At least one message is always shown.
 */
export function renderMessages(o: RenderInput): Rendered {
  const limit = textBudget(o.budget);
  const blocks = o.messages.map((m) => messageBlock(m, o.tagOf(m.author_id, m.session_id), {
    c: o.c, cut: m.seq === o.full ? LIMITS.BODY_MAX : BODY_CUT, refs: o.refs.get(m.seq),
  }).join("\n"));
  let used = [DATA_NOTE, CHAT_NOTE, "", o.title].join("\n").length + 64;
  const order = blocks.map((_, i) => (o.keep === "oldest" ? i : blocks.length - 1 - i));
  const kept = new Set<number>();
  for (const i of order) {
    const size = blocks[i]!.length + 1;
    if (kept.size > 0 && used + size > limit) break;
    kept.add(i);
    used += size;
  }
  const idx = [...kept].sort((a, b) => a - b);
  const shown = idx.map((i) => o.messages[i]!.seq);
  const more = idx.length < o.messages.length || o.has_more;
  const lastShown = shown[shown.length - 1];
  const next_after = o.keep === "oldest" && more && lastShown !== undefined ? o.cursors?.[lastShown] ?? lastShown : null;
  const next_before = o.keep === "newest" && more && shown.length > 0 ? shown[0]! : null;
  const lines = [DATA_NOTE, CHAT_NOTE, "", `${o.title} (${shown.length} of ${o.messages.length}${o.has_more ? "+" : ""} shown)`, ...idx.map((i) => blocks[i]!)];
  if (o.messages.length === 0) lines.push("No messages.");
  if (next_after !== null) lines.push("", `more: pass after=${next_after}`);
  if (next_before !== null) lines.push("", `older: pass before=${next_before}`);
  return { text: lines.join("\n"), shown, next_after, next_before };
}

/** One inbox item: ids, kind, and handle only; no message text (spec 6.3 delivery is content-free). */
export type ItemView = { item: number; kind: string; channel: string; seq: number; msg_id: string; author: string; hop: number; wake: boolean; created_at: number };

export function itemLine(i: ItemView): string {
  if (i.kind === "mail") return `[mail ${hhmm(i.created_at)} from @${i.author} id=${i.msg_id} item=${i.item}; read it with mail_read]`;
  return `[#${i.channel} #${i.seq} ${hhmm(i.created_at)} ${i.kind} by @${i.author} hop${i.hop}${i.wake ? " wake" : ""} item=${i.item}]`;
}

export function plainText(title: string, lines: string[]): string {
  return [DATA_NOTE, CHAT_NOTE, "", title, ...lines].join("\n");
}

/** The `render` of every chat verb: its result carries the text the renderer already wrote. */
export function chatText(result: unknown): string {
  return (result as { text: string }).text;
}
