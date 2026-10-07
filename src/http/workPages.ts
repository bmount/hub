// The Docket and work item pages on an organization's host: /docket, /<project>/docket and /<project>/w/<number>.
// Each page reads in one D1 batch after the project lookup (performance budget, test/perf-budget).
import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { buildContext, rank, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { getWorkByNumber, listLinksStatement, listWorkStatement, type WorkFilter, type WorkItem, type WorkLink } from "../db/work";
import { DOCKET, KINDS, STATES, type WorkKind } from "../work/names";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

type Member = { id: string; display_name: string; email: string; kind: string };
type Quest = { id: string; number: number; title: string };
type Project = { id: string; slug: string; display_name: string; state: string };

const membersStatement = (ctx: Ctx) => ctx.db.prepare(
  `SELECT i.id, i.display_name, i.email, i.kind FROM membership m JOIN identity i ON i.id = m.identity_id
   WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' ORDER BY i.kind = 'agent', i.display_name`,
).bind(ctx.tenant!.id);
const questsStatement = (ctx: Ctx, project_id: string) => ctx.db.prepare(
  "SELECT id, number, title FROM work_item WHERE project_id = ? AND kind = 'quest' AND state IN ('open', 'doing') ORDER BY number",
).bind(project_id);

async function projectCtx(request: Request, env: Env, slug: string) {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (!ctx.tenant || !ctx.role || !ctx.identity) return { ctx, extra, project: null };
  const project = await ctx.db.prepare("SELECT id, slug, display_name, state FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel'").bind(ctx.tenant.id, slug)
    .first<Project>();
  return { ctx, extra, project };
}

type Filters = { kind: WorkKind | null; closed: boolean; owner: string | null; quest: number | null };

function readFilters(url: URL, withQuest: boolean): Filters {
  const k = url.searchParams.get("kind");
  const o = (url.searchParams.get("owner") ?? "").trim().toLowerCase();
  const q = url.searchParams.get("quest") ?? "";
  return {
    kind: k && KINDS[k as WorkKind] ? (k as WorkKind) : null,
    closed: url.searchParams.get("closed") === "1",
    owner: o && o.length <= 254 ? o : null,
    quest: withQuest && /^\d{1,8}$/.test(q) && Number(q) > 0 ? Number(q) : null,
  };
}

/** A link to the same Docket with some filters changed and the rest kept. */
function href(f: Filters, change: Partial<Filters>): string {
  const n = { ...f, ...change };
  const p = new URLSearchParams();
  if (n.kind) p.set("kind", n.kind);
  if (n.owner) p.set("owner", n.owner);
  if (n.quest) p.set("quest", String(n.quest));
  if (n.closed) p.set("closed", "1");
  const s = p.toString();
  return s ? `?${esc(s)}` : "?";
}

const option = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;

function itemFilter(ctx: Ctx, f: Filters, project_id: string | null): WorkFilter {
  return {
    project_id, kinds: f.kind ? [f.kind] : [], states: f.closed ? ["done", "dropped"] : ["open", "doing"], limit: 300,
    owner_id: f.owner === "me" ? ctx.identity!.id : null, owner_email: f.owner && f.owner !== "me" ? f.owner : null, parent_number: f.quest,
  };
}

function docketBody(ctx: Ctx, project: Project | null, items: WorkItem[], members: Member[], quests: Quest[], slugs: Map<string, string> | null, f: Filters): string {
  const names = new Map(members.map((m) => [m.id, m.display_name]));
  const chip = (label: string, to: string, on: boolean, cls = "") => `<a class="chip${cls}" href="${to}"${on ? ' aria-current="true"' : ""}>${esc(label)}</a>`;
  const kinds = [
    chip("All kinds", href(f, { kind: null }), f.kind === null),
    ...Object.entries(KINDS).map(([k, v]) => chip(v.plural, href(f, { kind: k as WorkKind }), f.kind === k, ` k-${k}`)),
  ].join("");
  const quick = [
    chip("Anyone's", href(f, { owner: null }), f.owner === null),
    chip("Mine", href(f, { owner: "me" }), f.owner === "me"),
    `<span class="gap" aria-hidden="true"></span>`,
    chip("Open", href(f, { closed: false }), !f.closed),
    chip("Finished", href(f, { closed: true }), f.closed),
  ].join("");
  const ownerKnown = f.owner === null || f.owner === "me" || members.some((m) => m.email === f.owner);
  const filterForm = `<form class="filters" method="get">${f.kind ? `<input type="hidden" name="kind" value="${f.kind}">` : ""}${f.closed ? `<input type="hidden" name="closed" value="1">` : ""}
<label>Owner <select name="owner">${option("", "Anyone", f.owner === null)}${option("me", "Me", f.owner === "me")}${ownerKnown ? "" : option(f.owner!, f.owner!, true)}${members.map((m) => option(m.email, `${m.display_name}${m.kind === "agent" ? " (helper)" : ""}`, f.owner === m.email)).join("")}</select></label>
${project ? `<label>Quest <select name="quest">${option("", "Any", f.quest === null)}${quests.map((q) => option(String(q.number), `#${q.number} ${q.title}`, f.quest === q.number)).join("")}</select></label>` : ""}
<button type="submit">Show</button></form>`;
  const rows = items.map((w) => {
    const sl = project ? project.slug : slugs?.get(w.project_id) ?? "?";
    const label = project ? `#${w.number}` : `${sl}#${w.number}`;
    const who = w.owner_id ? (w.owner_id === ctx.identity!.id ? "You" : names.get(w.owner_id) ?? "Former member") : "";
    return `<tr><td><a href="/${esc(sl)}/w/${w.number}">${esc(label)}</a></td><td class="k-${w.kind}">${esc(KINDS[w.kind].name)}</td><td><a href="/${esc(sl)}/w/${w.number}">${esc(w.title)}</a></td><td>${esc(who)}</td><td>${esc(STATES[w.state])}</td><td>${when(w.updated_at)}</td></tr>`;
  }).join("");
  const filtered = f.kind !== null || f.owner !== null || f.quest !== null;
  const empty = f.owner === "me" && !f.closed && f.kind === null && f.quest === null
    ? `Nothing is yours right now. Take something from <a href="${href(f, { owner: null })}">the open list</a>, or file what you are about to start.`
    : filtered ? `Nothing matches these filters. <a href="?">Show everything open</a>.`
    : f.closed ? "Nothing finished yet."
    : project ? "Nothing open. File something below, or forward a thread to the project's address."
    : "Nothing open. File work from any project's page, or forward a thread to its address.";
  const where = esc(project ? project.display_name : ctx.tenant!.display_name);
  return `<h1>${esc(DOCKET.name)}</h1><p class="lede">Everything ${f.closed ? "finished" : "open"} in ${where}: wishes (feature requests), snags (bugs), errands (tasks), quests (epics), calls (decisions) and sparks (ideas).</p>
<div class="chips">${kinds}</div><div class="chips">${quick}</div>
${filterForm}
${items.length ? `<table><thead><tr><th></th><th>Kind</th><th>Title</th><th>Owner</th><th>State</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="lede">${empty}</p>`}`;
}

export async function docketPage(request: Request, env: Env, slug: string): Promise<Response> {
  const { ctx, extra, project } = await projectCtx(request, env, slug);
  if (!project) return notFoundPage(extra);
  const f = readFilters(new URL(request.url), true);
  const [items, members, quests] = await ctx.db.batch([
    listWorkStatement(ctx.db, ctx.tenant!.id, itemFilter(ctx, f, project.id)), membersStatement(ctx), questsStatement(ctx, project.id),
  ]);
  const canWrite = rank(ctx.role) >= rank("member");
  const form = canWrite ? `<h2>File something</h2>
<form method="post" action="/api/work.create"><input type="hidden" name="project" value="${esc(project.slug)}"><input type="hidden" name="_back" value="/${esc(project.slug)}/docket">
<label>Kind <select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${esc(v.name)} (${esc(v.plain)})</option>`).join("")}</select></label>
<label>Title <input name="title" required maxlength="200" size="50"></label><br>
<label>Details <textarea name="body" rows="4" cols="70" placeholder="What, why, and how you will know it is done."></textarea></label><br>
<button type="submit">File it</button></form>
<p><small>No triage meeting needed. File it here, or forward the thread to <code>${esc(ctx.tenant!.slug)}.${esc(project.slug)}@${esc(env.HUB_DOMAIN)}</code>.</small></p>` : "";
  const body = `<p class="crumbs"><a href="/">${esc(ctx.tenant!.display_name)}</a> / <a href="/${esc(project.slug)}">${esc(project.display_name)}</a></p>
${docketBody(ctx, project, items!.results as WorkItem[], members!.results as Member[], quests!.results as Quest[], null, f)}
${form}`;
  return htmlResponse(page(`${DOCKET.name}: ${project.display_name}`, body, shellFor(ctx, env, "docket", project.slug)), 200, extra);
}

export async function workItemPage(request: Request, env: Env, slug: string, num: string): Promise<Response> {
  const { ctx, extra, project } = await projectCtx(request, env, slug);
  if (!project || !/^\d{1,8}$/.test(num)) return notFoundPage(extra);
  const w = await getWorkByNumber(ctx.db, project.id, Number(num));
  if (!w) return notFoundPage(extra);
  const [linksR, childrenR, ownerR, parentR, membersR, questsR] = await ctx.db.batch([
    listLinksStatement(ctx.db, w.id),
    listWorkStatement(ctx.db, ctx.tenant!.id, { parent_id: w.id, limit: 200, states: [] }),
    ctx.db.prepare("SELECT id, display_name, email, kind FROM identity WHERE id = ?").bind(w.owner_id),
    ctx.db.prepare("SELECT id, number, title FROM work_item WHERE id = ?").bind(w.parent_id),
    membersStatement(ctx),
    questsStatement(ctx, project.id),
  ]);
  const links = linksR!.results as WorkLink[];
  const children = childrenR!.results as WorkItem[];
  const owner = (ownerR!.results[0] as Member | undefined) ?? null;
  const parent = (parentR!.results[0] as Quest | undefined) ?? null;
  const members = membersR!.results as Member[];
  const quests = (questsR!.results as Quest[]).filter((q) => q.id !== w.id);
  const canWrite = rank(ctx.role) >= rank("member");
  const back = `/${esc(project.slug)}/w/${w.number}`;
  const action = (state: string, label: string) => `<form class="inline" method="post" action="/api/work.update"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="_back" value="${back}"><button type="submit">${esc(label)}</button></form>`;
  const controls = canWrite ? `<p>${w.state !== "doing" ? `<form class="inline" method="post" action="/api/work.claim"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${back}"><button type="submit">I'm on it</button></form> ` : ""}${w.state !== "done" ? action("done", "Done") : ""} ${w.state !== "dropped" ? action("dropped", "Let it go") : ""} ${(w.state === "done" || w.state === "dropped") ? action("open", "Reopen") : ""}</p>` : "";
  // The current owner and quest are always among the choices, even when the usual lists leave them out, so saving never drops them.
  const ownerChoices = owner && !members.some((m) => m.id === owner.id) ? [owner, ...members] : members;
  const questChoices = parent && !quests.some((q) => q.id === parent.id) ? [parent, ...quests] : quests;
  const edit = canWrite ? `<details class="edit"><summary>Edit</summary>
<form method="post" action="/api/work.update"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${back}">
<label>Title <input name="title" required maxlength="200" value="${esc(w.title)}"></label>
<div class="row"><label>Kind <select name="kind">${Object.entries(KINDS).map(([k, v]) => option(k, `${v.name} (${v.plain})`, w.kind === k)).join("")}</select></label>
<label>Owner <select name="owner">${option("none", "Nobody", !owner)}${ownerChoices.map((m) => option(m.email, `${m.display_name}${m.kind === "agent" ? " (helper)" : ""}`, owner?.id === m.id)).join("")}</select></label>
<label>Quest <select name="parent">${option("0", "None", !parent)}${questChoices.map((q) => option(String(q.number), `#${q.number} ${q.title}`, parent?.id === q.id)).join("")}</select></label></div>
<label>Details <textarea name="body" rows="8" maxlength="20000">${esc(w.body)}</textarea></label>
<button type="submit">Save changes</button></form></details>` : "";
  const under = children.length
    ? `<h2>Under it</h2><ul>${children.map((c) => `<li><a href="/${esc(project.slug)}/w/${c.number}">#${c.number}</a> ${esc(KINDS[c.kind].name)}: ${esc(c.title)} (${esc(STATES[c.state])})</li>`).join("")}</ul>`
    : w.kind === "quest" ? `<h2>Under it</h2><p class="lede">Nothing yet. To put an item under this quest, choose it as the item's quest when you edit it.</p>` : "";
  const body = `<p class="crumbs"><a href="/">${esc(ctx.tenant!.display_name)}</a> / <a href="/${esc(project.slug)}">${esc(project.display_name)}</a> / <a href="/${esc(project.slug)}/docket">${esc(DOCKET.name)}</a></p>
<h1>${esc(w.title)}</h1>
<p>${esc(KINDS[w.kind].name)} (${esc(KINDS[w.kind].plain)}) <strong>${esc(project.slug)}#${w.number}</strong> · ${esc(STATES[w.state])}${owner ? ` · ${esc(owner.display_name)}` : ""}${parent ? ` · part of <a href="/${esc(project.slug)}/w/${parent.number}">#${parent.number} ${esc(parent.title)}</a>` : ""}</p>
${controls}
${w.source_quote ? `<blockquote>${esc(w.source_quote)}</blockquote>` : ""}
${w.body.trim() ? `<div class="prose">${esc(w.body)}</div>` : `<p class="lede">No details yet.${canWrite ? " Add them under Edit: what, why, and how you will know it is done." : ""}</p>`}
${edit}
${under}
<h2>Links</h2>${links.length ? `<ul>${links.map((l) => `<li>${esc(l.target_kind)}: ${l.target_kind === "url" ? `<a href="${esc(l.target_ref)}" rel="noopener noreferrer">${esc(l.target_ref)}</a>` : `<code>${esc(l.target_ref)}</code>`}${l.note ? ` (${esc(l.note)})` : ""}</li>`).join("")}</ul>` : "<p>None yet. Helpers link commits, threads and pages here with work_link.</p>"}
<p><small>Filed ${when(w.created_at)}, updated ${when(w.updated_at)}${w.closed_at ? `, closed ${when(w.closed_at)}` : ""}.</small></p>`;
  return htmlResponse(page(`${project.slug}#${w.number} ${w.title}`, body, shellFor(ctx, env, "docket", w.id)), 200, extra);
}

/** Every project's work in one list, newest activity first. */
export async function orgDocketPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const f = readFilters(new URL(request.url), false);
  const [items, projects, members] = await ctx.db.batch([
    listWorkStatement(ctx.db, ctx.tenant.id, itemFilter(ctx, f, null)),
    ctx.db.prepare("SELECT id, slug FROM project WHERE tenant_id = ?").bind(ctx.tenant.id),
    membersStatement(ctx),
  ]);
  const slugs = new Map((projects!.results as Array<{ id: string; slug: string }>).map((r) => [r.id, r.slug]));
  const body = docketBody(ctx, null, items!.results as WorkItem[], members!.results as Member[], [], slugs, f);
  return htmlResponse(page(DOCKET.name, body, shellFor(ctx, env, "docket")), 200, extra);
}
