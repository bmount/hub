// /search: everything that matches, grouped, in the workbench.
import type { Env } from "../env";
import { address, esc, htmlResponse, inspectorSection, kitTable, localTime, naturalName, workbench } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { HubError } from "../errors";
import { searchAll, coverageText, type Hit, type SearchCoverage } from "../verbs/search";

const LABEL: Record<string, string> = { contacts: "Workspace contacts", files: "Files", wiki: "Wiki pages", work: "Work", mail: "Mail", messages: "Conversations", people: "People and agents", projects: "Projects", errors: "App errors", reviews: "Reviews", situations: "Situations", assistant: "Your assistant conversations", outgoing: "Sent mail" };

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
  const selectedHref = new URL(request.url).searchParams.get("result");
  const selected = Object.values(groups).flat().find(h => h.href === selectedHref);
  if (selectedHref && !selected) return notFoundPage(extra);
  const selectionHref = (h: Hit) => { const u = new URL(request.url); u.searchParams.delete("format"); u.searchParams.set("result",h.href); return u.pathname + u.search; };
  const close = new URL(request.url); close.searchParams.delete("result");
  const projects = (await ctx.db.prepare("SELECT p.slug, p.display_name, n.slug AS namespace FROM project p LEFT JOIN namespace n ON n.id = p.namespace_id AND n.tenant_id = p.tenant_id WHERE p.tenant_id = ? AND p.kind NOT IN ('channel','agent-src')").bind(ctx.tenant.id).all<{slug:string;display_name:string;namespace:string|null}>()).results;
  const reference = (h: Hit) => h.ref.includes("@") ? address(h.ref) : esc(h.ref || "—");
  const projectFor = (h: Hit) => h.project_name ?? projects.find(p => {
    const path = p.namespace ? `${p.namespace}/${p.slug}` : p.slug;
    return h.href === `/${path}` || h.href.startsWith(`/${path}/`) || h.ref === path || h.ref.startsWith(`${path}#`) || h.ref.startsWith(`${path}!`) || h.ref.startsWith(`${path}/`);
  })?.display_name ?? "Organization";
  const sections = kitTable("Search results",[{label:"Kind"},{label:"Reference"},{label:"Title"},{label:"Project"},{label:"When"}],Object.values(groups).flat().sort((a,b)=>naturalName(a.kind,b.kind) || b.at-a.at).map(h=>({href:selectionHref(h),selected:h.href === selectedHref,cells:[{html:esc(h.kind)},{html:reference(h)},{html:`<a href="${esc(selectionHref(h))}">${esc(h.title || "Untitled")}</a>`},{html:esc(projectFor(h))},{html:localTime(h.at)}]})));
  const inspector = selected ? `<a class="back" href="${esc(close.pathname + close.search)}">‹ Search results</a><h1>${esc(selected.title)}</h1>
${inspectorSection("Result",[{label:"Reference",html:reference(selected)},{label:"Kind",html:esc(selected.kind)},{label:"Project",html:esc(projectFor(selected))},...(selected.at ? [{label:"Recorded",html:localTime(selected.at)}] : [])])}
<p class="prose">${esc(selected.snippet)}</p><a class="button" href="${esc(selected.href)}">Open ${esc(selected.kind)}</a>` : null;
  const list = `<h1>Search${q ? `: ${esc(q)}` : ""}</h1>
${coverage ? `<details data-search-coverage><summary>Search scope and limits</summary><p class="lede">${esc(coverageText(coverage))}</p></details>` : ""}
${!q ? `<p class="lede">Search across all projects: work and comments, mail and extracted attachments, conversations, reviews, situations, your assistant conversations, people, projects and app errors. Repository files, binary attachments and raw telemetry logs are not included. Every word must appear (up to six words of two characters or more). Use the upper box to search or select a suggestion to jump directly.</p>` : problem ? `<p class="empty">${esc(problem)}</p>` : count ? sections : `<p class="empty">No matches within this coverage for "${esc(q)}".</p>`}`;
  return htmlResponse(workbench(q ? `Search: ${q}` : "Search", { list, listKey: `search:${q}`, inspector, inspectorKey: selected ? `search-result:${selected.href}:${selected.at}:${selected.snippet}` : "", stackOnPhone:true }, shellFor(ctx, env, "home", "search")!), 200, extra);
}
