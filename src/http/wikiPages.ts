import type { Env } from "../env";
import { buildContext, rank } from "../auth/context";
import { esc, htmlResponse, page } from "../html";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { miniMarkdown } from "./skillsPages";
import { wikiList, wikiHistory, readWiki, wikiProject, wikiSlug } from "../verbs/wiki";
import { HubError } from "../errors";
import type { Research } from "../verbs/research";
import { diffText, unified } from "../code/diff";

/** Render text first; only canonical wiki slugs become same-project links. No user HTML is accepted. */
export function wikiMarkdown(body: string, project: string): string {
  return miniMarkdown(body).replace(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g, (text, slug: string) => slug.length > 100 ? text : `<a href="/${esc(project)}/wiki/${slug}">${slug}</a>`);
}
function researchHtml(text: string, project: string, people: Array<{id: string; email: string; display_name: string}>): string {
  const r = JSON.parse(text) as Research;
  return `<section><h2>Research · ${esc(r.status)}</h2><div class="prose">${wikiMarkdown(r.summary, project)}</div><h2>Sources</h2><ol>${r.sources.map(s => `<li><a href="${s.url ? esc(s.url) : `/${esc(project)}/documents?path=${esc(encodeURIComponent(s.file!))}`}">${esc(s.title)}</a> · retrieved ${esc(s.retrieved_at)}<blockquote>${esc(s.quote)}</blockquote></li>`).join("")}</ol><h2>Linked people</h2><ul>${r.people.map(id => { const p = people.find(p => p.id === id); return p ? `<li><a href="/people/${esc(encodeURIComponent(p.email))}">${esc(p.display_name)}</a></li>` : `<li>${esc(id)}</li>`; }).join("")}</ul><h2>Organizations</h2><ul>${r.orgs.map(o => `<li><a href="/search?q=${esc(encodeURIComponent(o))}">${esc(o)}</a></li>`).join("")}</ul><h2>Items</h2><ul>${r.items.map(ref => { const [p, n] = ref.split("#"); return `<li><a href="/${esc(p!)}/w/${esc(n!)}">${esc(ref)}</a></li>`; }).join("")}</ul><p>Revise this structured page with <code>research.save</code>, using its current revision. History and diffs are below.</p></section>`;
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
    let body = `<p><a href="/${esc(project)}">${esc(project)}</a> / <a href="${base}">Wiki pages</a></p>`;
    if (!slug) {
      const v = await wikiList.run(ctx, wikiList.parse({project, after: url.searchParams.get("after")}));
      body += `<h1>Wiki pages</h1><ul>${v.pages.map(p => `<li><a href="${base}/${esc(p.slug)}">${esc(p.title)}</a> · ${p.page_type === "research" ? "research · " : ""}revision ${p.revision}</li>`).join("")}</ul>${v.next_cursor ? `<a href="${base}?after=${esc(v.next_cursor)}">Next pages</a>` : ""}`;
      if (writable) body += `<h2>New page</h2><form method="post" action="/api/wiki.write"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="expected_revision" value="0"><input type="hidden" name="_back" value="@result"><label>Slug <input name="slug" required maxlength="100" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label><label>Title <input name="title" required maxlength="200"></label><label>Markdown <textarea name="body" rows="12"></textarea></label><label>Revision note <input name="note" required maxlength="500"></label><button>Create page</button></form>`;
    } else {
      wikiSlug(slug);
      const revText = url.searchParams.get("revision");
      const revision = revText === null ? null : Number(revText);
      if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) return notFoundPage();
      const v = await readWiki(ctx, project, slug, revision);
      const r = v.page;
      const people = r.research ? (await ctx.db.prepare("SELECT i.id, i.email, i.display_name FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active'").bind(ctx.tenant.id).all<{id: string; email: string; display_name: string}>()).results : [];
      // The history includes tombstones; reverting a deleted page uses the latest head revision too.
      const h = await wikiHistory.run(ctx, wikiHistory.parse({project, slug, before: url.searchParams.get("before")}));
      const head = await wikiHistory.run(ctx, wikiHistory.parse({project, slug}));
      const expected = revision === null ? r.revision : head.history[0]!.revision;
      body += `<h1>${esc(r.title)}</h1><p>Revision ${r.revision} · ${esc(r.author)} · ${esc(new Date(r.created_at).toISOString())} · ${esc(r.note)}${r.deleted ? " · deleted" : ""}</p>${r.research ? researchHtml(r.research, project, people) : `<div class="prose">${wikiMarkdown(r.body, project)}</div>`}<h2>Links</h2><ul>${v.links.map(s => `<li><a href="${base}/${s}">${s}</a></li>`).join("")}</ul><h2>Backlinks</h2><ul>${v.backlinks.map(p => `<li><a href="${base}/${esc(p.slug)}">${esc(p.title)}</a></li>`).join("")}</ul><p>Up to 200 backlinks shown.</p>`;
      if (url.searchParams.has("diff") && r.revision > 1) {
        const previous = await readWiki(ctx, project, slug, r.revision - 1);
        body += `<h2>Diff from revision ${r.revision - 1}</h2><pre>${esc(unified(slug, diffText(previous.page.title + "\n\n" + previous.page.body, r.title + "\n\n" + r.body)))}</pre>`;
      }
      if (writable && !r.research) body += `<h2>${revision === null ? "Edit page" : `Revert to revision ${r.revision}`}</h2><p>Saving creates a new revision; historical revisions remain unchanged. A stale edit is refused.</p><form method="post" action="/api/wiki.write"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="slug" value="${esc(slug)}"><input type="hidden" name="expected_revision" value="${expected}"><input type="hidden" name="_back" value="@result"><label>Title <input name="title" required maxlength="200" value="${esc(r.title)}"></label><label>Markdown <textarea name="body" rows="15">${esc(r.body)}</textarea></label><label>Revision note <input name="note" required maxlength="500" value="${revision === null ? "" : `Revert to revision ${r.revision}`}"></label><button>${revision === null ? "Save revision" : "Revert page"}</button></form>`;
      body += `<h2>History</h2><ol>${h.history.map(x => `<li><a href="${base}/${esc(slug)}?revision=${x.revision}">Revision ${x.revision}</a> · <a href="${base}/${esc(slug)}?revision=${x.revision}&diff=1">Diff</a> · ${esc(x.author)} · ${esc(new Date(x.created_at).toISOString())} · ${esc(x.note)}${x.deleted ? " · deleted" : ""}</li>`).join("")}</ol>${h.next_cursor ? `<a href="${base}/${esc(slug)}?revision=${r.revision}&before=${h.next_cursor}">Older history</a>` : ""}`;
      if (writable && rank(ctx.role) >= rank("admin") && !r.deleted && revision === null) body += `<form method="post" action="/api/wiki.delete"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="slug" value="${esc(slug)}"><input type="hidden" name="expected_revision" value="${expected}"><input type="hidden" name="_back" value="${base}"><label>Deletion note <input name="note" required maxlength="500"></label><button>Delete page (retain history)</button></form>`;
    }
    return htmlResponse(page("Wiki pages", body, shellFor(ctx, env, "project", project)));
  } catch (e) {
    if (e instanceof HubError && [400, 404].includes(e.status)) return notFoundPage();
    throw e;
  }
}
