import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { esc, htmlResponse } from "../html";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { miniMarkdown } from "./skillsPages";
import { projectImages } from "./projectImages";
import { wikiList, wikiHistory, readWiki, wikiProject, wikiSlug } from "../verbs/wiki";
import { HubError } from "../errors";
import { researchList, type Research } from "../verbs/research";
import { localTime, workbench, kitTree, kitTable, kitTabs, toolbar, emptyState, inspectorSection } from "../html";
import { diffText, unified } from "../code/diff";

import { documentSharing } from "./documentSharing";

/** Render text first; only canonical wiki slugs become same-project links. No user HTML is accepted. */
export function wikiMarkdown(body: string, project: string): string {
  return miniMarkdown(body).replace(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g, (text, slug: string) => slug.length > 100 ? text : `<a href="/${esc(project)}/wiki/${slug}">${slug}</a>`);
}
function researchHtml(text: string, project: string, people: Array<{id: string; email: string; display_name: string}>): string {
  const r = JSON.parse(text) as Research;
  return `<section><h2>Research · ${esc(r.status)}</h2><div class="prose">${wikiMarkdown(r.summary, project)}</div><h2>Sources</h2><ol>${r.sources.map(s => `<li><a href="${s.url ? esc(s.url) : `/${esc(project)}/documents?path=${esc(encodeURIComponent(s.file!))}`}">${esc(s.title)}</a> · retrieved ${esc(s.retrieved_at)}<blockquote>${esc(s.quote)}</blockquote></li>`).join("")}</ol><h2>Linked people</h2><ul>${r.people.map(id => { const p = people.find(p => p.id === id); return p ? `<li><a href="/people/${esc(encodeURIComponent(p.email))}">${esc(p.display_name)}</a></li>` : `<li>${esc(id)}</li>`; }).join("")}</ul><h2>Organizations</h2><ul>${r.orgs.map(o => `<li><a href="/search?q=${esc(encodeURIComponent(o))}">${esc(o)}</a></li>`).join("")}</ul><h2>Items</h2><ul>${r.items.map(ref => { const [p, n] = ref.split("#"); return `<li><a href="/${esc(p!)}/w/${esc(n!)}">${esc(ref)}</a></li>`; }).join("")}</ul></section>`;
}
export async function wikiPage(request: Request, env: Env, project: string, slug: string | null): Promise<Response> {
  const ctx = await buildContext(request, env);
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.identity || !ctx.role) return notFoundPage();
  const url = new URL(request.url);
  const base = `/${esc(project)}/wiki`;
  const canWrite = rank(ctx.role) >= rank("member");
  try {
    const pr = await wikiProject(ctx, project);
    const writable = canWrite && pr.state === "active";
    const shell = shellFor(ctx, env, "project", project)!;
    const research = url.searchParams.get("view") === "research";
    const query = new URLSearchParams(url.searchParams);
    query.delete("revision"); query.delete("diff"); query.delete("before"); query.delete("new");
    const target = (s: string | null, changes: Record<string, string | null> = {}) => {
      const q = new URLSearchParams(query);
      for (const [k,v] of Object.entries(changes)) { if (v === null) q.delete(k); else q.set(k,v); }
      return `/${project}/wiki${s ? `/${s}` : ""}${q.size ? `?${q}` : ""}`;
    };
    const pages = await wikiList.run(ctx, wikiList.parse({project, after: url.searchParams.get("after")}));
    let list = `<h1>${research ? "Research" : "Wiki pages"}</h1>` + toolbar("Knowledge actions", `${kitTabs("Knowledge views", [{label:"Wiki",href:target(null,{view:null,after:null}),current:!research},{label:"Research",href:target(null,{view:"research",after:null}),current:research}])}${writable && !research ? `<a href="${esc(target(null,{new:"1"}))}">New page</a>` : ""}`);
    if (research) {
      const records = await researchList.run(ctx, researchList.parse({project, ...Object.fromEntries(query)}));
      list += toolbar("Research filters", "", `<form method="get" action="${base}"><input type="hidden" name="view" value="research"><label>Topic <input name="topic" value="${esc(query.get("topic") ?? "")}"></label><label>Status <select name="status"><option value="">All</option>${["draft","final"].map(s=>`<option${query.get("status") === s ? " selected" : ""}>${s}</option>`).join("")}</select></label><noscript><button>Apply filters</button></noscript></form>`);
      list += records.results.length ? kitTable("Research", [{label:"Status"},{label:"Topic"},{label:"Sources"}], records.results.map(r=>({href:target(r.slug),selected:r.slug === slug,cells:[{html:esc(r.status)},{html:`<a href="${esc(target(r.slug))}">${esc(r.topic)}</a>`},{html:esc(String(r.sources.length))}]}))) : emptyState("No research", "Research records saved in this workspace appear here.",{label:"Clear filters",href:target(null,{topic:null,status:null,after:null})});
      if (records.next_cursor) list += `<a href="${esc(target(null,{after:records.next_cursor}))}">Next research</a>`;
    } else {
      list += kitTree("Page tree", pages.pages.map(p=>({label:p.title,href:target(p.slug),current:p.slug === slug})));
      if (!pages.pages.length) list += emptyState("No pages", "Pages in this project appear here.",writable ? {label:"New page",href:target(null,{new:"1"})} : {label:"Project",href:`/${project}`});
      if (pages.next_cursor) list += `<a href="${esc(target(null,{after:pages.next_cursor}))}">Next pages</a>`;
    }
    let body = `<a class="back" href="${esc(target(null))}">Close</a>`;
    if (!slug) {
      if (writable && url.searchParams.has("new")) body += `<h2>New page</h2><form method="post" action="/api/wiki.write"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="expected_revision" value="0"><input type="hidden" name="_back" value="@result"><label>Slug <input name="slug" required maxlength="100" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label><label>Title <input name="title" required maxlength="200"></label><label>Markdown <textarea name="body" rows="12"></textarea></label><label>Revision note <input name="note" required maxlength="500"></label><button>Create page</button></form>`;
    } else {
      wikiSlug(slug);
      const revText = url.searchParams.get("revision");
      const revision = revText === null ? null : Number(revText);
      if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) return notFoundPage();
      const v = await readWiki(ctx, project, slug, revision);
      const r = v.page;
      if (shell.breadcrumb?.length) shell.breadcrumb[shell.breadcrumb.length-1]!.label = r.title;
      const people = r.research ? (await ctx.db.prepare("/*perf-site:src%2Fhttp%2FwikiPages.ts:65:42:wikiPage:bb24b71e*/ SELECT i.id, i.email, i.display_name FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active'").bind(ctx.tenant.id).all<{id: string; email: string; display_name: string}>()).results : [];
      // The history includes tombstones; reverting a deleted page uses the latest head revision too.
      const h = await wikiHistory.run(ctx, wikiHistory.parse({project, slug, before: url.searchParams.get("before")}));
      const head = await wikiHistory.run(ctx, wikiHistory.parse({project, slug}));
      const expected = revision === null ? r.revision : head.history[0]!.revision;
      const renderedBody = await projectImages(ctx, project, r.body, text => wikiMarkdown(text, project));
      let content = r.research ? researchHtml(r.research, project, people) : `<div class="prose">${renderedBody}</div>`;
      if (writable && !r.research) content = inspectorSection("Page", [{label:revision === null ? "Content" : "Revert", html:`<div class="prose">${renderedBody}</div>`, editHtml:`<form method="post" action="/api/wiki.write"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="slug" value="${esc(slug)}"><input type="hidden" name="expected_revision" value="${expected}"><input type="hidden" name="_back" value="${esc(target(slug))}"><label>Title <input name="title" required maxlength="200" value="${esc(r.title)}"></label><label>Markdown <textarea name="body" rows="15">${esc(r.body)}</textarea></label><label>Revision note <input name="note" required maxlength="500" value="${revision === null ? "" : `Revert to revision ${r.revision}`}"></label><button>${revision === null ? "Save revision" : "Revert page"}</button></form>`}]);
      body += `<h1>${esc(r.title)}</h1><p>Revision ${r.revision} · ${esc(r.author)} · ${localTime(r.created_at)} · ${esc(r.note)}${r.deleted ? " · deleted" : ""}</p>${content}<h2>Links</h2><ul>${v.links.map(s => `<li><a href="${base}/${s}">${s}</a></li>`).join("")}</ul><h2>Backlinks</h2><ul>${v.backlinks.map(p => `<li><a href="${base}/${esc(p.slug)}">${esc(p.title)}</a></li>`).join("")}</ul>`;
      body += await documentSharing(ctx, pr.id, project, "page", slug, writable && !r.deleted, target(slug));
      if (url.searchParams.has("diff") && r.revision > 1) {
        const previous = await readWiki(ctx, project, slug, r.revision - 1);
        body += `<h2>Diff from revision ${r.revision - 1}</h2><pre>${esc(unified(slug, diffText(previous.page.title + "\n\n" + previous.page.body, r.title + "\n\n" + r.body)))}</pre>`;
      }

      body += kitTable("History", [{label:"Revision"},{label:"Author / note"}], h.history.map(x=>({cells:[{html:`<a href="${esc(target(slug,{revision:String(x.revision)}))}">Revision ${x.revision}</a> · <a href="${esc(target(slug,{revision:String(x.revision),diff:"1"}))}">Diff</a>`},{html:`${esc(x.author)} · ${localTime(x.created_at)} · ${esc(x.note)}${x.deleted ? " · deleted" : ""}`}]}))) + (h.next_cursor ? `<a href="${esc(target(slug,{revision:String(r.revision),before:String(h.next_cursor)}))}">Older history</a>` : "");
      if (writable && rank(ctx.role) >= rank("admin") && !r.deleted && revision === null) body += `<form method="post" action="/api/wiki.delete"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="slug" value="${esc(slug)}"><input type="hidden" name="expected_revision" value="${expected}"><input type="hidden" name="_back" value="${base}"><label>Deletion note <input name="note" required maxlength="500"></label><button class="quiet destructive">Delete page (retain history)</button></form>`;
    }
    return htmlResponse(workbench("Wiki pages", {list, stackOnPhone:true, listKey:`wiki:${project}:${query}`, inspector:slug || url.searchParams.has("new") ? body : "", inspectorKey:slug ? `wiki:${slug}` : "", focus:url.searchParams.has("new") ? "inspector" : undefined}, shell));
  } catch (e) {
    if (e instanceof HubError && [400, 404].includes(e.status)) return notFoundPage();
    throw e;
  }
}
