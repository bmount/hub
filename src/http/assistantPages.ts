// The Assistant (owner, 2026-10-07): a ChatGPT- or Claude-like chat for people who don't use an MCP client. It calls
// Pimwell's MCP tools as the person, in this organization only (src/assistant/run.ts). The Tools tab runs any one
// tool directly. Same guards as before: the person's own browser session, same-origin JSON with a custom header.
import type { Env } from "../env";
import { ASSETS } from "../assets";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { sameOrigin } from "./login";
import { takeRateDetail } from "../rate";
import { ulid } from "../ids";
import { note } from "../log";
import { HubError } from "../errors";
import { runTurn, type Step } from "../assistant/run";
import { PLAYGROUND_HEADER } from "./playground";
import { MAX_ASSISTANT_BODY_BYTES, readRequestBytes } from "./body";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function allowed(ctx: Ctx): "ok" | "not_found" | "forbidden" {
  if (ctx.host.kind !== "tenant" || !ctx.tenant || ctx.tenant.state !== "active" || !ctx.identity || !ctx.role) return "not_found";
  if (ctx.identity.kind !== "human" || ctx.authKind !== "cookie" || ctx.session?.kind !== "browser") return "forbidden";
  return "ok";
}

/** The answer's text as safe HTML: escaped first, then bold, inline code, bullets, and project#n links. */
export function format(text: string): string {
  const lines = esc(text).split("\n");
  const out: string[] = [];
  let list = false;
  for (const raw of lines) {
    const bullet = /^\s*[-*] (.*)$/.exec(raw);
    if (bullet && !list) { out.push("<ul>"); list = true; }
    if (!bullet && list) { out.push("</ul>"); list = false; }
    let l = bullet ? bullet[1]! : raw;
    l = l.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\b([a-z][a-z0-9-]{1,62})#(\d{1,8})\b/g, '<a href="/$1/w/$2">$1#$2</a>');
    out.push(bullet ? `<li>${l}</li>` : l === "" ? "<br>" : `<p>${l}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

function stepsHtml(steps: Step[]): string {
  if (!steps.length) return "";
  return `<details class="steps"><summary>Used ${steps.length} tool${steps.length === 1 ? "" : "s"}</summary><ul>${steps.map((s) =>
    `<li><code>${esc(s.tool)}</code> <small>${esc(s.arguments)}</small>${s.ok ? "" : ' <span class="pill">refused</span>'}<div class="lede">${esc(s.summary)}</div></li>`).join("")}</ul></details>`;
}

/** Starting points on an empty chat: what people ask on a normal day. */
const STARTERS: Array<[string, string]> = [
  ["Today", "What needs my attention today?"],
  ["This week", "What changed this week, and what shipped?"],
  ["App health", "Are there any new errors in our apps?"],
  ["Stuck work", "What work is stuck, and who could unblock it?"],
];

type Thread = { id: string; title: string; scopes: "read" | "write"; updated_at: number };

export async function assistantPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (allowed(ctx) !== "ok") return notFoundPage(extra);
  const tid = new URL(request.url).searchParams.get("t") ?? "";
  const [threadsR, msgsR] = await ctx.db.batch([
    ctx.db.prepare("SELECT id, title, scopes, updated_at FROM assistant_thread WHERE identity_id = ? AND tenant_id = ? ORDER BY updated_at DESC LIMIT 50").bind(ctx.identity!.id, ctx.tenant!.id),
    ctx.db.prepare(`SELECT m.role, m.text, m.steps FROM assistant_message m JOIN assistant_thread t ON t.id = m.thread_id
      WHERE m.thread_id = ? AND t.identity_id = ? AND t.tenant_id = ? ORDER BY m.created_at LIMIT 400`).bind(tid, ctx.identity!.id, ctx.tenant!.id),
  ]);
  const threads = threadsR!.results as Thread[];
  const thread = threads.find((t) => t.id === tid) ?? null;
  if (tid && !thread) return notFoundPage(extra);
  const msgs = msgsR!.results as Array<{ role: string; text: string; steps: string | null }>;
  const scopes = thread?.scopes ?? "read";
  const askNow = thread ? "" : (new URL(request.url).searchParams.get("ask") ?? "").trim().slice(0, 2000);
  const first = (ctx.identity!.display_name.split(/\s+/)[0] ?? "").trim();
  const org = ctx.tenant!.display_name;
  const msgHtml = (role: string, body: string) => role === "user"
    ? `<div class="msg user"><div class="body">${body}</div></div>`
    : `<div class="msg assistant"><div class="who" aria-hidden="true">P</div><div class="body">${body}</div></div>`;
  const log = msgs.map((m) => m.role === "user" ? msgHtml("user", esc(m.text))
    : msgHtml("assistant", format(m.text) + stepsHtml(m.steps ? (JSON.parse(m.steps) as Step[]) : []))).join("");
  const welcome = `<div class="welcome"><div class="who big" aria-hidden="true">P</div>
<h1>${first ? `Hi ${esc(first)}. ` : ""}What would you like to know?</h1>
<p class="lede">I look through work, code, mail, reviews and app errors in ${esc(org)}, as you. Nothing changes unless you allow it below.</p>
<div class="starters">${STARTERS.map(([title, ask]) => `<button type="button" class="starter" data-ask="${esc(ask)}"><b>${esc(title)}</b><span>${esc(ask)}</span></button>`).join("")}</div></div>`;
  const list = `<div class="assist">
<div class="assist-top"><div class="chips"><a class="chip" data-chat-link href="/assistant${thread ? `?t=${esc(thread.id)}` : ""}" aria-current="true">Chat</a><a class="chip" data-tools-link href="/assistant/tools${thread ? `?t=${esc(thread.id)}` : ""}">Tools</a><a class="chip only-s" data-conversations-link href="/assistant?list=1${thread ? `&t=${esc(thread.id)}` : ""}">Conversations</a><a class="chip" href="/assistant">+ New chat</a></div></div>
<div id="chatlog" class="chatlog" aria-live="polite">${log || welcome}</div>
<form id="ask" class="composer" autocomplete="off" data-org="${esc(org)}">
<input type="hidden" name="thread" value="${esc(thread?.id ?? "")}">
<div class="box"><textarea data-voice name="text" rows="1"${askNow ? ` data-autoask="${esc(askNow)}"` : ""} required maxlength="8000" aria-label="Your message" placeholder="Ask anything about ${esc(org)}…"></textarea><button type="submit" class="send" aria-label="Send">↑</button></div>
<div class="mode" role="radiogroup" aria-label="What the assistant may do">
<label><input type="radio" name="scopes" value="read"${scopes === "read" ? " checked" : ""}> Only look things up</label>
<label><input type="radio" name="scopes" value="write"${scopes === "write" ? " checked" : ""}> Can also make changes</label>
</div>
</form></div>
<script src="${ASSETS.assistant.path}"></script>`;
  const inspector = `<a class="back" href="/assistant${thread ? `?t=${esc(thread.id)}` : ""}">‹ Chat</a><h2 style="margin-top:0">Your conversations</h2>
${threads.length ? `<table><tbody>${threads.map((t) => `<tr data-href="/assistant?t=${esc(t.id)}"${t.id === thread?.id ? ' aria-selected="true"' : ""}><td><a href="/assistant?t=${esc(t.id)}">${esc(t.title)}</a>${t.scopes === "write" ? ' <span class="pill">can change things</span>' : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="lede">Your conversations appear here. Only you see them.</p>`}
<h2>How it works</h2><p class="lede">It acts as you, here only, with the tools your role allows. It only looks things up unless you let a conversation make changes. Every tool it uses is on the record, and its model use shows on your AI usage.</p>`;
  const showList = new URL(request.url).searchParams.get("list") === "1";
  return htmlResponse(workbench(thread ? thread.title : "Assistant", { list, listKey: `assistant:${thread?.id ?? "new"}`, inspector, inspectorKey: "assistant-threads", focus: showList ? "inspector" : "list" }, shellFor(ctx, env, "playground", "assistant")!), 200, extra);
}

export async function assistantChat(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const who = allowed(ctx);
  if (who === "not_found") return json({ error: "not_found" }, 404);
  if (who === "forbidden") return json({ error: "forbidden", reason: "the Assistant runs only in your own browser session" }, 403);
  if (!sameOrigin(request) || request.headers.get(PLAYGROUND_HEADER) !== "1" || !(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return json({ error: "forbidden", reason: "same-origin JSON requests from the Assistant only" }, 403);
  }
  const rate = await takeRateDetail(env.RATE, "assistant_turn", ctx.identity!.id, ctx.now);
  if (!rate.ok) return json({ error: "too_many_requests", reason: "that's a lot of questions this hour; try again soon" }, 429);
  let raw: string;
  try { raw = new TextDecoder().decode(await readRequestBytes(request, MAX_ASSISTANT_BODY_BYTES)); }
  catch (e) {
    if (e instanceof HubError) return json({ error: e.reason }, e.status);
    throw e;
  }
  if (raw.length > 20_000) return json({ error: "too_large" }, 413);
  let b: { thread?: unknown; text?: unknown; scopes?: unknown };
  try { b = JSON.parse(raw); } catch { return json({ error: "bad_request", reason: "invalid JSON" }, 400); }
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text || text.length > 8000) return json({ error: "bad_request", reason: "a message of up to 8000 characters" }, 400);
  const scopes = b.scopes === "write" ? "write" : b.scopes === "read" || b.scopes === undefined ? "read" : null;
  if (!scopes) return json({ error: "bad_request", reason: "scopes must be read or write" }, 400);
  let threadId: string;
  if (typeof b.thread === "string" && b.thread) {
    const t = await ctx.db.prepare("SELECT id, scopes FROM assistant_thread WHERE id = ? AND identity_id = ? AND tenant_id = ?").bind(b.thread, ctx.identity!.id, ctx.tenant!.id).first<{ id: string; scopes: string }>();
    if (!t) return json({ error: "not_found" }, 404);
    threadId = t.id;
    if (t.scopes !== scopes) await ctx.db.prepare("UPDATE assistant_thread SET scopes = ? WHERE id = ?").bind(scopes, t.id).run();
  } else {
    threadId = ulid(ctx.now);
    await ctx.db.prepare("INSERT INTO assistant_thread (id, tenant_id, identity_id, title, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(threadId, ctx.tenant!.id, ctx.identity!.id, text.replace(/\s+/g, " ").slice(0, 80), scopes, ctx.now, ctx.now).run();
  }
  note(request, { verb: "assistant.turn", via: "assistant" });
  try {
    const r = await runTurn(ctx, threadId, scopes, text, { signal: request.signal });
    return json({ thread: threadId, reply: r.reply, steps: r.steps });
  } catch (e) {
    if (e instanceof HubError) return json({ error: e.reason, reason: e.detail ?? null, thread: threadId }, e.status);
    throw e;
  }
}
