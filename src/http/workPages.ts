// The workbench's work views (2026-10-07): the Docket as the list pane, and the selected item, a new item, or an
// overview as the inspector. Item links carry the list's filters, so opening an item rebuilds the same list beside it
// and the script keeps the list where it was. Every page reads in one D1 batch after the project lookup.
import { attentionQuery } from "../verbs/collab";
import type { Env } from "../env";
import { safeExternalUrl } from "../security/urls";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, rank, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { getWorkByNumber, listLinksStatement, listWorkStatement, type WorkFilter, type WorkItem, type WorkLink } from "../db/work";
import { DOCKET, KINDS, STATES, type WorkKind } from "../work/names";
import { AREAS, PLANNED, plannedIn, type Area, type Plan } from "../verbs/planned";
import { toolName } from "../mcp/policy";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : m < 60 * 24 * 60 ? `${Math.round(m / 1440)}d` : new Date(ms).toISOString().slice(0, 10);
};

type Member = { id: string; display_name: string; email: string; kind: string };
type Quest = { id: string; number: number; title: string };
type Project = { id: string; slug: string; display_name: string; state: string };
type Activity = { kind: string; summary: string; created_at: number; who: string | null };
type Comment = { id: string; body: string; created_at: number; reply_to: string | null; author: string; handle: string | null };

const membersStatement = (ctx: Ctx) => ctx.db.prepare(
  `SELECT i.id, i.display_name, i.email, i.kind FROM membership m JOIN identity i ON i.id = m.identity_id
   WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' ORDER BY i.kind = 'agent', i.display_name`,
).bind(ctx.tenant!.id);
const questsStatement = (ctx: Ctx, project_id: string) => ctx.db.prepare(
  "SELECT id, number, title FROM work_item WHERE project_id = ? AND kind = 'quest' AND state IN ('open', 'doing') ORDER BY number",
).bind(project_id);
const projectsStatement = (ctx: Ctx) => ctx.db.prepare("SELECT id, slug, display_name FROM project WHERE tenant_id = ? AND kind <> 'channel'").bind(ctx.tenant!.id);

async function tenantCtx(request: Request, env: Env) {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const ok = ctx.host.kind === "tenant" && !!ctx.tenant && !!ctx.role && !!ctx.identity;
  return { ctx, extra, ok };
}

async function projectCtx(request: Request, env: Env, slug: string) {
  const { ctx, extra, ok } = await tenantCtx(request, env);
  if (!ok) return { ctx, extra, project: null };
  const project = await ctx.db.prepare("SELECT id, slug, display_name, state FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel'").bind(ctx.tenant!.id, slug)
    .first<Project>();
  return { ctx, extra, project };
}

// ---------- Filters ----------

type Filters = { kind: WorkKind | null; closed: boolean; owner: string | null; quest: number | null; org: boolean };

function readFilters(url: URL, inProject: boolean): Filters {
  const k = url.searchParams.get("kind");
  const o = (url.searchParams.get("owner") ?? "").trim().toLowerCase();
  const q = url.searchParams.get("quest") ?? "";
  const org = !inProject || url.searchParams.get("in") === "org";
  return {
    kind: k && KINDS[k as WorkKind] ? (k as WorkKind) : null,
    closed: url.searchParams.get("closed") === "1",
    owner: o && o.length <= 254 ? o : null,
    quest: !org && /^\d{1,8}$/.test(q) && Number(q) > 0 ? Number(q) : null,
    org,
  };
}

/** The query string for these filters; `withScope` keeps "in=org" for item links that belong to the org list. */
function qs(f: Filters, change: Partial<Filters> = {}, withScope = false): string {
  const n = { ...f, ...change };
  const p = new URLSearchParams();
  if (withScope && n.org) p.set("in", "org");
  if (n.kind) p.set("kind", n.kind);
  if (n.owner) p.set("owner", n.owner);
  if (n.quest) p.set("quest", String(n.quest));
  if (n.closed) p.set("closed", "1");
  return p.toString();
}
const listKey = (f: Filters, project: Project | null) => `docket:${f.org || !project ? "org" : project.slug}:${qs(f)}`;

function itemFilter(ctx: Ctx, f: Filters, project_id: string | null): WorkFilter {
  return {
    project_id: f.org ? null : project_id, kinds: f.kind ? [f.kind] : [], states: f.closed ? ["done", "dropped"] : ["open", "doing"], limit: 300,
    owner_id: f.owner === "me" ? ctx.identity!.id : null, owner_email: f.owner && f.owner !== "me" ? f.owner : null, parent_number: f.org ? null : f.quest,
  };
}

const option = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;

// ---------- The list pane ----------

function docketList(ctx: Ctx, project: Project | null, items: WorkItem[], members: Member[], quests: Quest[], slugs: Map<string, string>, f: Filters, selected: string | null = null): string {
  const base = f.org || !project ? "/docket" : `/${project.slug}/docket`;
  const to = (change: Partial<Filters>) => { const q = qs(f, change); return `${base}${q ? `?${esc(q)}` : ""}`; };
  const names = new Map(members.map((m) => [m.id, m.display_name]));
  const chip = (label: string, href: string, on: boolean, cls = "") => `<a class="chip${cls}" href="${href}"${on ? ' aria-current="true"' : ""}>${esc(label)}</a>`;
  const kinds = [chip("All kinds", to({ kind: null }), f.kind === null),
    ...Object.entries(KINDS).map(([k, v]) => chip(v.plural, to({ kind: k as WorkKind }), f.kind === k, ` k-${k}`))].join("");
  const quick = [chip("Anyone's", to({ owner: null }), f.owner === null), chip("Mine", to({ owner: "me" }), f.owner === "me"),
    `<span class="gap" aria-hidden="true"></span>`, chip("Open", to({ closed: false }), !f.closed), chip("Finished", to({ closed: true }), f.closed)].join("");
  const ownerKnown = f.owner === null || f.owner === "me" || members.some((m) => m.email === f.owner);
  const filterForm = `<form class="filters" method="get" action="${base}">${f.kind ? `<input type="hidden" name="kind" value="${f.kind}">` : ""}${f.closed ? `<input type="hidden" name="closed" value="1">` : ""}
<label>Owner <select name="owner">${option("", "Anyone", f.owner === null)}${option("me", "Me", f.owner === "me")}${ownerKnown ? "" : option(f.owner!, f.owner!, true)}${members.map((m) => option(m.email, `${m.display_name}${m.kind === "agent" ? " (agent)" : ""}`, f.owner === m.email)).join("")}</select></label>
${project && !f.org ? `<label>Quest <select name="quest">${option("", "Any", f.quest === null)}${quests.map((q) => option(String(q.number), `#${q.number} ${q.title}`, f.quest === q.number)).join("")}</select></label>` : ""}
<button type="submit" class="quiet">Show</button><input data-filter placeholder="Filter these (/)" aria-label="Filter the list" size="16"></form>`;
  const itemQs = qs(f, {}, true);
  const canBulk = rank(ctx.role) >= rank("member") && items.length > 0;
  const rows = items.map((w) => {
    const sl = slugs.get(w.project_id) ?? project?.slug ?? "?";
    const href = `/${sl}/w/${w.number}${itemQs ? `?${itemQs}` : ""}`;
    const who = w.owner_id ? (w.owner_id === ctx.identity!.id ? "You" : names.get(w.owner_id) ?? "Former member") : "";
    const box = canBulk ? `<td class="hide-s"><input type="checkbox" name="ids" value="${esc(`${sl}#${w.number}`)}" form="bulk" aria-label="Select ${esc(`${sl}#${w.number}`)}"></td>` : "";
    return `<tr data-href="${esc(href)}"${w.id === selected ? ' aria-selected="true"' : ""}>${box}<td class="ref">${esc(f.org || !project ? `${sl}#${w.number}` : `#${w.number}`)}</td><td class="k-${w.kind}"><span class="kd"></span>${esc(KINDS[w.kind].name)}</td><td><a href="${esc(href)}">${esc(w.title)}</a></td><td class="hide-s">${esc(who)}</td><td class="hide-s">${esc(STATES[w.state])}</td><td class="when hide-s" title="${when(w.updated_at)}">${ago(w.updated_at, ctx.now)}</td></tr>`;
  }).join("");
  const filtered = f.kind !== null || f.owner !== null || f.quest !== null;
  const empty = f.owner === "me" && !f.closed && f.kind === null && f.quest === null
    ? `Nothing is yours right now. Take something from <a href="${to({ owner: null })}">the open list</a>, or file what you are about to start.`
    : filtered ? `Nothing matches these filters. <a href="${base}">Show everything open</a>.`
    : f.closed ? "Nothing finished yet."
    : project ? "Nothing open. File something, or forward a thread to the project's address."
    : "Nothing open. File work with + File, or forward a thread to a project's address.";
  const where = f.org || !project ? esc(ctx.tenant!.display_name) : esc(project.display_name);
  const scope = project && !f.org ? `<a href="/docket">All projects</a> · <a href="/${esc(project.slug)}/board">Board</a> · <a href="/${esc(project.slug)}/status">Status</a> · <a href="/${esc(project.slug)}/code">Code</a>` : `<a href="/board">Board</a>`;
  const bulk = canBulk ? `<form id="bulk" class="bulk hide-s" method="post" action="/api/work.bulk_update"><input type="hidden" name="_back" value="${esc(base)}${qs(f) ? `?${esc(qs(f))}` : ""}"><span>With the checked:</span>
<select name="state"><option value="">state…</option><option value="open">Open</option><option value="doing">Under way</option><option value="done">Done</option><option value="dropped">Let go</option></select>
<select name="owner"><option value="">owner…</option><option value="me">Me</option><option value="none">Nobody</option>${members.map((m) => option(m.email, m.display_name, false)).join("")}</select>
<button type="submit" class="quiet">Apply</button></form>` : "";
  return `<p class="crumbs"><a href="/">${esc(ctx.tenant!.display_name)}</a>${project && !f.org ? ` / <a href="/${esc(project.slug)}">${esc(project.display_name)}</a>` : ""}</p>
<div class="head"><h1>${esc(DOCKET.name)}</h1><span>${items.length} ${f.closed ? "finished" : "open"} in ${where}</span>${scope}</div>
<div class="chips">${kinds}</div><div class="chips">${quick}</div>
${filterForm}
${bulk}
${items.length ? `<table><thead><tr>${canBulk ? '<th class="hide-s"></th>' : ""}<th></th><th>Kind</th><th>Title</th><th class="hide-s">Owner</th><th class="hide-s">State</th><th class="hide-s">Updated</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">${empty}</p>`}`;
}

// ---------- Inspector panes ----------

function plannedBlock(name: string, label: string): string {
  const p = PLANNED.get(name);
  if (!p) return "";
  return `<div class="planned"><b>${esc(label)}</b> <span class="pill">planned</span> ${esc(p.summary)} <a href="/planned/${p.area}?v=${esc(name)}">What it will do</a></div>`;
}

function itemInspector(ctx: Ctx, env: Env, project: Project, w: WorkItem, d: { links: WorkLink[]; children: WorkItem[]; owner: Member | null; parent: Quest | null; members: Member[]; quests: Quest[]; activity: Activity[]; comments: Comment[]; following: boolean }, back: string): string {
  const canWrite = rank(ctx.role) >= rank("member");
  const self = `/${esc(project.slug)}/w/${w.number}`;
  const keep = esc(back.includes("?") ? `${self}${back.slice(back.indexOf("?"))}` : self);
  const action = (state: string, label: string, quiet = true) => `<form class="inline" method="post" action="/api/work.update"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="_back" value="${keep}"><button type="submit"${quiet ? ' class="quiet"' : ""}>${esc(label)}</button></form>`;
  const follow = `<form class="inline" method="post" action="/api/work.subscribe"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="follow" value="${d.following ? "0" : "1"}"><input type="hidden" name="_back" value="${keep}"><button type="submit" class="quiet" title="${d.following ? "Stop hearing about changes" : "Hear about every change in What needs me"}">${d.following ? "Following ✓" : "Follow"}</button></form>`;
  const controls = canWrite ? `<p>${w.state !== "doing" ? `<form class="inline" method="post" action="/api/work.claim"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${keep}"><button type="submit">I'm on it</button></form> ` : ""}${w.state !== "done" ? action("done", "Done") : ""} ${w.state !== "dropped" ? action("dropped", "Let it go") : ""} ${(w.state === "done" || w.state === "dropped") ? action("open", "Reopen") : ""} ${follow}</p>` : `<p>${follow}</p>`;
  const comments = `<h2>Comments${d.comments.length ? ` <span class="pill">${d.comments.length}</span>` : ""}</h2>
${d.comments.length ? `<ul class="timeline">${d.comments.map((c) => `<li id="c-${esc(c.id)}"><time title="${when(c.created_at)}">${ago(c.created_at, ctx.now)}</time><span><b>${esc(c.author)}</b>${c.handle ? ` <small>@${esc(c.handle)}</small>` : ""}<div class="prose" style="margin-top:2px">${esc(c.body)}</div></span></li>`).join("")}</ul>` : `<p class="lede">No comments yet.</p>`}
${canWrite ? `<form method="post" action="/api/work.comment"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${keep}">
<label style="display:block"><textarea data-voice name="body" rows="3" required maxlength="10000" style="display:block;width:100%" placeholder="Comment. @handle mentions someone."></textarea></label><button type="submit">Comment</button></form>` : ""}`;
  const ownerChoices = d.owner && !d.members.some((m) => m.id === d.owner!.id) ? [d.owner, ...d.members] : d.members;
  const questChoices = d.parent && !d.quests.some((q) => q.id === d.parent!.id) ? [d.parent, ...d.quests] : d.quests;
  const edit = canWrite ? `<details class="edit"><summary>Edit</summary>
<form method="post" action="/api/work.update"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${keep}">
<label>Title <input name="title" required maxlength="200" value="${esc(w.title)}"></label>
<div class="row"><label>Kind <select name="kind">${Object.entries(KINDS).map(([k, v]) => option(k, `${v.name} (${v.plain})`, w.kind === k)).join("")}</select></label>
<label>Owner <select name="owner">${option("none", "Nobody", !d.owner)}${ownerChoices.map((m) => option(m.email, `${m.display_name}${m.kind === "agent" ? " (agent)" : ""}`, d.owner?.id === m.id)).join("")}</select></label>
<label>Quest <select name="parent">${option("0", "None", !d.parent)}${questChoices.map((q) => option(String(q.number), `#${q.number} ${q.title}`, d.parent?.id === q.id)).join("")}</select></label></div>
<label>Details <textarea name="body" rows="8" maxlength="20000">${esc(w.body)}</textarea></label>
<button type="submit">Save changes</button></form></details>` : "";
  const under = d.children.length
    ? `<h2>Under it</h2><table><tbody>${d.children.map((c) => `<tr data-href="/${esc(project.slug)}/w/${c.number}"><td class="ref">#${c.number}</td><td class="k-${c.kind}"><span class="kd"></span>${esc(KINDS[c.kind].name)}</td><td><a href="/${esc(project.slug)}/w/${c.number}">${esc(c.title)}</a></td><td>${esc(STATES[c.state])}</td></tr>`).join("")}</tbody></table>`
    : w.kind === "quest" ? `<h2>Under it</h2><p class="lede">Nothing yet. To put an item under this quest, choose it as the item's quest when you edit it.</p>` : "";
  const links = `<h2>Links</h2>${d.links.length ? `<ul>${d.links.map((l) => `<li>${esc(l.target_kind)}: ${l.target_kind === "url" && safeExternalUrl(l.target_ref) ? `<a href="${esc(safeExternalUrl(l.target_ref)!)}" rel="noopener noreferrer" data-reload>${esc(l.target_ref)}</a>` : `<code>${esc(l.target_ref)}</code>`}${l.note ? ` <small>(${esc(l.note)})</small>` : ""}</li>`).join("")}</ul>` : "<p class=\"lede\">None yet. Agents link commits, threads and pages here with work_link.</p>"}`;
  const activity = d.activity.length ? `<h2>Activity</h2><ul class="timeline">${d.activity.map((a) => `<li><time title="${when(a.created_at)}">${ago(a.created_at, ctx.now)}</time><span>${esc(a.who ?? "Pimwell")}: ${esc(a.summary)}</span></li>`).join("")}</ul>` : "";
  return `<a class="back" href="${esc(back)}">‹ ${esc(DOCKET.name)}</a>
<div class="head"><span class="k-${w.kind}"><span class="kd"></span>${esc(KINDS[w.kind].name)} (${esc(KINDS[w.kind].plain)})</span><strong>${esc(project.slug)}#${w.number}</strong><span>${esc(STATES[w.state])}</span></div>
<h1>${esc(w.title)}</h1>
<dl class="meta"><dt>Owner</dt><dd>${d.owner ? esc(d.owner.display_name) : "Nobody yet"}</dd><dt>Quest</dt><dd>${d.parent ? `<a href="/${esc(project.slug)}/w/${d.parent.number}">#${d.parent.number} ${esc(d.parent.title)}</a>` : "None"}</dd>
<dt>Project</dt><dd><a href="/${esc(project.slug)}/docket">${esc(project.display_name)}</a></dd><dt>Filed</dt><dd>${when(w.created_at)}${w.closed_at ? `, closed ${when(w.closed_at)}` : ""}</dd></dl>
${controls}
${w.source_quote ? `<blockquote>${esc(w.source_quote)}</blockquote>` : ""}
${w.body.trim() ? `<div class="prose">${esc(w.body)}</div>` : `<p class="lede">No details yet.${canWrite ? " Add them under Edit (e): what, why, and how you will know it is done." : ""}</p>`}
${edit}
${under}
${comments}
${plannedBlock("review.request", "Review")}
${links}
${activity}`;
}

function overviewInspector(ctx: Ctx, env: Env, project: Project | null, items: WorkItem[]): string {
  const byKind = Object.entries(KINDS).map(([k, v]) => ({ k, v, n: items.filter((w) => w.kind === k).length })).filter((x) => x.n > 0);
  const address = project ? `${ctx.tenant!.slug}.${project.slug}@${env.HUB_DOMAIN}` : `${ctx.tenant!.slug}@${env.HUB_DOMAIN}`;
  return `<div class="head"><span>${project ? "Project" : "Organization"}</span></div>
<h1>${esc(project ? project.display_name : ctx.tenant!.display_name)}</h1>
<p class="lede">Choose an item to open it here; the list stays put. <kbd>j</kbd> and <kbd>k</kbd> move, <kbd>Enter</kbd> opens.</p>
<div class="grid">${byKind.length ? byKind.map((x) => `<div class="card"><div class="stat k-${x.k}">${x.n}<small>${esc(x.v.plural)}</small></div><p>${esc(x.v.plain)}s</p></div>`).join("") : `<div class="card"><p>Nothing in this list yet.</p></div>`}</div>
<h2>Send work here</h2><p>Forward a thread to <code>${esc(address)}</code>, file it with <a href="/new${project ? `?project=${esc(project.slug)}` : ""}">+ File</a>, or ask an assistant over MCP.</p>
${project ? `<p><a href="/${esc(project.slug)}">Project page</a>: address, clone URL and history.</p>` : ""}
<h2>Coming to this view</h2>
${plannedBlock("work.board", "Board")}${plannedBlock("work.search", "Search")}${plannedBlock("work.bulk_update", "Change many")}`;
}

// ---------- Pages ----------

async function listAndInspect(request: Request, env: Env, slug: string | null, num: string | null): Promise<Response> {
  const pc = slug ? await projectCtx(request, env, slug) : { ...(await tenantCtx(request, env)), project: null as Project | null };
  const { ctx, extra } = pc;
  if (!("ok" in pc ? pc.ok : !!pc.project) || (slug && !pc.project)) return notFoundPage(extra);
  if (num !== null && !/^\d{1,8}$/.test(num)) return notFoundPage(extra);
  const project = pc.project;
  const url = new URL(request.url);
  const f = readFilters(url, !!project);
  const w = project && num !== null ? await getWorkByNumber(ctx.db, project.id, Number(num)) : null;
  if (num !== null && !w) return notFoundPage(extra);

  const stmts: D1PreparedStatement[] = [listWorkStatement(ctx.db, ctx.tenant!.id, itemFilter(ctx, f, project?.id ?? null)), membersStatement(ctx), projectsStatement(ctx)];
  const questFor = project ? questsStatement(ctx, project.id) : null;
  if (questFor) stmts.push(questFor);
  if (w) {
    stmts.push(
      listLinksStatement(ctx.db, w.id),
      listWorkStatement(ctx.db, ctx.tenant!.id, { parent_id: w.id, limit: 200, states: [] }),
      ctx.db.prepare("SELECT id, display_name, email, kind FROM identity WHERE id = ?").bind(w.owner_id),
      ctx.db.prepare("SELECT id, number, title FROM work_item WHERE id = ?").bind(w.parent_id),
      ctx.db.prepare(`SELECT e.kind, e.summary, e.created_at, i.display_name AS who FROM event e LEFT JOIN identity i ON i.id = e.identity_id
        WHERE e.tenant_id = ? AND e.target_id = ? ORDER BY e.created_at DESC LIMIT 30`).bind(ctx.tenant!.id, w.id),
      ctx.db.prepare(`SELECT c.id, c.body, c.created_at, c.reply_to, i.display_name AS author, m.handle FROM work_comment c JOIN identity i ON i.id = c.author_id
        LEFT JOIN membership m ON m.identity_id = c.author_id AND m.tenant_id = c.tenant_id WHERE c.item_id = ? ORDER BY c.created_at LIMIT 200`).bind(w.id),
      ctx.db.prepare("SELECT 1 AS f FROM follow WHERE identity_id = ? AND target_kind = 'item' AND target_id = ?").bind(ctx.identity!.id, w.id),
      // Seeing the item is what "done" means for its entries in What needs me; same batch, no extra round trip.
      ctx.db.prepare("UPDATE attention SET done_at = ? WHERE identity_id = ? AND item_id = ? AND done_at IS NULL").bind(ctx.now, ctx.identity!.id, w.id),
    );
  }
  const r = await ctx.db.batch(stmts);
  const items = r[0]!.results as WorkItem[];
  const members = r[1]!.results as Member[];
  const slugs = new Map((r[2]!.results as Array<{ id: string; slug: string }>).map((x) => [x.id, x.slug]));
  const quests = questFor ? (r[3]!.results as Quest[]) : [];
  const listHtml = docketList(ctx, project, items, members, quests, slugs, f, w?.id ?? null);
  const listBase = f.org || !project ? "/docket" : `/${project.slug}/docket`;
  const q = qs(f);
  const back = `${listBase}${q ? `?${q}` : ""}`;
  let inspector: string; let key: string;
  if (w && project) {
    const o = questFor ? 4 : 3;
    inspector = itemInspector(ctx, env, project, w, {
      links: r[o]!.results as WorkLink[], children: r[o + 1]!.results as WorkItem[],
      owner: (r[o + 2]!.results[0] as Member | undefined) ?? null, parent: (r[o + 3]!.results[0] as Quest | undefined) ?? null,
      members, quests: quests.filter((x) => x.id !== w.id), activity: r[o + 4]!.results as Activity[],
      comments: r[o + 5]!.results as Comment[], following: r[o + 6]!.results.length > 0,
    }, `${back}`);
    key = `w:${w.id}:${w.updated_at}:${(r[(questFor ? 4 : 3) + 5]!.results as Comment[]).length}`;
  } else {
    inspector = overviewInspector(ctx, env, f.org ? null : project, items);
    key = "";
  }
  const section = f.owner === "me" && !w ? "mine" : "docket";
  const title = w && project ? `${project.slug}#${w.number} ${w.title}` : project && !f.org ? `${DOCKET.name}: ${project.display_name}` : DOCKET.name;
  return htmlResponse(workbench(title, { list: listHtml, listKey: listKey(f, project), inspector, inspectorKey: key }, shellFor(ctx, env, section, project && !f.org ? project.slug : section)!), 200, extra);
}

export const docketPage = (request: Request, env: Env, slug: string) => listAndInspect(request, env, slug, null);
export const workItemPage = (request: Request, env: Env, slug: string, num: string) => listAndInspect(request, env, slug, num);
export const orgDocketPage = (request: Request, env: Env) => listAndInspect(request, env, null, null);

/** + File: the new-item form in the inspector, beside the organization's Docket. */
export async function newWorkPage(request: Request, env: Env): Promise<Response> {
  const { ctx, extra, ok } = await tenantCtx(request, env);
  if (!ok || rank(ctx.role) < rank("member")) return notFoundPage(extra);
  const url = new URL(request.url);
  const f = readFilters(new URL("https://x/"), false);
  const [items, members, projects] = await ctx.db.batch([listWorkStatement(ctx.db, ctx.tenant!.id, itemFilter(ctx, f, null)), membersStatement(ctx),
    ctx.db.prepare("SELECT id, slug, display_name FROM project WHERE tenant_id = ? AND kind <> 'channel' AND state = 'active' ORDER BY display_name").bind(ctx.tenant!.id)]);
  const ps = projects!.results as Array<{ id: string; slug: string; display_name: string }>;
  const want = url.searchParams.get("project") ?? "";
  const kind = (url.searchParams.get("kind") ?? "") as WorkKind;
  const title = (url.searchParams.get("title") ?? "").slice(0, 200);
  const slugs = new Map(ps.map((p) => [p.id, p.slug]));
  const form = ps.length ? `<form method="post" action="/api/work.create"><input type="hidden" name="_back" value="@result">
<label>Project <select name="project">${ps.map((p) => option(p.slug, p.display_name, p.slug === want)).join("")}</select></label>
<label>Kind <select name="kind">${Object.entries(KINDS).map(([k, v]) => option(k, `${v.name} (${v.plain})`, k === kind)).join("")}</select></label><br>
<label style="display:block">Title <input name="title" required maxlength="200" value="${esc(title)}" style="display:block;width:100%" autofocus></label>
<label style="display:block">Details <textarea data-voice name="body" rows="8" placeholder="What, why, and how you will know it is done." style="display:block;width:100%"></textarea></label>
<label>Owner <select name="owner">${option("", "Nobody yet", true)}${option("me", "Me", false)}</select></label>
<p><button type="submit">File it</button></p></form>` : `<p class="lede">Create a project first.</p>`;
  const inspector = `<a class="back" href="/docket">‹ ${esc(DOCKET.name)}</a><h1>File something</h1><p class="lede">No triage meeting needed. It opens here once filed, and agents can pick it up right away.</p>${form}`;
  const list = docketList(ctx, null, items!.results as WorkItem[], members!.results as Member[], [], slugs, f);
  return htmlResponse(workbench("File something", { list, listKey: listKey(f, null), inspector, inspectorKey: "new", focus: "inspector" }, shellFor(ctx, env, "new", "new")!), 200, extra);
}

/** The jump box: projects, items by ref or title, people, sections. JSON for the palette; a page without script. */
export async function jumpPage(request: Request, env: Env): Promise<Response> {
  const { ctx, extra, ok } = await tenantCtx(request, env);
  if (!ok) return notFoundPage(extra);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  const results: Array<{ label: string; hint: string; href: string; group?: string }> = [];
  // Nothing typed yet: likely places, so most jumps are one tap (owner, 2026-10-08). Recent picks are added by the
  // browser from its own memory; these come from the record.
  if (!q && new URL(request.url).searchParams.get("suggest") === "1") {
    const tid = ctx.tenant!.id;
    const [mineR, projR] = await ctx.db.batch([
      ctx.db.prepare(`SELECT p.slug, w.number, w.title, w.kind FROM work_item w JOIN project p ON p.id = w.project_id
        WHERE w.tenant_id = ? AND w.owner_id = ? AND w.state IN ('open', 'doing') ORDER BY w.updated_at DESC LIMIT 4`).bind(tid, ctx.identity!.id),
      ctx.db.prepare(`SELECT p.slug, p.display_name, MAX(w.updated_at) AS last, SUM(w.state IN ('open', 'doing')) AS open FROM project p LEFT JOIN work_item w ON w.project_id = p.id
        WHERE p.tenant_id = ? AND p.state = 'active' AND p.kind <> 'channel' GROUP BY p.id ORDER BY last IS NULL, last DESC, p.display_name LIMIT 5`).bind(tid),
    ]);
    const needs = ctx.rail?.needs ?? 0;
    for (const [label, hint, href] of [
      ["Needs me", needs ? `${needs} waiting` : "section", "/attention"], ["Docket", "all open work", "/docket"], ["Assistant", "ask anything", "/assistant"], ["Mail", "section", "/mail"],
    ] as Array<[string, string, string]>) results.push({ label, hint, href, group: "Go to" });
    for (const x of mineR!.results as Array<{ slug: string; number: number; title: string; kind: WorkKind }>) results.push({ label: x.title, hint: `${x.slug}#${x.number}`, href: `/${x.slug}/w/${x.number}`, group: "Your work" });
    for (const x of projR!.results as Array<{ slug: string; display_name: string; open: number | null }>) results.push({ label: x.display_name, hint: x.open ? `${x.open} open` : "project", href: `/${x.slug}/docket`, group: "Projects" });
    return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const ref = /^([a-z0-9][a-z0-9-]*)?#(\d{1,8})$/i.exec(q);
    const tid = ctx.tenant!.id;
    const [refR, projR, workR, peopleR] = await ctx.db.batch([
      ctx.db.prepare(`SELECT p.slug, w.number, w.title FROM work_item w JOIN project p ON p.id = w.project_id WHERE w.tenant_id = ? AND p.slug = ? AND w.number = ?`)
        .bind(tid, ref?.[1]?.toLowerCase() ?? "", ref ? Number(ref[2]) : 0),
      ctx.db.prepare(`SELECT slug, display_name FROM project WHERE tenant_id = ? AND kind <> 'channel' AND (slug LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY display_name LIMIT 5`).bind(tid, like, like),
      ctx.db.prepare(`SELECT p.slug, w.number, w.title, w.kind FROM work_item w JOIN project p ON p.id = w.project_id WHERE w.tenant_id = ? AND w.title LIKE ? ESCAPE '\\'
        ORDER BY w.state IN ('done', 'dropped'), w.updated_at DESC LIMIT 8`).bind(tid, like),
      ctx.db.prepare(`SELECT i.display_name, i.email, i.kind FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active'
        AND (i.display_name LIKE ? ESCAPE '\\' OR i.email LIKE ? ESCAPE '\\') LIMIT 5`).bind(tid, like, like),
    ]);
    for (const x of refR!.results as Array<{ slug: string; number: number; title: string }>) results.push({ label: `${x.slug}#${x.number} ${x.title}`, hint: "item", href: `/${x.slug}/w/${x.number}` });
    for (const x of projR!.results as Array<{ slug: string; display_name: string }>) results.push({ label: x.display_name, hint: "project", href: `/${x.slug}/docket` });
    for (const x of workR!.results as Array<{ slug: string; number: number; title: string; kind: WorkKind }>) results.push({ label: x.title, hint: `${x.slug}#${x.number} ${KINDS[x.kind].name}`, href: `/${x.slug}/w/${x.number}` });
    for (const x of peopleR!.results as Array<{ display_name: string; email: string; kind: string }>) results.push({ label: x.display_name, hint: x.kind === "agent" ? "agent's work" : "their work", href: `/docket?owner=${encodeURIComponent(x.email)}` });
    const sections: Array<[string, string]> = [["Docket", "/docket"], ["Mine", "/docket?owner=me"], ["Mail", "/mail"], ["Conversations", "/c"], ["People and agents", "/people"], ["Playground", "/playground"], ["Everything coming", "/planned"],
      ...Object.entries(AREAS).map(([k, a]) => [a.label, `/planned/${k}`] as [string, string])];
    for (const [label, href] of sections) if (label.toLowerCase().includes(q.toLowerCase())) results.push({ label, hint: "section", href });
  }
  if (q.length >= 2) results.push({ label: `Search everywhere for "${q}"`, hint: "search", href: `/search?q=${encodeURIComponent(q)}` });
  const seen = new Set<string>();
  const unique = results.filter((r) => (seen.has(r.href) ? false : (seen.add(r.href), true))).slice(0, 12);
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return new Response(JSON.stringify({ results: unique }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
  }
  const list = `<h1>Jump to “${esc(q)}”</h1>${unique.length ? `<table><tbody>${unique.map((r) => `<tr data-href="${esc(r.href)}"><td><a href="${esc(r.href)}">${esc(r.label)}</a></td><td class="when">${esc(r.hint)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">Nothing matches. Try a ref like <code>site#3</code>, a project, or a name.</p>`}`;
  return htmlResponse(workbench("Jump", { list, listKey: `jump:${q}`, inspector: null }, shellFor(ctx, env, "home", "jump")!), 200, extra);
}

/** What is coming: each planned area with its verbs, and one verb's spec in the inspector. */
export async function plannedPage(request: Request, env: Env, areaParam: string | null): Promise<Response> {
  const { ctx, extra, ok } = await tenantCtx(request, env);
  if (!ok) return notFoundPage(extra);
  const area = areaParam === "traces" ? "traces" : areaParam as Area | null;
  if (area !== null && !AREAS[area]) return notFoundPage(extra);
  const plans = area ? plannedIn(area) : [...PLANNED.values()];
  const chosen = PLANNED.get(new URL(request.url).searchParams.get("v") ?? "") ?? null;
  const base = area ? `/planned/${area}` : "/planned";
  const rows = plans.map((p) => `<tr data-href="${base}?v=${esc(p.name)}"><td><a href="${base}?v=${esc(p.name)}"><code>${esc(p.name)}</code></a></td><td>${esc(p.summary)}</td><td class="when hide-s">${esc(AREAS[p.area].label)}</td></tr>`).join("");
  const list = `<p class="crumbs"><a href="/planned">Everything coming</a></p><div class="head"><h1>${esc(area ? AREAS[area].label : "Everything coming")}</h1><span class="pill">planned</span></div>
<p class="lede">${esc(area ? AREAS[area].blurb : "These are planned and already have their shape: each is an API verb and an MCP tool that answers not_implemented with its spec. Calls are logged, so asking for one is a vote for building it next.")}</p>
${area ? "" : `<div class="chips">${Object.entries(AREAS).map(([k, a]) => `<a class="chip" href="/planned/${k}">${esc(a.label)}</a>`).join("")}</div>`}
<table><thead><tr><th>Verb</th><th>What it does</th><th class="hide-s">Area</th></tr></thead><tbody>${rows}</tbody></table>`;
  const inspector = chosen ? planInspector(chosen) : null;
  const key = area ?? "all";
  return htmlResponse(workbench(chosen ? `${chosen.name} (planned)` : "Coming", { list, listKey: `planned:${key}`, inspector, inspectorKey: chosen ? `plan:${chosen.name}` : "" },
    shellFor(ctx, env, "planned", area === null ? "all" : area)!), 200, extra);
}

function planInspector(p: Plan): string {
  const params = Object.entries(p.input).map(([k, v]) => `<tr><td><code>${esc(k)}</code>${p.required?.includes(k) ? " <small>required</small>" : ""}</td><td>${esc(String((v as { description?: string }).description ?? (v as { type?: string }).type ?? ""))}</td></tr>`).join("");
  return `<a class="back" href="/planned/${p.area}">‹ ${esc(AREAS[p.area].label)}</a>
<div class="head"><span class="pill">planned</span><span>${esc(AREAS[p.area].label)}</span></div>
<h1>${esc(p.title)}</h1><p class="lede">${esc(p.summary)}</p>
<dl class="meta"><dt>API</dt><dd><code>POST /api/${esc(p.name)}</code></dd><dt>MCP tool</dt><dd><code>${esc(toolName(p.name))}</code></dd><dt>Role</dt><dd>${esc(p.minRole)}, ${p.kind === "query" ? "read" : "write"} scope</dd></dl>
<h2>What it will do</h2><div class="prose">${esc(p.spec)}</div>
${params ? `<h2>Inputs</h2><table><tbody>${params}</tbody></table>` : ""}
<h2>Today</h2><p>Calls answer <code>501 not_implemented</code> with this spec. Try it in the <a href="/playground">Playground</a>, or <a href="/new?kind=errand&amp;title=${encodeURIComponent(`Build ${p.name}`)}">file it as an errand</a> so a person or agent picks it up.</p>`;
}

/** What needs me: the attention list, newest first; opening an entry opens its item, which marks it done. */
export async function attentionPage(request: Request, env: Env): Promise<Response> {
  const { ctx, extra, ok } = await tenantCtx(request, env);
  if (!ok) return notFoundPage(extra);
  const showDone = new URL(request.url).searchParams.get("done") === "1";
  const entries = (await attentionQuery(ctx, showDone, 200).all<{ id: string; reason: string; summary: string; created_at: number; done_at: number | null; slug: string | null; number: number | null; title: string | null; actor: string | null; href: string | null }>()).results;
  const label: Record<string, string> = { mention: "Mentioned you", comment: "Comment", assigned: "Yours now", changed: "Changed", filed: "Filed for you" };
  const rows = entries.map((e) => {
    const href = e.slug ? `/${e.slug}/w/${e.number}` : e.href ?? "/attention";
    return `<tr data-href="${esc(href)}"${e.done_at ? ' style="opacity:.6"' : ""}><td class="when">${esc(label[e.reason] ?? e.reason)}</td><td class="ref">${e.slug ? esc(`${e.slug}#${e.number}`) : ""}</td><td><a href="${esc(href)}">${esc(e.summary)}</a></td><td class="when">${ago(e.created_at, ctx.now)}</td></tr>`;
  }).join("");
  const list = `<div class="head"><h1>Needs me</h1><span>${entries.length} ${showDone ? "recent" : "waiting"}</span>
${!showDone && entries.length ? `<form class="inline" method="post" action="/api/attention.done"><input type="hidden" name="all" value="1"><input type="hidden" name="_back" value="/attention"><button type="submit" class="quiet">Mark all done</button></form>` : ""}
<a href="${showDone ? "/attention" : "/attention?done=1"}">${showDone ? "Only what's waiting" : "Include done"}</a></div>
<p class="lede">Mentions, comments and changes on what you follow, and work given to you. Opening an item marks its entries done.</p>
${entries.length ? `<table><tbody>${rows}</tbody></table>` : `<p class="empty">Nothing needs you right now.</p>`}`;
  return htmlResponse(workbench("Needs me", { list, listKey: `attention:${entries.length}:${entries[0]?.id ?? ""}`, inspector: null }, shellFor(ctx, env, "attention", "attention")!), 200, extra);
}
