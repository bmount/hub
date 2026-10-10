// The board in the workbench: quests with progress, then open, under way, and done lately, side by side.
import type { Env } from "../env";
import { esc, htmlResponse, page, workbench } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { board, type BoardItem } from "../verbs/board";
import { KINDS } from "../work/names";

export async function boardPage(request: Request, env: Env, slug: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  if (slug && !(await ctx.db.prepare("SELECT 1 FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel'").bind(ctx.tenant.id, slug).first())) return notFoundPage(extra);
  const actor = new URL(request.url).searchParams.get("actor") || null;
  if (actor && actor.length > 26) return htmlResponse(page("Bad request", "<h1>Bad request</h1><p>Actor identity ID must be at most 26 characters.</p>"), 400, extra);
  const b = await board(ctx, slug, actor);
  const card = (i: BoardItem) => `<a class="card bcard" href="/${esc(i.slug)}/w/${i.number}"><div class="head"><span class="k-${i.kind}"><span class="kd"></span>${esc(KINDS[i.kind].name)}</span><span>${esc(i.ref)}</span>${i.stalled ? '<span class="pill">stalled</span>' : ""}</div><div>${esc(i.title)}</div>${i.owner ? `<small class="lede">${esc(i.owner)}</small>` : ""}</a>`;
  const col = (title: string, items: BoardItem[], total: number) => `<div class="bcol"><h2>${esc(title)} <span class="pill">${total}</span></h2><p class="lede">Showing ${Math.min(items.length, 60)} of ${total} recorded items${total > Math.min(items.length, 60) ? "; truncated" : ""}.</p>${items.slice(0, 60).map(card).join("") || `<p class="lede">${total ? "No examples in the latest-item sample; use List view to browse this column." : "None."}</p>`}</div>`;
  const list = `<p class="crumbs"><a href="/">${esc(ctx.tenant.display_name)}</a>${slug ? ` / <a href="/${esc(slug)}/docket">${esc(slug)}</a>` : ""}</p>
<div class="head"><h1>Board</h1><span>${esc(slug ?? ctx.tenant.display_name)}</span>${b.stalled ? `<span class="pill">${b.stalled} stalled</span>` : ""}<a href="${slug ? `/${esc(slug)}/docket` : "/docket"}">List view</a></div>
${b.quests.length ? `<h2>Quests</h2><div class="grid">${b.quests.map((q) => `<a class="card" href="/${esc(q.slug)}/w/${q.number}"><h3>${esc(q.title)}</h3><div class="progress"><span style="width:${q.total ? Math.round((q.done / q.total) * 100) : 0}%"></span></div><p>${q.done} of ${q.total} done · ${esc(q.ref)}</p></a>`).join("")}</div>` : ""}
<p class="lede">Exact recorded totals; examples are drawn from the latest ${b.examples.limit}-item sample (${b.examples.shown} sampled${b.examples.truncated ? "; truncated" : ""}). Missing examples do not mean an empty column.</p>
<div class="board">${col("Open", b.columns.open, b.totals.open)}${col("Under way", b.columns.doing, b.totals.doing)}${col("Done lately", b.columns.done, b.totals.done)}</div>
<section class="closure-report"><h2>Recorded closures by actor</h2><p class="lede">${esc(b.closures.note)}</p>
<form method="get"><label>Actor identity ID <input name="actor" maxlength="26" value="${esc(actor ?? "")}" placeholder="Any actor (top 50)"></label><button type="submit">Filter closures</button>${actor ? ` <a href="${slug ? `/${esc(slug)}/board` : "/board"}">Clear filter</a>` : ""}</form>
${actor ? `<p class="lede">Actor filter: ${esc(actor)}. No matching records does not prove zero historical closures.</p>` : ""}
<p class="lede">Showing ${b.closures.actors.length} of ${b.closures.total_actors} actors${b.closures.truncated ? "; truncated" : ""}. Currently done without a structured closure record: ${b.closures.currently_done_without_record} (whole selected scope, independent of actor filter).</p>
${b.closures.actors.length ? `<table class="closure-counts"><thead><tr><th>Actor</th><th>Kind</th><th>Items</th></tr></thead><tbody>${b.closures.actors.map(a => `<tr><td>${esc(a.name)} <small class="lede">${esc(a.identity_id)}</small></td><td>${esc(a.kind)}</td><td>${a.items}</td></tr>`).join("")}</tbody></table>` : '<p class="lede">No structured closure records in this scope. This does not mean nobody closed work.</p>'}</section>`;
  return htmlResponse(workbench("Board", { list, listKey: `board:${slug ?? "org"}`, inspector: null }, shellFor(ctx, env, slug ? "project" : "docket", slug ?? "board")!), 200, extra);
}
