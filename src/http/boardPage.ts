// The board in the workbench: quests with progress, then open, under way, and done lately, side by side.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
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
  const b = await board(ctx, slug);
  const card = (i: BoardItem) => `<a class="card bcard" href="/${esc(i.slug)}/w/${i.number}"><div class="head"><span class="k-${i.kind}"><span class="kd"></span>${esc(KINDS[i.kind].name)}</span><span>${esc(i.ref)}</span>${i.stalled ? '<span class="pill">stalled</span>' : ""}</div><div>${esc(i.title)}</div>${i.owner ? `<small class="lede">${esc(i.owner)}</small>` : ""}</a>`;
  const col = (title: string, items: BoardItem[]) => `<div class="bcol"><h2>${esc(title)} <span class="pill">${items.length}</span></h2>${items.slice(0, 60).map(card).join("") || '<p class="lede">None.</p>'}</div>`;
  const list = `<p class="crumbs"><a href="/">${esc(ctx.tenant.display_name)}</a>${slug ? ` / <a href="/${esc(slug)}/docket">${esc(slug)}</a>` : ""}</p>
<div class="head"><h1>Board</h1><span>${esc(slug ?? ctx.tenant.display_name)}</span>${b.stalled ? `<span class="pill">${b.stalled} stalled</span>` : ""}<a href="${slug ? `/${esc(slug)}/docket` : "/docket"}">List view</a></div>
${b.quests.length ? `<h2>Quests</h2><div class="grid">${b.quests.map((q) => `<a class="card" href="/${esc(q.slug)}/w/${q.number}"><h3>${esc(q.title)}</h3><div class="progress"><span style="width:${q.total ? Math.round((q.done / q.total) * 100) : 0}%"></span></div><p>${q.done} of ${q.total} done · ${esc(q.ref)}</p></a>`).join("")}</div>` : ""}
<div class="board">${col("Open", b.columns.open)}${col("Under way", b.columns.doing)}${col("Done lately", b.columns.done)}</div>`;
  return htmlResponse(workbench("Board", { list, listKey: `board:${slug ?? "org"}`, inspector: null }, shellFor(ctx, env, slug ? "project" : "docket", slug ?? "board")!), 200, extra);
}
