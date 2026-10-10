// /situations: describe a problem, get a diagnosis built from the record; record what turned out to be true.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { format } from "./assistantPages";

type Row = { id: string; title: string; question: string; report: string; outcome: string | null; outcome_by: string | null; outcome_at: number | null; outcome_who: string | null; created_at: number; who: string; thread_id: string };

export async function situationsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const sel = new URL(request.url).searchParams.get("s") ?? "";
  const rows = (await ctx.db.prepare(`SELECT s.id, s.title, s.question, s.report, s.outcome, s.outcome_by, s.outcome_at, s.created_at, s.thread_id,
    i.display_name AS who, recorder.display_name AS outcome_who FROM situation s JOIN identity i ON i.id = s.identity_id
    LEFT JOIN identity recorder ON recorder.id = s.outcome_by
    WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 100`).bind(ctx.tenant.id).all<Row>()).results;
  const one = rows.find((r) => r.id === sel) ?? null;
  const list = `<div class="head"><h1>Situations</h1><span>${rows.length}</span></div>
<p class="lede">Describe what's wrong in plain words. Pimwell looks through the record (work, commits, deploys, errors, reviews, mail) and answers with a cause, the evidence, who should act, and an honest estimate. Nothing changes; it only reads.</p>
${ctx.identity.kind === "human" ? `<form method="post" action="/api/situation.open" data-reload><input type="hidden" name="_back" value="@result"><label style="display:block"><textarea data-voice name="text" rows="3" required minlength="10" maxlength="4000" style="display:block;width:100%" placeholder="Signups dropped last week. Why?"></textarea></label><button type="submit">Investigate</button> <small class="lede">Takes up to a minute.</small></form>` : ""}
${rows.length ? `<table><tbody>${rows.map((r) => `<tr data-href="/situations?s=${esc(r.id)}"${r.id === sel ? ' aria-selected="true"' : ""}><td><a href="/situations?s=${esc(r.id)}">${esc(r.title)}</a><div class="lede" style="margin:0">${esc(r.who)}${r.outcome !== null ? " · outcome recorded" : ""}</div></td><td class="when">${new Date(r.created_at).toISOString().slice(0, 10)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No situations yet.</p>`}`;
  const inspector = one ? `<a class="back" href="/situations">‹ Situations</a><div class="head"><span>${esc(one.who)}</span><span>${new Date(one.created_at).toISOString().slice(0, 16).replace("T", " ")}</span><a href="/assistant?t=${esc(one.thread_id)}">Continue in the Assistant</a></div>
<h1>${esc(one.title)}</h1><blockquote>${esc(one.question)}</blockquote><h2>Original diagnosis</h2><div>${format(one.report)}</div>
<h2>Recorded outcome</h2>${one.outcome !== null ? `<p class="lede">Recorded by ${esc(one.outcome_who ?? "an unknown recorder")}${one.outcome_at !== null ? ` · ${new Date(one.outcome_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : " · time unknown"}. Member-reported, not independently verified. The original diagnosis and recorded outcome are kept unchanged.</p><div class="prose">${esc(one.outcome)}</div>` : one.outcome_by !== null || one.outcome_at !== null ? `<p class="lede">Outcome record is incomplete. Existing evidence cannot be replaced.</p>` : rank(ctx.role) >= rank("member") ? `<form method="post" action="/api/situation.resolve"><input type="hidden" name="id" value="${esc(one.id)}"><input type="hidden" name="_back" value="/situations?s=${esc(one.id)}"><p class="lede">Record what happened and cite the evidence. This outcome cannot be replaced after submission.</p><label style="display:block"><textarea data-voice name="outcome" rows="3" required maxlength="4000" style="display:block;width:100%" placeholder="Once you know: what the cause really was."></textarea></label><button type="submit" class="quiet">Record it</button></form>` : `<p class="lede">Not recorded yet.</p>`}` : null;
  return htmlResponse(workbench(one ? one.title : "Situations", { list, listKey: `situations:${rows.length}`, inspector, inspectorKey: one ? `sit:${one.id}:${one.outcome !== null || one.outcome_by !== null || one.outcome_at !== null ? 1 : 0}` : "" }, shellFor(ctx, env, "situations", "situations")!), 200, extra);
}
