import { projectPathSql } from "../db/projects";
import type { Env } from "../env";
import { esc, htmlResponse, kitTable, kitTabs, page, statusChip, toolbar, workbench } from "../html";
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
  const project = slug ? await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FboardPage.ts:18:32:project*/ SELECT display_name FROM project p WHERE p.tenant_id = ? AND (${projectPathSql()}) = ? AND p.kind NOT IN ('channel', 'agent-src')`).bind(ctx.tenant.id, slug).first<{display_name:string}>() : null;
  if (slug && !project) return notFoundPage(extra);
  const url = new URL(request.url);
  const actor = url.searchParams.get("actor") || null;
  if (actor && actor.length > 26) return htmlResponse(page("Bad request", "<h1>Bad request</h1><p>Actor identity ID must be at most 26 characters.</p>"), 400, extra);
  const b = await board(ctx, slug, actor);
  const people = (await ctx.db.prepare("/*perf-site:src%2Fhttp%2FboardPage.ts:24:25:people*/ SELECT i.id, i.display_name FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? ORDER BY i.display_name").bind(ctx.tenant.id).all<{id:string;display_name:string}>()).results;
  let selected;
  try { selected = await selectedWorkInspector(ctx, env, url, slug); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
  const base = slug ? `/${slug}` : "";
  const href = (ref: string) => { const u = new URL(url); u.searchParams.set("work", ref); return u.pathname + u.search; };
  const col = (title: string, items: BoardItem[], total: number) => `<section aria-label="${esc(title)}"><h2>${esc(title)} <span class="wb-count">${total}</span></h2>${total ? `${kitTable(title, [{label:"Item"},{label:"Kind"},{label:"Owner",className:"hide-s"}], items.slice(0,60).map(i => ({href:href(i.ref), selected:url.searchParams.get("work") === i.ref, cells:[{html:`<a href="${esc(href(i.ref))}">${esc(i.ref)} ${esc(i.title)}</a>${i.stalled ? " · stalled" : ""}`},{html:statusChip(KINDS[i.kind].name,i.kind)},{html:esc(i.owner ?? "Nobody"),className:"hide-s"}]})))}${total > Math.min(items.length,60) ? `<small class="lede">${Math.min(items.length,60)} sampled of ${total}</small>` : ""}` : `<p class="lede">None</p>`}</section>`;
  const list = `<div class="head"><h1>Board</h1><span>${esc(project?.display_name ?? ctx.tenant.display_name)}</span>${b.stalled ? `<span class="pill">${b.stalled} stalled</span>` : ""}</div>
${toolbar("Board actions and filters", kitTabs("Work views", [{label:"List view",href:`${base}/docket`},{label:"Board",href:`${base}/board`,current:true},...(slug ? [{label:"Status",href:`${base}/status`}] : [])]), `<form method="get"><label>Person <select name="actor"><option value="">Everyone</option>${people.map(p=>`<option value="${esc(p.id)}"${p.id === actor ? " selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label><noscript><button type="submit">Apply filters</button></noscript>${actor ? ` <a href="${base}/board">Clear filter</a>` : ""}<input data-filter name="filter" aria-label="Filter the list" placeholder="Filter these (/)" size="16"></form>`)}
${b.quests.length ? `<h2>Quests</h2>${kitTable("Quests",[{label:"Reference"},{label:"Quest"},{label:"Progress"}],b.quests.map(q=>({href:href(q.ref),selected:url.searchParams.get("work")===q.ref,cells:[{html:esc(q.ref)},{html:`<a href="${esc(href(q.ref))}">${esc(q.title)}</a>`},{html:`${q.done} of ${q.total} done`}]})))}` : ""}
<div class="wb-board-columns">${col("Open", b.columns.open, b.totals.open)}${col("Under way", b.columns.doing, b.totals.doing)}${col("Done lately", b.columns.done, b.totals.done)}</div>
${b.closures.actors.length ? `<section class="closure-report"><h2>Recorded closures by person</h2>${kitTable("Recorded closures",[{label:"Person"},{label:"Kind"},{label:"Items"}],b.closures.actors.map(a=>({cells:[{html:esc(a.name)},{html:esc(a.kind)},{html:String(a.items)}]})))}<small title="Done items without structured closure records, across the whole scope">Unrecorded closures: ${b.closures.currently_done_without_record}</small></section>` : '<p class="lede">Recorded closures: none</p>'}`;
  const listUrl = new URL(url); listUrl.searchParams.delete("work");
  return htmlResponse(workbench("Board", { list, listKey: `board:${listUrl.pathname}:${listUrl.search}:${await sha256Hex(JSON.stringify(b))}`, inspector: selected.html, inspectorKey:selected.key }, shellFor(ctx, env, slug ? "project" : "docket", slug ?? "board")!), 200, extra);
}
