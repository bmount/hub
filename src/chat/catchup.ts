import type { Ctx } from "../auth/context";
import { HubError, badRequest, notFound } from "../errors";
import { DATA_NOTE, cleanText, cutText } from "../mcp/render";
import { readableChannels, viewerOf } from "./access";
import { CHAT_NOTE, messageBlock, refShort, textBudget } from "./compact";
import { nameTags, people } from "./handles";
import { msgJson, type MsgJson } from "./present";
import { refsForViewer } from "./refs";
import { conversationStub, inboxStub } from "./stubs";
import type { Digest, MsgView } from "./types";

export type CatchupParams = { since: string | null; budget: number; scope: string | null; advance: boolean };
type ConvSummary = { channel: string; head: number; since: number; new: number; agent: number; threads: Array<{ seq: number; replies: number }>; authors: string[]; refs: string[] };
export type CatchupResult = {
  budget: number; used_tokens: number; omitted: number; next: string; advanced: boolean;
  for_you: Array<MsgJson & { channel: string }>;
  threads: Array<{ channel: string; root_seq: number; replies: number; latest_seq: number; latest_author: string }>;
  conversations: ConvSummary[];
  quiet: Array<{ channel: string; head: number; new: number; agent: number }>;
  text: string;
};

const PREFIX = "c1.";
const toB64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
const firstLine = (s: string) => s.split(/\r\n|[\n\r\u0085\u2028\u2029]/)[0] ?? "";

/** The `next` cursor: per-conversation seqs, opaque to callers, validated on the way back in. */
export function encodeCursors(c: Record<string, number>): string {
  return PREFIX + toB64url(JSON.stringify(c));
}

export function decodeCursors(s: string): Record<string, number> {
  const bad = () => badRequest("since is not a catch-up cursor: pass the next value from chat.catchup");
  if (!s.startsWith(PREFIX) || s.length > 8192) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromB64url(s.slice(PREFIX.length)));
  } catch {
    throw bad();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw bad();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^[0-9A-Z]{26}$/.test(k) || typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw bad();
    out[k] = v;
  }
  if (Object.keys(out).length > 500) throw bad();
  return out;
}

/**
 * Messaging spec 7.4, extractive: tier 2 (messages for me, bodies cut at 400), tier 4 (my threads: count and the
 * newest), tiers 5 and 6 (per channel: a summary where it fits, else one line). Tiers 1 and 3 (handoffs, decisions)
 * arrive with phase 2. A channel counts as covered only if nothing of it was omitted; `next` and `advance` move
 * exactly the covered channels to their heads.
 */
export async function catchup(ctx: Ctx, p: CatchupParams): Promise<CatchupResult> {
  const v = viewerOf(ctx);
  if (p.advance && ctx.authKind === "oauth") throw new HubError(403, "forbidden", "assistant connections read without moving cursors: advance is not available over MCP");
  const box = inboxStub(ctx.env, v.tenant.id, v.identity.id);
  const base = p.since ? decodeCursors(p.since) : ((await box.cursors(v.tenant.id, v.identity.id)) as Record<string, number>);
  let chans = await readableChannels(ctx.db, v, "active");
  const readable = new Set(chans.map((c) => c.project_id));
  if (p.scope) {
    const want = p.scope.replace(/^#/, "");
    chans = chans.filter((c) => c.slug === want);
    if (chans.length === 0) throw notFound("no such channel");
  }
  const digests = (await Promise.all(chans.map((c) => conversationStub(ctx.env, v.tenant.id, c.project_id).digest({
    tenant_id: v.tenant.id, conversation_id: c.project_id, since: base[c.project_id] ?? 0, me: v.identity.id, max_items: 20,
  })))) as Digest[];
  const active = chans.map((ch, i) => ({ ch, d: digests[i]! })).filter((x) => x.d.head > x.d.since);
  const views: MsgView[] = active.flatMap(({ d }) => [...d.mentions_me, ...d.my_threads.flatMap((t) => [t.root, t.newest]), ...d.threads.map((t) => t.root)]);
  const tagOf = await nameTags(ctx.db, v.tenant.id, views.map((m) => ({ author_id: m.author_id, session_id: m.session_id })));
  const dir = await people(ctx.db, v.tenant.id);
  const handle = (id: string) => (id === "hub" ? "hub" : dir.get(id)?.handle ?? "unknown");

  const limit = textBudget(p.budget);
  const lines = [DATA_NOTE, CHAT_NOTE, ""];
  // Room for the trailer: the omitted count and a cursor of about 48 characters per channel.
  let used = lines.join("\n").length + 64 + 48 * (Object.keys(base).length + active.length);
  let omitted = 0;
  const incomplete = new Set<string>();
  const fits = (block: string[]) => {
    const size = block.join("\n").length + 1;
    if (used + size > limit) return false;
    lines.push(...block);
    used += size;
    return true;
  };
  const out = { for_you: [] as CatchupResult["for_you"], threads: [] as CatchupResult["threads"], conversations: [] as ConvSummary[], quiet: [] as CatchupResult["quiet"] };

  // A digest cut at its cap leaves items unseen: the channel is incomplete (its cursor stays) and each cut counts as omitted.
  for (const { ch, d } of active) {
    for (const cut of [d.mentions_truncated, d.my_threads_truncated]) {
      if (!cut) continue;
      omitted++;
      incomplete.add(ch.project_id);
    }
  }
  const mentions = active.flatMap(({ ch, d }) => d.mentions_me.map((m) => ({ ch, m }))).sort((a, b) => a.m.created_at - b.m.created_at);
  if (mentions.length > 0) fits(["## For you"]);
  for (const { ch, m } of mentions) {
    const refs = await refsForViewer(ctx.db, v, m.refs);
    const tag = tagOf(m.author_id, m.session_id);
    if (fits(messageBlock(m, tag, { c: ch.slug, channel: true, cut: 400, refs }))) out.for_you.push({ ...msgJson(m, tag, refs), channel: ch.slug });
    else {
      omitted++;
      incomplete.add(ch.project_id);
    }
  }

  const mine = active.flatMap(({ ch, d }) => d.my_threads.map((t) => ({ ch, t })));
  if (mine.length > 0) fits(["## Your threads"]);
  for (const { ch, t } of mine) {
    const latest = cutText(cleanText(t.newest.retracted ? "(retracted)" : t.newest.body), 120).text;
    const by = handle(t.newest.author_id);
    const head = `[#${ch.slug} #${t.root.seq} ${t.replies} new ${t.replies === 1 ? "reply" : "replies"}, latest #${t.newest.seq} by @${by}]`;
    if (fits([`${head} ${JSON.stringify(latest)}`])) out.threads.push({ channel: ch.slug, root_seq: t.root.seq, replies: t.replies, latest_seq: t.newest.seq, latest_author: by });
    else {
      omitted++;
      incomplete.add(ch.project_id);
    }
  }

  const covered = new Set<string>();
  const order = [...active].sort((a, b) => b.d.new_messages - a.d.new_messages || a.ch.slug.localeCompare(b.ch.slug));
  if (order.length > 0) fits(["## Channels"]);
  for (const { ch, d } of order) {
    const line = `#${ch.slug} +${d.new_messages} (${d.agent_messages} agent) head=${d.head}`;
    const detail = [line];
    for (const t of d.threads) {
      const first = cutText(cleanText(t.root.retracted ? "(retracted)" : firstLine(t.root.body)), 60).text;
      detail.push(`  thread #${t.root.seq} (${t.replies} new) ${JSON.stringify(first)}`);
    }
    if (d.authors.length > 0) detail.push(`  by: ${d.authors.map((a) => `@${handle(a)}`).join(" ")}`);
    if (d.refs.length > 0) detail.push(`  refs: ${d.refs.map(refShort).join(" ")}`);
    const summary: ConvSummary = {
      channel: ch.slug, head: d.head, since: d.since, new: d.new_messages, agent: d.agent_messages,
      threads: d.threads.map((t) => ({ seq: t.root.seq, replies: t.replies })), authors: d.authors.map(handle), refs: d.refs.map(refShort),
    };
    if (fits(detail)) {
      out.conversations.push(summary);
      covered.add(ch.project_id);
    } else if (fits([line])) {
      out.quiet.push({ channel: ch.slug, head: d.head, new: d.new_messages, agent: d.agent_messages });
      covered.add(ch.project_id);
    } else {
      omitted++;
    }
  }
  if (active.length === 0) lines.push("Nothing new.");

  // Cursors for channels the reader can no longer read (left, archived, removed) are dropped.
  const nextCursors: Record<string, number> = Object.fromEntries(Object.entries(base).filter(([k]) => readable.has(k)));
  const done = active.filter(({ ch }) => covered.has(ch.project_id) && !incomplete.has(ch.project_id));
  for (const { ch, d } of done) nextCursors[ch.project_id] = d.head;
  if (p.advance) for (const { ch, d } of done) await box.markRead(v.tenant.id, v.identity.id, ch.project_id, d.head);
  const next = encodeCursors(nextCursors);
  lines.push("", `omitted: ${omitted}`, `next: since=${next}`);
  return { budget: p.budget, used_tokens: Math.ceil(used / 4), omitted, next, advanced: p.advance, ...out, text: lines.join("\n") };
}
