import { sameOrigin } from "./login";
import { ASSETS } from "../assets";
import type { Env } from "../env";
import { shellFor } from "./shell";
import { buildContext, rank, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { HubError } from "../errors";
import { esc, htmlResponse, page } from "../html";
import { runVerb } from "../verbs/dispatch";
import { getVerb } from "../verbs/table";
import { getChannelById } from "../db/chat";
import { refShort, type ItemView } from "../chat/compact";
import type { AuthorJson, MsgJson, ReadResult } from "../chat/present";
import type { ViewRef } from "../chat/types";
import { notFoundPage } from "./pages";
import { MAX_CHANNEL_FORM_BODY_BYTES, readRequestForm } from "./body";
import { KINDS, STATES, type WorkKind, type WorkState } from "../work/names";

type Extra = Record<string, string>;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NAV = `<p class="chips"><a class="chip" href="/c">Channels</a> <a class="chip" href="/inbox">Inbox</a></p>`;

/** Browser sessions on a tenant host only (spec 11.4); everyone else signs in or gets the ordinary 404. */
async function pageCtx(request: Request, env: Env): Promise<{ ctx: Ctx; extra: Extra } | Response> {
  const ctx = await buildContext(request, env);
  const extra: Extra = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant) return notFoundPage(extra);
  if (!ctx.identity || !ctx.session) {
    return new Response(null, { status: 303, headers: { location: `https://${env.HUB_DOMAIN}/login?next=${ctx.tenant.slug}`, "cache-control": "no-store", ...extra } });
  }
  if (ctx.authKind !== "cookie" || ctx.identity.kind !== "human" || !ctx.role) return notFoundPage(extra);
  return { ctx, extra };
}

function verb<T>(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<T> {
  return runVerb(ctx, getVerb(name)!, input) as Promise<T>;
}

function errorPage(e: unknown, extra: Extra): Response {
  if (e instanceof HubError) {
    if (e.status === 404) return notFoundPage(extra);
    return htmlResponse(page("Not done", `<h1>Not done</h1><p>${esc(e.detail ?? e.reason)}</p>${NAV}`), e.status, extra);
  }
  console.error("chat page failed", e instanceof Error ? e.name : "error");
  return htmlResponse(page("Error", "<h1>Something went wrong</h1>"), 500, extra);
}

type Conversation = { channel: string; display_name: string; topic: string; head: number; read_seq: number };

async function conversations(ctx: Ctx): Promise<Conversation[]> {
  const r = await verb<{ conversations: Conversation[] }>(ctx, "chat.conversations", {});
  return r.conversations;
}

function channelLink(c: Conversation, active = ""): string {
  const unread = c.head > c.read_seq;
  return `<li class="${unread ? "is-unread" : ""}"><a href="/c/${esc(c.channel)}"${active === c.channel ? ' aria-current="page"' : ""}>#${esc(c.channel)}${unread ? ' <span class="pill">Unread</span>' : ""}</a></li>`;
}

/** Only chat.conversations supplies discovery and rail data; no unfiltered project queries. */
function workspace(channels: Conversation[], active: string, content: string): string {
  const rail = `<aside class="channel-rail" aria-label="Chat workspace"><h2>Chat</h2>${NAV}<nav aria-label="Channels"><ul>${channels.map((c) => channelLink(c, active)).join("") || "<li>No active channels.</li>"}</ul></nav></aside>`;
  return `<div class="chat-workspace">${rail}<section class="channel-content" aria-label="${esc(active ? `#${active}` : "Channel discovery")}">${content}</section></div>`;
}

function presencePanel(slug: string, channels: Conversation[]): string {
  // Archived channels still have readable history, but must not publish or display live presence.
  if (!channels.some((c) => c.channel === slug)) return "";
  return `<section data-chat-presence="${esc(slug)}" aria-label="Channel presence"><h2>Presence</h2><p data-presence-connection role="status">Presence not connected. Current status is unknown.</p><p data-presence-freshness>No current presence snapshot.</p><p data-presence-sharing>Not sharing. Loading or reading this page does not publish a heartbeat.</p><button type="button" data-presence-toggle>Share presence in this channel</button><ul data-presence-list></ul><noscript>Live presence needs JavaScript; no heartbeat is published without it.</noscript></section><script defer src="${ASSETS.presence.path}"></script>`;
}

function markRead(slug: string, head: number, back: string): string {
  // Explicit POST only: loading a page (possibly paginated or truncated) does not silently clear unread state.
  return `<form class="inline" method="post" action="/api/chat.mark_read"><input type="hidden" name="_back" value="${esc(back)}"><input type="hidden" name="c" value="${esc(slug)}"><input type="hidden" name="seq" value="${head}"><button class="quiet" type="submit">Mark channel read through #${head}</button></form>`;
}

const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** The name tag as the server computed it; nothing here comes from message text. */
function tagHtml(a: AuthorJson): string {
  const bits = [`<strong>@${esc(a.handle)}</strong>`, esc(a.display_name)];
  if (a.kind === "agent") bits.push(`<small>agent${a.operator ? ` · op @${esc(a.operator)}` : ""}${a.run ? ` · run ${esc(a.run)}` : ""}</small>`);
  if (a.via_assistant) bits.push("<small>via assistant</small>");
  return bits.join(" ");
}

function refHtml(r: ViewRef): string {
  if (r.no_access) return `<code>${esc(refShort(r))}</code> (no access)`;
  return `<code>${esc(refShort(r))}</code>${r.title ? ` ${esc(r.title)}` : ""}`;
}

/** Original server-recorded posting evidence, not task status or execution authority. */
function responseHtml(m: MsgJson): string {
  const source = m.response_to;
  if (!source) return ""; // Ordinary/legacy replies have no public attribution; never infer it from text.
  return `<p class="response-attribution"><small>Recorded ${esc(source.stage)} response to <a href="/m/${esc(source.msg_id)}">#${source.seq}</a> (source r${source.rev}). Posting attribution only; not proof of execution or completion.</small></p>`;
}

function msgHtml(slug: string, m: MsgJson, inThread: boolean, readSeq?: number): string {
  const marks = m.retracted ? " <em>retracted</em>" : m.edited ? ` <em>edited r${m.rev}</em>` : "";
  const who = m.system ? "<strong>hub</strong>" : tagHtml(m.author);
  const body = m.retracted ? "" : `<pre style="white-space:pre-wrap;margin:.25rem 0">${esc(m.body)}</pre>`;
  const refs = m.refs.length > 0 ? `<p><small>${m.refs.map(refHtml).join(" · ")}</small></p>` : "";
  const newThreadActivity = readSeq !== undefined && m.last_reply_seq !== null && m.last_reply_seq > readSeq
    ? ` · <a href="/c/${esc(slug)}/t/${m.seq}?after=${readSeq}">New thread activity</a>` : "";
  const thread = inThread || m.system ? "" : `<p><small><a href="/c/${esc(slug)}/t/${m.seq}">${m.reply_count > 0 ? `${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}` : "reply"}</a>${newThreadActivity}</small></p>`;
  return `<article class="channel-message" id="m${m.seq}"><p><a href="/m/${esc(m.msg_id)}">#${m.seq}</a> ${when(m.created_at)} ${who}${marks}</p>${responseHtml(m)}${body}${refs}${thread}</article>`;
}

/** A read cursor is an activity watermark, not an unread count. Mark only new message sequences. */
function channelMessages(slug: string, messages: MsgJson[], readSeq: number | undefined): string {
  const firstUnread = readSeq === undefined ? undefined : messages.find((m) => m.seq > readSeq);
  return messages.map((m) => `${m === firstUnread ? '<h2 class="unread-divider" id="unread">Messages after your read marker</h2>' : ""}${msgHtml(slug, m, false, readSeq)}`).join("");
}

function compose(action: string, head: number, draft: string, notice: string, label: string): string {
  const note = notice ? `<p role="status"><strong>${esc(notice)}</strong></p>` : "";
  return `${note}<form class="channel-compose" method="post" action="${esc(action)}"><input type="hidden" name="after" value="${head}">`
    + `<label for="chat-body">${esc(label === "Reply" ? "Reply in thread" : "Message channel")}</label><textarea id="chat-body" data-voice name="body" rows="4" cols="60" maxlength="8192" required>${esc(draft)}</textarea><button type="submit">${esc(label)}</button></form>`;
}

export async function channelsPage(request: Request, env: Env): Promise<Response> {
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  try {
    const channels = await conversations(pc.ctx);
    const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 100);
    const matches = channels.filter((c) => `${c.channel} ${c.display_name} ${c.topic}`.toLowerCase().includes(q.toLowerCase()));
    const rows = matches.map((c) => `<li class="card"><h3><a href="/c/${esc(c.channel)}">#${esc(c.channel)}</a>${c.head > c.read_seq ? ' <span class="pill">Unread</span>' : ""}</h3><p>${esc(c.display_name)}</p><p>${esc(c.topic)}</p></li>`).join("");
    const search = `<form class="filters" method="get" action="/c"><label for="channel-query">Find a channel</label><input id="channel-query" name="q" maxlength="100" value="${esc(q)}"><button type="submit">Find</button></form>`;
    const forms = rank(pc.ctx.role) >= rank("member") ? `<details class="edit"><summary>Manage channels</summary><h2>New channel</h2><p>Channels are readable by organization members. Agents need explicit access.</p><form method="post" action="/api/channel.create"><input type="hidden" name="_back" value="/c">`
      + `<label>Channel name <input name="slug" maxlength="63" placeholder="name" required></label> <button type="submit">Create</button></form>`
      + `<h2>Add an agent you operate</h2><form method="post" action="/api/channel.add_agent"><input type="hidden" name="_back" value="/c">`
      + `<label>Channel <input name="c" required></label> <label>Agent <input name="agent" required></label> <button type="submit">Add</button></form></details>` : "";
    const content = `<h1>Channels</h1><p class="lede">Discover conversations you can read in this organization.</p>${search}<ul class="channel-directory grid">${rows || "<li>No matching active channels.</li>"}</ul>${forms}`;
    return htmlResponse(page("Chat", workspace(channels, "", content), shellFor(pc.ctx, env, "chat")), 200, pc.extra);
  } catch (e) {
    return errorPage(e, pc.extra);
  }
}

export async function channelPage(request: Request, env: Env, slug: string, draft = "", notice = ""): Promise<Response> {
  if (!SLUG.test(slug)) return notFoundPage();
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  try {
    const before = new URL(request.url).searchParams.get("before");
    const r = await verb<ReadResult>(pc.ctx, "chat.read", { c: slug, limit: 50, budget: 8000, ...(before && /^\d{1,12}$/.test(before) ? { before } : {}) });
    const older = r.next_before !== null ? `<p><a href="/c/${esc(r.channel)}?before=${r.next_before}">older messages</a></p>` : "";
    const channels = await conversations(pc.ctx);
    const current = channels.find((c) => c.channel === r.channel);
    const hasUnreadMessages = current && r.messages.some((m) => m.seq > current.read_seq);
    const unreadLink = hasUnreadMessages ? ' <a class="chip" href="#unread">Jump to new messages on this page</a>' : "";
    const partial = `<p class="lede">${r.next_before !== null ? "This is a partial channel view. Older messages may also be unread. " : ""}The channel shows top-level messages; open threads to read replies. Marking the channel read acknowledges all activity through the displayed head, including activity not shown here.</p>`;
    const body = `<header class="channel-header"><h1>#${esc(r.channel)}</h1><p class="lede">${esc(current?.topic ?? "")}</p><a class="chip" href="/c/${esc(r.channel)}">Refresh</a>${unreadLink} ${markRead(r.channel, r.head, `/c/${r.channel}`)}</header>${presencePanel(r.channel, channels)}${partial}${older}`
      + `<div class="channel-messages">${channelMessages(r.channel, r.messages, current?.read_seq) || '<p class="lede">No messages yet. Start a conversation.</p>'}</div>`
      + (rank(pc.ctx.role) >= rank("member") ? compose(`/c/${r.channel}`, r.head, draft, notice, "Post") : '<p class="lede">You have read-only access.</p>');
    return htmlResponse(page(`#${r.channel}`, workspace(channels, r.channel, body), shellFor(pc.ctx, env, "chat")), 200, pc.extra);
  } catch (e) {
    return errorPage(e, pc.extra);
  }
}

export async function threadPage(request: Request, env: Env, slug: string, seq: string, draft = "", notice = ""): Promise<Response> {
  if (!SLUG.test(slug) || !/^\d{1,12}$/.test(seq)) return notFoundPage();
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  try {
    const after = new URL(request.url).searchParams.get("after");
    const r = await verb<ReadResult>(pc.ctx, "chat.thread", { c: slug, msg: seq, budget: 8000, ...(after && /^\d{1,12}$/.test(after) ? { after } : {}) });
    const root = r.messages[0]!;
    const channels = await conversations(pc.ctx);
    const body = `<header class="channel-header"><p><a href="/c/${esc(r.channel)}">back to #${esc(r.channel)}</a></p><h1>Thread #${root.seq}</h1><a class="chip" href="/c/${esc(r.channel)}/t/${root.seq}">Refresh thread</a></header>${presencePanel(r.channel, channels)}`
      + `<section class="thread-root" aria-labelledby="thread-original"><h2 id="thread-original">Original message</h2>${msgHtml(r.channel, root, true)}</section>`
      + `<section aria-labelledby="thread-replies"><h2 id="thread-replies">Replies${after ? " (continued)" : ""}</h2><div class="channel-messages">${r.messages.slice(1).map((m) => msgHtml(r.channel, m, true)).join("") || '<p class="lede">No replies shown.</p>'}</div></section>`
      + (r.next_after !== null ? `<p><a href="/c/${esc(r.channel)}/t/${root.seq}?after=${r.next_after}">More replies</a></p>` : "")
      + (rank(pc.ctx.role) >= rank("member") ? compose(`/c/${r.channel}/t/${root.seq}`, r.head, draft, notice, "Reply") : '<p class="lede">You have read-only access.</p>');
    return htmlResponse(page(`#${r.channel} thread`, workspace(channels, r.channel, body), shellFor(pc.ctx, env, "chat")), 200, pc.extra);
  } catch (e) {
    return errorPage(e, pc.extra);
  }
}

/** Compose handler for /c/:slug and /c/:slug/t/:seq. A stale view shows the new messages and keeps the draft (spec 6.4). */
export async function channelPost(request: Request, env: Env, slug: string, threadSeq: string | null): Promise<Response> {
  if (!SLUG.test(slug) || (threadSeq !== null && !/^\d{1,12}$/.test(threadSeq))) return notFoundPage();
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  if (!sameOrigin(request)) return htmlResponse(page("Forbidden", "<h1>Forbidden</h1>"), 403, pc.extra);
  if (rank(pc.ctx.role) < rank("member")) return htmlResponse(page("Forbidden", "<h1>Forbidden</h1>"), 403, pc.extra);
  let form: FormData | null;
  try { form = await readRequestForm(request, MAX_CHANNEL_FORM_BODY_BYTES); }
  catch (e) { return errorPage(e, pc.extra); }
  if (!form) return htmlResponse(page("Bad request", "<h1>Bad request</h1>"), 400, pc.extra);
  const body = String(form.get("body") ?? "");
  const after = String(form.get("after") ?? "");
  const back = threadSeq ? `/c/${slug}/t/${threadSeq}` : `/c/${slug}`;
  try {
    await verb(pc.ctx, "chat.post", { c: slug, body, ...(after ? { after } : {}), ...(threadSeq ? { reply_to: threadSeq } : {}) });
    return new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store", ...pc.extra } });
  } catch (e) {
    if (e instanceof HubError && e.reason === "stale_view") {
      const notice = "New activity arrived while you were writing. The refreshed view is above and may be partial; your draft is below. Review the activity and post again when ready.";
      return threadSeq ? threadPage(request, env, slug, threadSeq, body, notice) : channelPage(request, env, slug, body, notice);
    }
    return errorPage(e, pc.extra);
  }
}

export async function permalinkPage(request: Request, env: Env, msgId: string): Promise<Response> {
  if (!ULID.test(msgId)) return notFoundPage();
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  const row = await env.HUB_DB.prepare("SELECT conversation_id FROM msg_index WHERE tenant_id = ? AND msg_id = ? LIMIT 1").bind(pc.ctx.tenant!.id, msgId).first<{ conversation_id: string }>();
  const ch = row ? await getChannelById(env.HUB_DB, pc.ctx.tenant!.id, row.conversation_id) : null;
  if (!ch) return notFoundPage(pc.extra);
  try {
    const h = await verb<{ channel: string; seq: number; versions: Array<{ rev: number; author: AuthorJson; body: string; retracted: boolean; created_at: number }> }>(
      pc.ctx, "chat.history", { c: ch.slug, msg: msgId },
    );
    const versions = h.versions.map((x) => `<article><p>r${x.rev} ${when(x.created_at)} ${tagHtml(x.author)}${x.retracted ? " <em>retracted</em>" : ""}</p>`
      + `${x.retracted ? "" : `<pre style="white-space:pre-wrap;margin:.25rem 0">${esc(x.body)}</pre>`}</article>`).join("");
    // History authorization precedes the work lookup; a recorded link cannot grant channel access.
    const related = await pc.ctx.db.prepare(`SELECT w.id, p.slug AS project, w.number, w.kind, w.state, w.title,
      CASE WHEN w.source_kind = 'message' AND w.source_ref = ? THEN 'filed' ELSE 'linked' END AS relationship
      FROM msg_index mi JOIN work_item w ON w.tenant_id = mi.tenant_id
      JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'
      WHERE mi.msg_id = ? AND mi.tenant_id = ? AND mi.conversation_id = ? AND typeof(w.number) = 'integer' AND w.number BETWEEN 1 AND 99999999 AND
        ((w.source_kind = 'message' AND w.source_ref = ?) OR EXISTS
          (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND l.target_kind = 'message' AND l.target_ref = ?))
      ORDER BY w.created_at DESC, w.id DESC LIMIT 51`)
      .bind(msgId, msgId, pc.ctx.tenant!.id, ch.project_id, msgId, msgId)
      .all<{ id: string; project: string; number: number; kind: WorkKind; state: WorkState; title: string; relationship: "filed" | "linked" }>();
    const work = related.results.slice(0, 50);
    const workHtml = `<h2>Recorded work</h2><p>Recorded associations do not prove that a message authorized, approved or completed the work.</p>
${work.length ? `<table><tbody>${work.map(w => `<tr><td>${esc(w.project)}#${w.number}</td><td>${esc(KINDS[w.kind].name)}</td><td><a href="/${esc(encodeURIComponent(w.project))}/w/${w.number}">${esc(w.title)}</a></td><td>${esc(STATES[w.state])}</td><td>${w.relationship}</td></tr>`).join("")}</tbody></table>` : "<p>No work associations recorded for this message.</p>"}
<p>${work.length} related work items shown${related.results.length > 50 ? "; capped at 50, more omitted" : "; complete for recorded associations"}.</p>`;
    const body = `<h1>#${esc(h.channel)} message #${h.seq}</h1>${NAV}<p><a href="/c/${esc(h.channel)}/t/${h.seq}">in context</a></p>${versions}${workHtml}`;
    return htmlResponse(page(`#${h.channel} #${h.seq}`, body, shellFor(pc.ctx, env, "chat")), 200, pc.extra);
  } catch (e) {
    return errorPage(e, pc.extra);
  }
}

export async function inboxPage(request: Request, env: Env): Promise<Response> {
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  try {
    const r = await verb<{ head: number; items: ItemView[] }>(pc.ctx, "chat.inbox", {});
    const rows = r.items.map((i) => {
      const where = i.msg_id ? `<a href="/m/${esc(i.msg_id)}">#${esc(i.channel)} #${i.seq}</a>` : `#${esc(i.channel)}`;
      return `<li>${esc(i.kind.replace("_", " "))} in ${where} by @${esc(i.author)} · ${when(i.created_at)}</li>`;
    }).join("");
    const ack = r.items.length > 0
      ? `<form method="post" action="/api/inbox.ack"><input type="hidden" name="_back" value="/inbox"><input type="hidden" name="through" value="${r.head}"><button type="submit">Clear all</button></form>`
      : "";
    return htmlResponse(page("Inbox", `<h1>Inbox</h1>${NAV}<ul>${rows || "<li>Nothing open.</li>"}</ul>${ack}`, shellFor(pc.ctx, env, "chat")), 200, pc.extra);
  } catch (e) {
    return errorPage(e, pc.extra);
  }
}
