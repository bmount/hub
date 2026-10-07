// The Docket and work item pages on an organization's host: /<project>/docket and /<project>/w/<number>.
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { getWorkByNumber, listLinks, listWork } from "../db/work";
import { DOCKET, KINDS, STATES, type WorkKind } from "../work/names";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

async function projectCtx(request: Request, env: Env, slug: string) {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (!ctx.tenant || !ctx.role || !ctx.identity) return { ctx, extra, project: null };
  const project = await ctx.db.prepare("SELECT id, slug, display_name, state FROM project WHERE tenant_id = ? AND slug = ?").bind(ctx.tenant.id, slug)
    .first<{ id: string; slug: string; display_name: string; state: string }>();
  return { ctx, extra, project };
}

export async function docketPage(request: Request, env: Env, slug: string): Promise<Response> {
  const { ctx, extra, project } = await projectCtx(request, env, slug);
  if (!project) return notFoundPage(extra);
  const url = new URL(request.url);
  const kindFilter = url.searchParams.get("kind") as WorkKind | null;
  const showClosed = url.searchParams.get("closed") === "1";
  const items = await listWork(ctx.db, ctx.tenant!.id, {
    project_id: project.id, kinds: kindFilter && KINDS[kindFilter] ? [kindFilter] : [], states: showClosed ? ["done", "dropped"] : ["open", "doing"], limit: 300,
  });
  const canWrite = rank(ctx.role) >= rank("member");
  const chips = [`<a href="?">All</a>`, ...Object.entries(KINDS).map(([k, v]) => `<a href="?kind=${k}">${esc(v.plural)}</a>`)].join(" · ");
  const rows = items.map((w) => `<tr><td><a href="/${esc(project.slug)}/w/${w.number}">#${w.number}</a></td><td>${esc(KINDS[w.kind].name)}</td><td><a href="/${esc(project.slug)}/w/${w.number}">${esc(w.title)}</a></td><td>${esc(STATES[w.state])}</td><td>${when(w.updated_at)}</td></tr>`).join("");
  const form = canWrite ? `<h2>File something</h2>
<form method="post" action="/api/work.create"><input type="hidden" name="project" value="${esc(project.slug)}"><input type="hidden" name="_back" value="/${esc(project.slug)}/docket">
<label>Kind <select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${esc(v.name)} (${esc(v.plain)})</option>`).join("")}</select></label>
<label>Title <input name="title" required maxlength="200" size="50"></label><br>
<label>Details <textarea name="body" rows="4" cols="70" placeholder="What, why, and how you will know it is done."></textarea></label><br>
<button type="submit">File it</button></form>
<p><small>No triage meeting needed. File it here, or forward the thread to <code>${esc(ctx.tenant!.slug)}.${esc(project.slug)}@${esc(env.HUB_DOMAIN)}</code>.</small></p>` : "";
  const body = `<p><a href="/">${esc(ctx.tenant!.display_name)}</a> / ${esc(project.display_name)}</p>
<h1>${esc(DOCKET.name)}</h1><p>Everything ${showClosed ? "finished" : "open"} in ${esc(project.display_name)}: wishes (feature requests), snags (bugs), errands (tasks), quests (epics), calls (decisions) and sparks (ideas).</p>
<p>${chips} · ${showClosed ? `<a href="?">Open</a>` : `<a href="?closed=1">Finished</a>`}</p>
${items.length ? `<table><thead><tr><th></th><th>Kind</th><th>Title</th><th>State</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>` : `<p>Nothing here yet.</p>`}
${form}`;
  return htmlResponse(page(`${DOCKET.name}: ${project.display_name}`, body), 200, extra);
}

export async function workItemPage(request: Request, env: Env, slug: string, num: string): Promise<Response> {
  const { ctx, extra, project } = await projectCtx(request, env, slug);
  if (!project || !/^\d+$/.test(num)) return notFoundPage(extra);
  const w = await getWorkByNumber(ctx.db, project.id, Number(num));
  if (!w) return notFoundPage(extra);
  const [links, children, owner] = await Promise.all([
    listLinks(ctx.db, w.id),
    listWork(ctx.db, ctx.tenant!.id, { parent_id: w.id, limit: 200, states: [] }),
    w.owner_id ? ctx.db.prepare("SELECT display_name, email FROM identity WHERE id = ?").bind(w.owner_id).first<{ display_name: string; email: string }>() : null,
  ]);
  const parent = w.parent_id ? await ctx.db.prepare("SELECT number, title FROM work_item WHERE id = ?").bind(w.parent_id).first<{ number: number; title: string }>() : null;
  const canWrite = rank(ctx.role) >= rank("member");
  const back = `/${esc(project.slug)}/w/${w.number}`;
  const action = (state: string, label: string) => `<form class="inline" method="post" action="/api/work.update"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="_back" value="${back}"><button type="submit">${esc(label)}</button></form>`;
  const controls = canWrite ? `<p>${w.state !== "doing" ? `<form class="inline" method="post" action="/api/work.claim"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${back}"><button type="submit">I'm on it</button></form> ` : ""}${w.state !== "done" ? action("done", "Done") : ""} ${w.state !== "dropped" ? action("dropped", "Let it go") : ""} ${(w.state === "done" || w.state === "dropped") ? action("open", "Reopen") : ""}</p>` : "";
  const body = `<p><a href="/">${esc(ctx.tenant!.display_name)}</a> / <a href="/${esc(project.slug)}/docket">${esc(project.display_name)}</a></p>
<h1>${esc(w.title)}</h1>
<p>${esc(KINDS[w.kind].name)} (${esc(KINDS[w.kind].plain)}) <strong>${esc(project.slug)}#${w.number}</strong> · ${esc(STATES[w.state])}${owner ? ` · ${esc(owner.display_name)}` : ""}${parent ? ` · part of <a href="/${esc(project.slug)}/w/${parent.number}">#${parent.number} ${esc(parent.title)}</a>` : ""}</p>
${controls}
${w.source_quote ? `<blockquote>${esc(w.source_quote)}</blockquote>` : ""}
<pre style="white-space:pre-wrap">${esc(w.body)}</pre>
${children.length ? `<h2>Under it</h2><ul>${children.map((c) => `<li><a href="/${esc(project.slug)}/w/${c.number}">#${c.number}</a> ${esc(KINDS[c.kind].name)}: ${esc(c.title)} (${esc(STATES[c.state])})</li>`).join("")}</ul>` : ""}
<h2>Links</h2>${links.length ? `<ul>${links.map((l) => `<li>${esc(l.target_kind)}: ${l.target_kind === "url" ? `<a href="${esc(l.target_ref)}" rel="noopener noreferrer">${esc(l.target_ref)}</a>` : `<code>${esc(l.target_ref)}</code>`}${l.note ? ` (${esc(l.note)})` : ""}</li>`).join("")}</ul>` : "<p>None yet.</p>"}
<p><small>Filed ${when(w.created_at)}, updated ${when(w.updated_at)}${w.closed_at ? `, closed ${when(w.closed_at)}` : ""}.</small></p>`;
  return htmlResponse(page(`${project.slug}#${w.number} ${w.title}`, body), 200, extra);
}
