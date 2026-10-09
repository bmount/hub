import type { Ctx } from "../auth/context";
import type { ChannelRow } from "../db/chat";
import { viewerOf } from "./access";
import { renderMessages } from "./compact";
import { nameTags, type NameTag, type TagOf } from "./handles";
import { refsForViewer } from "./refs";
import type { MsgView, ResponseAttribution, ViewRef } from "./types";

/** Spec 11.3: "The JSON form keeps author fields and body in separate keys." */
export type AuthorJson = {
  identity_id: string; handle: string; display_name: string; kind: NameTag["kind"]; operator: string | null; session_id: string | null; session_kind: NameTag["session_kind"]; run: string | null; via_assistant: boolean;
};
export type MsgJson = {
  seq: number; msg_id: string; rev: number; root_seq: number | null; author: AuthorJson; hop: number; body: string; edited: boolean;
  retracted: boolean; system: boolean; reply_count: number; last_reply_seq: number | null; refs: ViewRef[]; created_at: number; updated_at: number;
  response_to: ResponseAttribution | null;
};

export function authorJson(t: NameTag): AuthorJson {
  return { identity_id: t.identity_id, handle: t.handle, display_name: t.display_name, kind: t.kind, operator: t.operator_handle, session_id: t.session_id, session_kind: t.session_kind, run: t.session_label, via_assistant: t.via_assistant };
}

export function msgJson(m: MsgView, t: NameTag, refs: ViewRef[]): MsgJson {
  return {
    seq: m.seq, msg_id: m.msg_id, rev: m.rev, root_seq: m.root_seq, author: authorJson(t), hop: m.hop, body: m.retracted ? "" : m.body, edited: m.edited,
    retracted: m.retracted, system: m.kind === "system", reply_count: m.reply_count, last_reply_seq: m.last_reply_seq, refs, created_at: m.created_at, updated_at: m.updated_at,
    response_to: m.response_to ?? null,
  };
}

/** Name tags and per-viewer refs for a set of messages (spec 4.6, 5.2). */
export async function present(ctx: Ctx, msgs: MsgView[]): Promise<{ tagOf: TagOf; refs: Map<number, ViewRef[]> }> {
  const v = viewerOf(ctx);
  const tagOf = await nameTags(ctx.db, v.tenant.id, msgs.map((m) => ({ author_id: m.author_id, session_id: m.session_id, session_kind: m.session_kind })));
  const refs = new Map<number, ViewRef[]>();
  for (const m of msgs) if (m.refs.length > 0) refs.set(m.seq, await refsForViewer(ctx.db, v, m.refs));
  return { tagOf, refs };
}

export type ReadResult = { tenant_id: string; conversation_id: string; channel: string; head: number; messages: MsgJson[]; next_after: number | null; next_before: number | null; text: string };

/** Compact text within the budget, and JSON for exactly the messages the text shows. */
export async function readResult(
  ctx: Ctx, ch: ChannelRow, msgs: MsgView[], o: { title: string; head: number; budget: number; keep: "oldest" | "newest"; has_more: boolean; full?: number | null; cursors?: Record<number, number> },
): Promise<ReadResult> {
  const { tagOf, refs } = await present(ctx, msgs);
  const r = renderMessages({ title: o.title, c: ch.slug, messages: msgs, tagOf, refs, budget: o.budget, keep: o.keep, has_more: o.has_more, full: o.full ?? null, cursors: o.cursors });
  const shown = new Set(r.shown);
  return {
    tenant_id: ch.tenant_id, conversation_id: ch.project_id, channel: ch.slug, head: o.head,
    messages: msgs.filter((m) => shown.has(m.seq)).map((m) => msgJson(m, tagOf(m.author_id, m.session_id, m.session_kind), refs.get(m.seq) ?? [])),
    next_after: r.next_after, next_before: r.next_before, text: r.text,
  };
}
