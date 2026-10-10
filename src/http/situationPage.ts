// /situations: describe a problem, get a diagnosis built from the record; record what turned out to be true.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { format } from "./assistantPages";

type Row = { id: string; title: string; question: string; report: string; outcome: string | null; created_at: number; who: string; thread_id: string };

export async function situationsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const sel = new URL(request.url).searchParams.get("s") ?? "";
  const rows = (await ctx.db.prepare(`SELECT s.id, s.title, s.question, s.report, s.outcome, s.created_at, s.thread_id, i.display_name AS who FROM situation s JOIN identity i ON i.id = s.identity_id
    WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 100`).bind(ctx.tenant.id).all<Row>()).results;
  // Search can select a published report older than the bounded rail. The exact lookup has the same tenant gate.
  const one = rows.find((r) => r.id === sel) ?? (sel ? await ctx.db.prepare(`SELECT s.id, s.title, s.question, s.report, s.outcome, s.created_at, s.thread_id, i.display_name AS who
    FROM situation s JOIN identity i ON i.id = s.identity_id WHERE s.tenant_id = ? AND s.id = ?`)
    .bind(ctx.tenant.id, sel).first<Row>() : null);
  const list = `<div class="head"><h1>Situations</h1><span>${rows.length}</span></div>
<p class="lede">Describe what's wrong in plain words. Pimwell looks through the record (work, commits, deploys, errors, reviews, mail) and answers with a cause, the evidence, who should act, and an honest estimate. Nothing changes; it only reads.</p>
${ctx.identity.kind === "human" ? `<form method="post" action="/api/situation.open" data-reload><input type="hidden" name="_back" value="@result"><label style="display:block"><textarea data-voice name="text" rows="3" required minlength="10" maxlength="4000" style="display:block;width:100%" placeholder="Signups dropped last week. Why?"></textarea></label><button type="submit">Investigate</button> <small class="lede">Takes up to a minute.</small></form>` : ""}
${rows.length ? `<table><tbody>${rows.map((r) => `<tr data-href="/situations?s=${esc(r.id)}"${r.id === sel ? ' aria-selected="true"' : ""}><td><a href="/situations?s=${esc(r.id)}">${esc(r.title)}</a><div class="lede" style="margin:0">${esc(r.who)}${r.outcome ? " · outcome recorded" : ""}</div></td><td class="when">${new Date(r.created_at).toISOString().slice(0, 10)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No situations yet.</p>`}`;
  const inspector = one ? `<a class="back" href="/situations">‹ Situations</a><div class="head"><span>${esc(one.who)}</span><span>${new Date(one.created_at).toISOString().slice(0, 16).replace("T", " ")}</span><a href="/assistant?t=${esc(one.thread_id)}">Continue in the Assistant</a></div>
<h1>${esc(one.title)}</h1><blockquote>${esc(one.question)}</blockquote><div>${format(one.report)}</div>
<h2>What turned out to be true</h2>${one.outcome ? `<div class="prose">${esc(one.outcome)}</div>` : rank(ctx.role) >= rank("member") ? `<form method="post" action="/api/situation.resolve"><input type="hidden" name="id" value="${esc(one.id)}"><input type="hidden" name="_back" value="/situations?s=${esc(one.id)}"><label style="display:block"><textarea data-voice name="outcome" rows="3" required style="display:block;width:100%" placeholder="Once you know: what the cause really was."></textarea></label><button type="submit" class="quiet">Record it</button></form>` : `<p class="lede">Not recorded yet.</p>`}` : null;
  return htmlResponse(workbench(one ? one.title : "Situations", { list, listKey: `situations:${rows.length}`, inspector, inspectorKey: one ? `sit:${one.id}:${one.outcome ? 1 : 0}` : "" }, shellFor(ctx, env, "situations", "situations")!), 200, extra);
}
