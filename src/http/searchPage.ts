// /search: everything that matches, grouped, in the workbench.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { searchAll, coverageText, type Hit, type SearchCoverage } from "../verbs/search";

const LABEL: Record<string, string> = { work: "Work", mail: "Mail", messages: "Conversations", people: "People and agents", projects: "Projects", errors: "App errors", reviews: "Reviews", situations: "Situations", assistant: "Your assistant conversations", outgoing: "Sent mail" };

export async function searchPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  let groups: Record<string, Hit[]> = {};
  let coverage: SearchCoverage | null = null;
  let problem = "";
  if (q) { try { const result = await searchAll(ctx, q); ({ coverage, ...groups } = result); } catch (e) { if (e instanceof HubError) problem = e.detail ?? "try other words"; else throw e; } }
  if (new URL(request.url).searchParams.get("format") === "json") {
    const results = Object.entries(groups).flatMap(([key, hits]) => hits.map(h => ({ label: h.ref ? `${h.ref} · ${h.title}` : h.title, hint: h.snippet, href: h.href, group: LABEL[key] ?? key })));
    return Response.json({ results, ...(problem ? { error: problem } : {}) }, { status: problem ? 400 : 200, headers: { ...extra, "cache-control": "no-store" } });
  }
  const count = Object.values(groups).reduce((n, g) => n + g.length, 0);
  const sections = Object.entries(groups).filter(([, g]) => g.length).map(([k, g]) => `<h2>${esc(LABEL[k] ?? k)} <span class="pill">${g.length}</span></h2>
<table><tbody>${g.map((h) => `<tr data-href="${esc(h.href)}"><td class="ref">${esc(h.ref)}</td><td><a href="${esc(h.href)}">${esc(h.title)}</a>${h.snippet ? `<div class="lede" style="margin:0">${esc(h.snippet)}</div>` : ""}</td><td class="when hide-s">${esc(h.kind)}</td></tr>`).join("")}</tbody></table>`).join("");
  const list = `<form class="filters" method="get" action="/search"><input name="q" value="${esc(q)}" placeholder="Search all projects and content" style="flex:1;min-width:12rem" autofocus><button type="submit">Search</button></form>
${coverage ? `<details data-search-coverage><summary>Search scope and limits</summary><p class="lede">${esc(coverageText(coverage))}</p></details>` : ""}
${!q ? `<p class="lede">Search across all projects: work and comments, mail and extracted attachments, conversations, reviews, situations, your assistant conversations, people, projects and app errors. Repository files, binary attachments and raw telemetry logs are not included. Every word must appear (up to six words of two characters or more). Use the upper box to search or select a suggestion to jump directly.</p>` : problem ? `<p class="empty">${esc(problem)}</p>` : count ? sections : `<p class="empty">No matches within this coverage for "${esc(q)}".</p>`}`;
  return htmlResponse(workbench(q ? `Search: ${q}` : "Search", { list, listKey: `search:${q}`, inspector: null }, shellFor(ctx, env, "home", "search")!), 200, extra);
}
