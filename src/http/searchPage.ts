// /search: everything that matches, grouped, in the workbench.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { searchAll, type Hit } from "../verbs/search";

const LABEL: Record<string, string> = { work: "Work", mail: "Mail", messages: "Conversations", people: "People and agents", projects: "Projects", errors: "App errors" };

export async function searchPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  let groups: Record<string, Hit[]> = {};
  let problem = "";
  if (q) { try { groups = await searchAll(ctx, q); } catch (e) { if (e instanceof HubError) problem = e.detail ?? "try other words"; else throw e; } }
  const count = Object.values(groups).reduce((n, g) => n + g.length, 0);
  const sections = Object.entries(groups).filter(([, g]) => g.length).map(([k, g]) => `<h2>${esc(LABEL[k] ?? k)} <span class="pill">${g.length}</span></h2>
<table><tbody>${g.map((h) => `<tr data-href="${esc(h.href)}"><td class="ref">${esc(h.ref)}</td><td><a href="${esc(h.href)}">${esc(h.title)}</a>${h.snippet ? `<div class="lede" style="margin:0">${esc(h.snippet)}</div>` : ""}</td><td class="when hide-s">${esc(h.kind)}</td></tr>`).join("")}</tbody></table>`).join("");
  const list = `<form class="filters" method="get" action="/search"><input name="q" value="${esc(q)}" placeholder="Search work, mail, conversations, people, apps" style="flex:1;min-width:12rem" autofocus><button type="submit">Search</button></form>
${!q ? `<p class="lede">Every word must appear. Try a ref like site#3 in the jump box instead to go straight there.</p>` : problem ? `<p class="empty">${esc(problem)}</p>` : count ? sections : `<p class="empty">Nothing matches every word of "${esc(q)}".</p>`}`;
  return htmlResponse(workbench(q ? `Search: ${q}` : "Search", { list, listKey: `search:${q}`, inspector: null }, shellFor(ctx, env, "home", "search")!), 200, extra);
}
