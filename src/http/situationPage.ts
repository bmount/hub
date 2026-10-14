// /situations: describe a problem, get a diagnosis built from the record; record what turned out to be true.
import { errorOriginColumns } from "../apps/origin";
import type { Env } from "../env";
import { localTime, emptyState, esc, htmlResponse, formRow, kitTable, toolbar, workbench } from "../html";
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
  const groups = (await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FsituationPage.ts:17:25:situationsPage:25540b85*/ SELECT g.id, g.title, g.script_name, ${errorOriginColumns()} FROM app_error_group g
    JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id AND p.kind NOT IN ('channel', 'agent-src')
    WHERE g.tenant_id = ? AND g.first_seen BETWEEN ? AND ? ORDER BY g.first_seen DESC, g.id DESC LIMIT 20`)
    .bind(ctx.tenant.id, ctx.now - 7 * 86_400_000, ctx.now).all<{ id: string; title: string; script_name: string; first_deploy: string | null; first_commit: string | null }>()).results;
  const newErrors = `<h2>New error groups · last 7 days</h2>${groups.length ? kitTable("New errors",[{label:"App"},{label:"Error"},{label:"First deploy",className:"hide-s"},{label:"First commit",className:"hide-s"}],groups.map(g=>({cells:[{html:esc(g.script_name)},{html:`<a href="/apps?g=${esc(g.id)}">${esc(g.title)}</a>`},{html:g.first_deploy ? `<a href="/apps?d=${esc(g.first_deploy)}">${esc(g.first_deploy)}</a>` : "unknown",className:"hide-s"},{html:esc(g.first_commit ?? "unknown"),className:"hide-s"}]}))) : '<p class="lede">No new groups recorded.</p>'}`;
  const sel = new URL(request.url).searchParams.get("s") ?? "";
  const rows = (await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FsituationPage.ts:23:23:situationsPage:6733e5ae*/ SELECT s.id, s.title, s.question, s.report, s.outcome, s.created_at, s.thread_id, i.display_name AS who FROM situation s JOIN identity i ON i.id = s.identity_id
    WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 100`).bind(ctx.tenant.id).all<Row>()).results;
  const one = rows.find((r) => r.id === sel) ?? (sel ? await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FsituationPage.ts:25:62:situationsPage:35c28ef2*/ SELECT s.id, s.title, s.question, s.report, s.outcome, s.created_at, s.thread_id, i.display_name AS who FROM situation s JOIN identity i ON i.id = s.identity_id
    WHERE s.tenant_id = ? AND s.id = ?`).bind(ctx.tenant.id, sel).first<Row>() : null);
  const list = `<div class="head"><h1>Situations</h1><span>${rows.length}</span></div>
<p class="lede">Investigate a problem using the record; nothing is changed.</p>
${ctx.identity.kind === "human" ? `<form method="post" action="/api/situation.open" data-reload><input type="hidden" name="_back" value="@result">${formRow("situation-question","Problem",'<textarea id="situation-question" data-voice name="text" rows="3" required minlength="10" maxlength="4000" style="width:100%" placeholder="Signups dropped last week. Why?"></textarea>')}${toolbar("Situation actions",'<button type="submit">Investigate</button>')} <small class="lede">Takes up to a minute.</small></form>` : ""}
${newErrors}
<h2>Recorded situations</h2>
${rows.length ? kitTable("Situations",[{label:"Situation"},{label:"By"},{label:"Outcome"},{label:"Recorded"}],rows.map(r=>({href:`/situations?s=${encodeURIComponent(r.id)}`,selected:r.id === sel,cells:[{html:`<a href="/situations?s=${esc(r.id)}">${esc(r.title)}</a>`},{html:esc(r.who)},{html:r.outcome ? "recorded" : "not recorded"},{html:localTime(r.created_at)}]}))) : emptyState("No situations yet","Describe a problem to investigate the record.",{label:"Assistant",href:"/assistant"})}`;
  const inspector = one ? `<a class="back" href="/situations">‹ Situations</a><div class="head"><span>${esc(one.who)}</span><span>${localTime(one.created_at)}</span><a href="/assistant?t=${esc(one.thread_id)}">Continue in the Assistant</a></div>
<h1>${esc(one.title)}</h1><blockquote>${esc(one.question)}</blockquote><div>${format(one.report)}</div>
<h2>What turned out to be true</h2>${one.outcome ? `<div class="prose">${esc(one.outcome)}</div>` : rank(ctx.role) >= rank("member") ? `<form method="post" action="/api/situation.resolve"><input type="hidden" name="id" value="${esc(one.id)}"><input type="hidden" name="_back" value="/situations?s=${esc(one.id)}"><label style="display:block"><textarea data-voice name="outcome" rows="3" required style="display:block;width:100%" placeholder="Once you know: what the cause really was."></textarea></label><button type="submit" class="quiet">Record it</button></form>` : `<p class="lede">Not recorded yet.</p>`}` : null;
  return htmlResponse(workbench(one ? one.title : "Situations", { list, stackOnPhone:true, listKey: `situations:${rows.length}:${groups.map(g => g.id + (g.first_deploy ?? "")).join(",")}`, inspector, inspectorKey: one ? `sit:${one.id}:${one.outcome ? 1 : 0}` : "" }, shellFor(ctx, env, "situations", "situations")!), 200, extra);
}
