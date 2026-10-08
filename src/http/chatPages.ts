import { sameOrigin } from "./login";
import type { Env } from "../env";
import { shellFor } from "./shell";
import { buildContext, type Ctx } from "../auth/context";
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

function msgHtml(slug: string, m: MsgJson, inThread: boolean): string {
  const marks = m.retracted ? " <em>retracted</em>" : m.edited ? ` <em>edited r${m.rev}</em>` : "";
  const who = m.system ? "<strong>hub</strong>" : tagHtml(m.author);
  const body = m.retracted ? "" : `<pre style="white-space:pre-wrap;margin:.25rem 0">${esc(m.body)}</pre>`;
  const refs = m.refs.length > 0 ? `<p><small>${m.refs.map(refHtml).join(" · ")}</small></p>` : "";
  const thread = inThread || m.system ? "" : `<p><small><a href="/c/${esc(slug)}/t/${m.seq}">${m.reply_count > 0 ? `${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}` : "reply"}</a></small></p>`;
  return `<article id="m${m.seq}"><p><a href="/m/${esc(m.msg_id)}">#${m.seq}</a> ${when(m.created_at)} ${who}${marks}</p>${body}${refs}${thread}</article>`;
}

function compose(action: string, head: number, draft: string, notice: string, label: string): string {
  const note = notice ? `<p role="status"><strong>${esc(notice)}</strong></p>` : "";
  return `${note}<form method="post" action="${esc(action)}"><input type="hidden" name="after" value="${head}">`
    + `<textarea data-voice name="body" rows="4" cols="60" maxlength="8192" required>${esc(draft)}</textarea><br><button type="submit">${esc(label)}</button></form>`;
}

export async function channelsPage(request: Request, env: Env): Promise<Response> {
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  try {
    const r = await verb<{ conversations: Array<{ channel: string; topic: string; head: number; read_seq: number }> }>(pc.ctx, "chat.conversations", {});
    const rows = r.conversations.map((c) => `<li><a href="/c/${esc(c.channel)}">#${esc(c.channel)}</a> ${esc(c.topic)}${c.head > c.read_seq ? " <strong>new</strong>" : ""}</li>`).join("");
    const forms = `<h2>New channel</h2><form method="post" action="/api/channel.create"><input type="hidden" name="_back" value="/c">`
      + `<input name="slug" placeholder="name" required> <button type="submit">Create</button></form>`
      + `<h2>Add an agent you operate</h2><form method="post" action="/api/channel.add_agent"><input type="hidden" name="_back" value="/c">`
      + `<input name="c" placeholder="channel" required> <input name="agent" placeholder="agent" required> <button type="submit">Add</button></form>`;
    return htmlResponse(page("Channels", `<h1>Channels</h1>${NAV}<ul>${rows || "<li>None yet.</li>"}</ul>${forms}`, shellFor(pc.ctx, env, "chat")), 200, pc.extra);
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
    const body = `<h1>#${esc(r.channel)}</h1>${NAV}${older}${r.messages.map((m) => msgHtml(r.channel, m, false)).join("")}${compose(`/c/${r.channel}`, r.head, draft, notice, "Post")}`;
    return htmlResponse(page(`#${r.channel}`, body, shellFor(pc.ctx, env, "chat")), 200, pc.extra);
  } catch (e) {
    return errorPage(e, pc.extra);
  }
}

export async function threadPage(request: Request, env: Env, slug: string, seq: string, draft = "", notice = ""): Promise<Response> {
  if (!SLUG.test(slug) || !/^\d{1,12}$/.test(seq)) return notFoundPage();
  const pc = await pageCtx(request, env);
  if (pc instanceof Response) return pc;
  try {
    const r = await verb<ReadResult>(pc.ctx, "chat.thread", { c: slug, msg: seq, budget: 8000 });
    const root = r.messages[0]!;
    const body = `<h1>#${esc(r.channel)} thread #${root.seq}</h1>${NAV}<p><a href="/c/${esc(r.channel)}">back to #${esc(r.channel)}</a></p>`
      + r.messages.map((m) => msgHtml(r.channel, m, true)).join("") + compose(`/c/${r.channel}/t/${root.seq}`, r.head, draft, notice, "Reply");
    return htmlResponse(page(`#${r.channel} thread`, body, shellFor(pc.ctx, env, "chat")), 200, pc.extra);
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
  const form = await request.formData().catch(() => null);
  if (!form) return htmlResponse(page("Bad request", "<h1>Bad request</h1>"), 400, pc.extra);
  const body = String(form.get("body") ?? "");
  const after = String(form.get("after") ?? "");
  const back = threadSeq ? `/c/${slug}/t/${threadSeq}` : `/c/${slug}`;
  try {
    await verb(pc.ctx, "chat.post", { c: slug, body, ...(after ? { after } : {}), ...(threadSeq ? { reply_to: threadSeq } : {}) });
    return new Response(null, { status: 303, headers: { location: back, "cache-control": "no-store", ...pc.extra } });
  } catch (e) {
    if (e instanceof HubError && e.reason === "stale_view") {
      const notice = "New messages arrived while you were writing. They are shown above; your draft is below. Post again when ready.";
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
    const body = `<h1>#${esc(h.channel)} message #${h.seq}</h1>${NAV}<p><a href="/c/${esc(h.channel)}/t/${h.seq}">in context</a></p>${versions}`;
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
