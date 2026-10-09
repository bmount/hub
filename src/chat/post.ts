import { rank, type Ctx } from "../auth/context";
import { HubError, badRequest, conflict, forbidden, notFound } from "../errors";
import { recordEvent } from "../db/events";
import { listAgentsForOperator } from "../db/agents";
import { MUTE_FOREVER, getControls, listAgentMembers, setAgentMute, type ChannelRow } from "../db/chat";
import { sha256Hex } from "../ids";
import { readableChannel } from "./access";
import { parseBody, parseRefText, type ParsedBody, type ParsedRef } from "./grammar";
import { people } from "./handles";
import { readResult } from "./present";
import { resolveRefs, type Unresolved } from "./refs";
import { LIMITS } from "./rules";
import { conversationStub, inboxStub } from "./stubs";
import type { ReserveResult } from "./inboxDO";
import type { AgentPolicy, Audience, Author, ChatSessionKind, Mention, PostOk, PostOutcome, Refusal, ResponseIntent, ResponseSource, StoredRef } from "./types";

export type PostParams = { c: string; body: string; after: number | null; reply_to: string | null; refs: Array<{ kind: string; key: string }>; idempotency_key: string | null; response_to?: ResponseSource };
export type VersionParams = { c: string; msg: string; body: string | null; after: number | null; idempotency_key: string | null };
export type PostResult = {
  channel: string; seq: number; msg_id: string; rev: number; hop: number; head: number; woke: number; unresolved: Unresolved[];
  mentions_not_waking: number; suppressed: Array<{ identity_id: string; reason: string }>; replayed: boolean;
};

/** Spec 6.1: agents speak only from run sessions; humans from browser sessions, or oauth sessions over MCP. */
function authorOf(ctx: Ctx): Author {
  const id = ctx.identity;
  const s = ctx.session;
  if (!id || !s) throw forbidden("posting needs a session");
  const allowed = id.kind === "agent" ? s.kind === "agent_run" : s.kind === "browser" || s.kind === "oauth";
  if (!allowed) throw forbidden("this session cannot post");
  return { id: id.id, kind: id.kind, session_id: s.id, session_kind: s.kind as ChatSessionKind };
}

const needsAfter = (a: Author) => a.session_kind === "agent_run" || a.session_kind === "oauth";

/** D1 is the truth for who may post and be woken (spec 6.2, 6.7, 9.3), read on every command. */
async function gate(ctx: Ctx, ch: ChannelRow, author: Author, retract = false): Promise<{ audience: Audience; policy: AgentPolicy }> {
  if (ch.state !== "active") throw conflict("channel is archived");
  const [controls, members] = await Promise.all([getControls(ctx.db, ch.tenant_id, ctx.now), listAgentMembers(ctx.db, ch.tenant_id, ch.project_id)]);
  if (author.kind === "agent") {
    if (!controls.agents_enabled) throw new HubError(403, "agents_disabled", "agent posting is switched off in this tenant");
    // A retraction skips the mute and channel-policy checks (ruling C-11); the conversation still limits who may retract what.
    if (!retract && controls.muted.includes(author.id)) throw new HubError(403, "muted", "this agent is muted");
    if (!retract && ch.agent_policy === "muted") throw new HubError(403, "muted", "this channel takes no agent posts");
  }
  const operators: Record<string, string> = {};
  for (const m of members) if (m.operator_id) operators[m.identity_id] = m.operator_id;
  return {
    audience: { agent_members: members.map((m) => m.identity_id), operators, muted_agents: controls.muted, agents_enabled: controls.agents_enabled },
    policy: ch.agent_policy,
  };
}

type Extracted = { resolved: StoredRef[]; unresolved: Unresolved[]; mentions: Mention[]; not_waking: number };

type Structure = { parsed: ParsedBody; all: ParsedRef[] };

/** The checks that need no I/O, run before anything reads D1 or an object: refs and mentions in the text, explicit refs, the ref count. */
function structure(body: string, explicit: Array<{ kind: string; key: string }>): Structure {
  const parsed = parseBody(body);
  const given: ParsedRef[] = explicit.map((r) => {
    const x = parseRefText(r.kind, r.key);
    if (!x) throw badRequest(`not a reference: ${r.kind} ${r.key.slice(0, 64)}`);
    return x;
  });
  const all = [...given, ...parsed.refs];
  if (all.length > LIMITS.REFS_MAX) throw badRequest(`at most ${LIMITS.REFS_MAX} references per message`);
  return { parsed, all };
}

async function extract(ctx: Ctx, s: Structure, me: string): Promise<Extracted> {
  const { parsed, all } = s;
  const dir = await people(ctx.db, ctx.tenant!.id);
  if (!dir.get(me)?.active) throw forbidden("only members of this tenant post");
  const { resolved, unresolved } = await resolveRefs(ctx, all);
  const byHandle = new Map([...dir.values()].filter((p) => p.active).map((p) => [p.handle, p]));
  const mentioned: Mention[] = [];
  for (const h of parsed.handles) {
    const p = byHandle.get(h);
    if (!p) unresolved.push({ kind: "mention", text: `@${h}`, reason: "not_found" });
    else if (p.identity_id !== me) mentioned.push({ identity_id: p.identity_id, kind: p.kind });
  }
  // Spec 6.5: at most 10 agent mentions wake; the rest are rendered and reported. A human's inbox item is never capped.
  let agents = 0;
  const mentions = mentioned.filter((m) => m.kind === "human" || ++agents <= LIMITS.WAKING_MENTIONS_MAX);
  return { resolved, unresolved, mentions, not_waking: mentioned.length - mentions.length };
}

/** Spec 6.5: more than 20 rate or duplicate refusals in an hour mutes the agent tenant-wide and tells its operator. */
async function noteRefusal(ctx: Ctx, author: Author, ch: ChannelRow): Promise<void> {
  if (author.kind !== "agent") return;
  const { count: n, tripped } = (await inboxStub(ctx.env, ch.tenant_id, author.id).noteRefusal(ch.tenant_id, author.id, ctx.now)) as { count: number; tripped: boolean };
  if (!tripped) return;
  await setAgentMute(ctx.db, ch.tenant_id, author.id, MUTE_FOREVER, null, "tripwire");
  await recordEvent(ctx.db, {
    tenant_id: ch.tenant_id, identity_id: author.id, session_id: author.session_id, kind: "chat.tripwire", target_kind: "identity", target_id: author.id,
    summary: `Agent muted after ${n} refused posts within an hour`,
  }, ctx.now);
  const op = ctx.identity!.operator_id;
  if (op) {
    await inboxStub(ctx.env, ch.tenant_id, op).deliver(ch.tenant_id, op, [{
      key: `tripwire:${author.id}:${ctx.now}`, kind: "tripwire", conversation_id: ch.project_id, seq: 0, msg_id: "", thread_root: null,
      hop: 0, author_id: author.id, wake: false, created_at: ctx.now,
    }]);
  }
}

async function refusalError(ctx: Ctx, author: Author, ch: ChannelRow, r: Refusal): Promise<HubError> {
  switch (r.refused) {
    case "stale_view": {
      const missed = await readResult(ctx, ch, r.missed, {
        title: `#${ch.slug} head=${r.head} stale_view: ${r.missed.length} newer`, head: r.head, budget: LIMITS.BUDGET_DEFAULT, keep: "oldest", has_more: false,
      });
      return new HubError(409, "stale_view", "newer messages arrived: read them, then post again with after set to head", { head: r.head, missed: missed.text });
    }
    case "duplicate":
      await noteRefusal(ctx, author, ch);
      return new HubError(409, "duplicate", "you posted this text here in the last 10 minutes");
    case "rate":
      await noteRefusal(ctx, author, ch);
      return new HubError(429, "rate", `retry after ${r.retry_after_s} s`, { retry_after: r.retry_after_s });
    case "needs_human":
      return new HubError(409, "needs_human", "agents posted 8 messages in a row here; a human must post first");
    case "not_found":
      return notFound("no such message");
    case "forbidden":
      return forbidden(r.detail);
    case "edit_cap":
      return new HubError(409, "edit_cap", "a message keeps at most 50 versions");
    case "conflict":
      return conflict(r.detail);
  }
}

function result(ch: ChannelRow, o: PostOk, unresolved: Unresolved[], not_waking: number): PostResult {
  return { channel: ch.slug, seq: o.seq, msg_id: o.msg_id, rev: o.rev, hop: o.hop, head: o.head, woke: o.woke.length, unresolved, mentions_not_waking: not_waking,
    suppressed: o.suppressed.map((x) => ({ identity_id: x.identity_id, reason: x.reason })), replayed: o.replayed };
}

/** Events carry ids only, never text (spec 3). */
async function events(ctx: Ctx, ch: ChannelRow, author: Author, o: PostOk, kind: "chat.post" | "chat.edit" | "chat.retract"): Promise<void> {
  const base = { tenant_id: ch.tenant_id, identity_id: author.id, session_id: author.session_id };
  const verb = { "chat.post": "Posted", "chat.edit": "Edited", "chat.retract": "Retracted" }[kind];
  await recordEvent(ctx.db, { ...base, kind, target_kind: "message", target_id: o.msg_id, summary: `${verb} ${o.msg_id} r${o.rev} in #${ch.slug}` }, ctx.now);
  const hopped = o.suppressed.filter((s) => s.reason === "hop_limit").length;
  if (hopped > 0) {
    await recordEvent(ctx.db, { ...base, kind: "chat.wake_suppressed", target_kind: "message", target_id: o.msg_id, summary: `${hopped} wakes suppressed at hop ${o.hop} in #${ch.slug}` }, ctx.now);
  }
  if (o.loop_tripped) {
    await recordEvent(ctx.db, {
      ...base, kind: "chat.loop_tripped", target_kind: "channel", target_id: ch.project_id,
      summary: `Pair breaker tripped in #${ch.slug} between ${o.loop_tripped.a} and ${o.loop_tripped.b}`,
    }, ctx.now);
  }
}

/** The message is committed by now: a failed event write is logged (name only, never text) and must not turn the success into a 500. */
async function safeEvents(ctx: Ctx, ch: ChannelRow, author: Author, o: PostOk, kind: "chat.post" | "chat.edit" | "chat.retract"): Promise<void> {
  try {
    await events(ctx, ch, author, o, kind);
  } catch (e) {
    console.log("chat event write failed", e instanceof Error ? e.name : "error");
  }
}

export async function postMessage(ctx: Ctx, p: PostParams): Promise<PostResult> {
  const author = authorOf(ctx);
  if (p.after === null && (needsAfter(author) || p.response_to)) throw badRequest("after is required: pass the head from chat.read or chat.catchup");
  const shape = structure(p.body, p.refs);
  const ch = await readableChannel(ctx, p.c);
  const conv = conversationStub(ctx.env, ch.tenant_id, ch.project_id);
  const response: ResponseIntent | undefined = p.response_to ? {
    source: p.response_to, fingerprint: await sha256Hex(JSON.stringify({ body: p.body, refs: p.refs })),
  } : undefined;
  if (response && p.reply_to !== response.source.msg_id) throw badRequest("response_to must be the exact reply target");
  if (!response && p.idempotency_key) {
    const prior = (await conv.replay(ch.tenant_id, ch.project_id, author.id, "post", p.idempotency_key)) as PostOk | null;
    if (prior) return result(ch, prior, [], 0);
  }
  const { audience, policy } = await gate(ctx, ch, author);
  if (response) {
    const prior = (await conv.responseReplay(ch.tenant_id, ch.project_id, author.id, response)) as PostOutcome | null;
    if (prior) {
      if (prior.refused !== null) throw await refusalError(ctx, author, ch, prior);
      return result(ch, prior, [], 0);
    }
  }
  const x = await extract(ctx, shape, author.id);
  const reserve = (await inboxStub(ctx.env, ch.tenant_id, author.id).reserve(ch.tenant_id, author.id, {
    session_id: author.session_id, is_agent: author.kind === "agent", conversation_id: ch.project_id, now: ctx.now,
  })) as ReserveResult;
  if (!reserve.ok) {
    await noteRefusal(ctx, author, ch);
    throw new HubError(429, "rate", `retry after ${reserve.retry_after_s} s`, { retry_after: reserve.retry_after_s });
  }
  const o = (await conv.post({
    tenant_id: ch.tenant_id, conversation_id: ch.project_id, now: ctx.now, author, policy, body: p.body, body_sha256: await sha256Hex(p.body),
    after: p.after, reply_to: p.reply_to, refs: x.resolved, mentions: x.mentions, wake_hop: reserve.wake_hop, thread_wake_hops: reserve.thread_wake_hops, idempotency_key: p.idempotency_key, audience, response,
  })) as PostOutcome;
  if (o.refused !== null) throw await refusalError(ctx, author, ch, o);
  if (!o.replayed) await safeEvents(ctx, ch, author, o, "chat.post");
  return result(ch, o, x.unresolved, x.not_waking);
}

/** Spec 4.4 versions: edit (body) or retract (null). Edits never wake anyone. */
export async function versionMessage(ctx: Ctx, p: VersionParams): Promise<PostResult> {
  const author = authorOf(ctx);
  const retract = p.body === null;
  if (!retract && p.after === null && needsAfter(author)) throw badRequest("after is required: pass the head from chat.read");
  const shape = retract ? null : structure(p.body!, []);
  const ch = await readableChannel(ctx, p.c);
  const conv = conversationStub(ctx.env, ch.tenant_id, ch.project_id);
  if (p.idempotency_key) {
    const prior = (await conv.replay(ch.tenant_id, ch.project_id, author.id, retract ? "retract" : "edit", p.idempotency_key)) as PostOk | null;
    if (prior) return result(ch, prior, [], 0);
  }
  await gate(ctx, ch, author, retract);
  // An agent's edits count against its per-session window like its posts, so edit loops are limited too. A retraction is
  // exempt from the window and the tripwire (ruling C-8): taking back what it said must always be possible.
  if (author.kind === "agent" && !retract) {
    const reserve = (await inboxStub(ctx.env, ch.tenant_id, author.id).reserve(ch.tenant_id, author.id, {
      session_id: author.session_id, is_agent: true, conversation_id: ch.project_id, now: ctx.now,
    })) as ReserveResult;
    if (!reserve.ok) {
      await noteRefusal(ctx, author, ch);
      throw new HubError(429, "rate", `retry after ${reserve.retry_after_s} s`, { retry_after: reserve.retry_after_s });
    }
  }
  const x: Extracted = shape ? await extract(ctx, shape, author.id) : { resolved: [], unresolved: [], mentions: [], not_waking: 0 };
  const operatorOf = author.kind === "human"
    ? (await listAgentsForOperator(ctx.db, author.id)).filter((a) => a.tenant.id === ch.tenant_id).map((a) => a.identity.id)
    : [];
  const o = (await conv.version({
    tenant_id: ch.tenant_id, conversation_id: ch.project_id, now: ctx.now, actor: author, msg: p.msg, body: p.body,
    body_sha256: retract ? "" : await sha256Hex(p.body!), after: retract ? null : p.after, refs: x.resolved, mentions: x.mentions,
    operator_of: operatorOf, is_admin: rank(ctx.role) >= rank("admin"), idempotency_key: p.idempotency_key,
  })) as PostOutcome;
  if (o.refused !== null) throw await refusalError(ctx, author, ch, o);
  await safeEvents(ctx, ch, author, o, retract ? "chat.retract" : "chat.edit");
  return result(ch, o, x.unresolved, x.not_waking);
}
