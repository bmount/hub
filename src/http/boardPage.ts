import { projectPathSql } from "../db/projects";
import type { Env } from "../env";
import { emptyState, esc, htmlResponse, kitTable, kitTabs, page, statusChip, toolbar, workbench } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { board, type BoardItem } from "../verbs/board";
import { KINDS } from "../work/names";
import { selectedWorkInspector } from "./workPages";
import { HubError } from "../errors";
import { sha256Hex } from "../ids";

export async function boardPage(request: Request, env: Env, slug: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  if (slug && !(await ctx.db.prepare(`SELECT 1 FROM project p WHERE p.tenant_id = ? AND (${projectPathSql()}) = ? AND p.kind NOT IN ('channel', 'agent-src')`).bind(ctx.tenant.id, slug).first())) return notFoundPage(extra);
  const url = new URL(request.url);
  const actor = url.searchParams.get("actor") || null;
  if (actor && actor.length > 26) return htmlResponse(page("Bad request", "<h1>Bad request</h1><p>Actor identity ID must be at most 26 characters.</p>"), 400, extra);
  const b = await board(ctx, slug, actor);
  let selected;
  try { selected = await selectedWorkInspector(ctx, env, url, slug); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
  const base = slug ? `/${slug}` : "";
  const href = (ref: string) => { const u = new URL(url); u.searchParams.set("work", ref); return u.pathname + u.search; };
  const col = (title: string, items: BoardItem[], total: number) => `<h2>${esc(title)} <span class="pill">${total}</span></h2><p class="lede">Showing ${Math.min(items.length, 60)} of ${total} recorded items${total > Math.min(items.length, 60) ? "; truncated" : ""}.</p>${items.length ? kitTable(title, [{label:"Reference"},{label:"Kind"},{label:"Title"},{label:"Owner"}], items.slice(0,60).map(i => ({href:href(i.ref), selected:url.searchParams.get("work") === i.ref, cells:[{html:esc(i.ref)},{html:statusChip(KINDS[i.kind].name,i.kind)},{html:`<a href="${esc(href(i.ref))}">${esc(i.title)}</a>${i.stalled ? ' <span class="pill">stalled</span>' : ""}`},{html:esc(i.owner ?? "Nobody")}]}))) : emptyState("No examples", total ? "No examples in the latest-item sample; use List view to browse this column." : "No recorded items in this column.", {label:"List view",href:`${base}/docket`})}`;
  const list = `<div class="head"><h1>Board</h1><span>${esc(slug ?? ctx.tenant.display_name)}</span>${b.stalled ? `<span class="pill">${b.stalled} stalled</span>` : ""}</div>
${toolbar("Board actions and filters", kitTabs("Work views", [{label:"List view",href:`${base}/docket`},{label:"Board",href:`${base}/board`,current:true},...(slug ? [{label:"Status",href:`${base}/status`}] : [])]), `<form method="get"><label>Actor identity ID <input name="actor" maxlength="26" value="${esc(actor ?? "")}" placeholder="Any actor (top 50)"></label><button type="submit">Filter closures</button>${actor ? ` <a href="${base}/board">Clear filter</a>` : ""}<input data-filter name="filter" aria-label="Filter the list" placeholder="Filter these (/)" size="16"></form>`)}
${b.quests.length ? `<h2>Quests</h2>${kitTable("Quests",[{label:"Reference"},{label:"Quest"},{label:"Progress"}],b.quests.map(q=>({href:href(q.ref),selected:url.searchParams.get("work")===q.ref,cells:[{html:esc(q.ref)},{html:`<a href="${esc(href(q.ref))}">${esc(q.title)}</a>`},{html:`${q.done} of ${q.total} done`}]})))}` : ""}
<p class="lede">Exact recorded totals; examples are drawn from the latest ${b.examples.limit}-item sample (${b.examples.shown} sampled${b.examples.truncated ? "; truncated" : ""}). Missing examples do not mean an empty column.</p>
${col("Open", b.columns.open, b.totals.open)}${col("Under way", b.columns.doing, b.totals.doing)}${col("Done lately", b.columns.done, b.totals.done)}
<section class="closure-report"><h2>Recorded closures by actor</h2><p class="lede">${esc(b.closures.note)}</p>
${actor ? `<p class="lede">Actor filter: ${esc(actor)}. No matching records does not prove zero historical closures.</p>` : ""}
<p class="lede">Showing ${b.closures.actors.length} of ${b.closures.total_actors} actors${b.closures.truncated ? "; truncated" : ""}. Currently done without a structured closure record: ${b.closures.currently_done_without_record} (whole selected scope, independent of actor filter).</p>
${b.closures.actors.length ? kitTable("Recorded closures",[{label:"Actor"},{label:"Kind"},{label:"Items"}],b.closures.actors.map(a=>({cells:[{html:`${esc(a.name)} <small class="lede">${esc(a.identity_id)}</small>`},{html:esc(a.kind)},{html:String(a.items)}]}))) : '<p class="lede">No structured closure records in this scope. This does not mean nobody closed work.</p>'}</section>`;
  const listUrl = new URL(url); listUrl.searchParams.delete("work");
  return htmlResponse(workbench("Board", { list, listKey: `board:${listUrl.pathname}:${listUrl.search}:${await sha256Hex(JSON.stringify(b))}`, inspector: selected.html, inspectorKey:selected.key }, shellFor(ctx, env, slug ? "project" : "docket", slug ?? "board")!), 200, extra);
}
