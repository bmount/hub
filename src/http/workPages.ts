import { graphStatements, graphFrom } from "../work/graphEdit";
import { graphContext, viewGraph, describeReadiness, type ReadinessView, type View } from "../work/graphView";
import { workGraph, workFrontier } from "../verbs/graph";
import { projectPathSql } from "../db/projects";
import { projectFeatures } from "../projectFeatures";
// The workbench's work views (2026-10-07): the Docket as the list pane, and the selected item, a new item, or an
// overview as the inspector. Item links carry the list's filters, so opening an item rebuilds the same list beside it
// and the script keeps the list where it was. Every page reads in one D1 batch after the project lookup.
import { attentionQuery } from "../verbs/collab";
import type { Env } from "../env";
import { HubError } from "../errors";
import { safeExternalUrl } from "../security/urls";
import { localTime, emptyState, esc, htmlResponse, inspectorSection, formRow, kitList, kitTable, kitTabs, statusChip, toolbar, workbench, type KitRow } from "../html";
import { buildContext, rank, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { projectImages } from "./projectImages";
import { getWorkByNumber, listLinksStatement, listWorkStatement, type WorkFilter, type WorkItem, type WorkLink } from "../db/work";
import { DOCKET, KINDS, STATES, type WorkKind } from "../work/names";
import { AREAS, PLANNED, plannedIn, type Area, type Plan } from "../verbs/planned";
import { toolName } from "../mcp/policy";
import { cutText } from "../mcp/render";
import { traceEvidenceUrl, traceDraftStatement } from "../apps/work";
import { reviewEvidenceUrl, reviewDraftStatement } from "../work/reviewEvidence";

const when = localTime;
const ago = (ms: number | null, _now: number) => localTime(ms);

type Member = { id: string; display_name: string; email: string; kind: string };
type Quest = { id: string; number: number; title: string };
type Project = { id: string; slug: string; kind: string; display_name: string; state: string };
type Activity = { kind: string; summary: string; created_at: number; who: string | null };
type Comment = { id: string; body: string; created_at: number; reply_to: string | null; author: string; handle: string | null };

const membersStatement = (ctx: Ctx) => ctx.db.prepare(
  `/*perf-site:src%2Fhttp%2FworkPages.ts:36:40:membersStatement:ecb8b4d6*/ SELECT i.id, i.display_name, i.email, i.kind FROM membership m JOIN identity i ON i.id = m.identity_id
   WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' ORDER BY i.kind = 'agent', i.display_name`,
).bind(ctx.tenant!.id);
const questsStatement = (ctx: Ctx, project_id: string) => ctx.db.prepare(
  "/*perf-site:src%2Fhttp%2FworkPages.ts:40:59:questsStatement:1bf47dd1*/ SELECT id, number, title FROM work_item WHERE project_id = ? AND kind = 'quest' AND state IN ('open', 'doing') ORDER BY number",
).bind(project_id);
const projectsStatement = (ctx: Ctx) => ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:43:41:projectsStatement:a3771845*/ SELECT id, slug, display_name FROM project WHERE tenant_id = ? AND kind NOT IN ('channel', 'agent-src')").bind(ctx.tenant!.id);

async function tenantCtx(request: Request, env: Env) {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  const ok = ctx.host.kind === "tenant" && !!ctx.tenant && !!ctx.role && !!ctx.identity;
  return { ctx, extra, ok };
}

async function projectCtx(request: Request, env: Env, slug: string) {
  const { ctx, extra, ok } = await tenantCtx(request, env);
  if (!ok) return { ctx, extra, project: null };
  const project = await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:55:25:projectCtx:d1055dba*/ SELECT p.id, ${projectPathSql()} AS slug, p.kind, p.display_name, p.state FROM project p WHERE p.tenant_id = ? AND (${projectPathSql()}) = ? AND p.kind NOT IN ('channel', 'agent-src')`).bind(ctx.tenant!.id, slug)
    .first<Project>();
  return { ctx, extra, project: project && projectFeatures(project.kind).includes("docket") ? project : null };
}

function readinessHtml(r: ReadinessView, compact = false): string {
  return `<span class="wb-readiness${compact ? " wb-readiness-compact" : ""}" title="${esc(describeReadiness(r))}">${statusChip(describeReadiness(r), r.status === "ready" ? "open" : r.status === "claimed" ? "doing" : r.status === "closed" ? "done" : "blocked")}</span>`;
}

function dependencyInspector(g: Awaited<ReturnType<typeof graphContext>>, w: WorkItem, writable: boolean, keep: string, back: string): string {
  const form = (verb: string, id: string, controls: string, label: string, destination = keep) => `<form method="post" action="/api/${verb}">${id ? `<input type="hidden" name="id" value="${esc(id)}">` : ""}<input type="hidden" name="_back" value="${destination}">${controls}<button type="submit" class="quiet">${esc(label)}</button></form>`;
  const refs = (direction: "up" | "down") => {
    const edges = g.g.edges.filter(e => direction === "up" ? e.dependent_id === w.id : e.prereq_id === w.id);
    const title = direction === "up" ? "Waits on" : "Waiting on it";
    const add = writable ? `<details class="wb-add-dependency"><summary>+ Add</summary>${direction === "up" ? form("work.depend", w.id, `<label>Item <input name="on" required placeholder="project#number" maxlength="80"></label>`, "Add") : form("work.depend", "", `<label>Item <input name="id" required placeholder="project#number" maxlength="80"></label><input type="hidden" name="on" value="${esc(w.id)}">`, "Add")}</details>` : "";
    return (edges.length ? `<h3>${title}</h3>` + kitList(title, edges.map(e => {
      const id = direction === "up" ? e.prereq_id : e.dependent_id;
      const n = g.byId.get(id)!;
      const href = `/${n.ref.split("#")[0]}/w/${n.ref.split("#")[1]}`;
      return {html: `<a href="${esc(href)}">${esc(n.ref)} ${esc(n.title)}</a> ${readinessHtml(g.readinessOf(id))}${writable ? form("work.depend", direction === "up" ? w.id : id, `<input type="hidden" name="remove" value="${esc(direction === "up" ? id : w.id)}">`, "Remove dependency") : ""}`};
    })) : `<p class="lede">${title}: none</p>`) + add;
  };
  const resources = g.g.resources.filter(r => r.item_id === w.id).map(r => `${r.name}${r.mode === "shared" ? ":shared" : ""}`).join(", ");
  return `<h2>Dependencies and resources</h2>${readinessHtml(g.readinessOf(w.id))}${refs("up")}${refs("down")}
${inspectorSection("Resources", [{label: "Needs", html: esc(resources || "None"), editHtml: writable ? form("work.resources", w.id, `<label>Resources <input name="resources" value="${esc(resources)}" placeholder="prod-db, replica:shared"></label>`, "Save resources") : ""}])}
${writable ? `<details><summary>Delete item</summary><p>Delete permanently, including comments, links and dependencies. Use Let it go for real work that will not happen.</p>${form("work.delete", w.id, `<label>Type ${esc(g.refOf(w.id))} to confirm <input name="confirm" required autocomplete="off" maxlength="80"></label>`, "Delete permanently", esc(back))}</details>` : ""}`;
}

/** Server-rendered graph and frontier reuse the query verbs and the shared inspector. */
export async function dependencyPage(request: Request, env: Env, slug: string, view: "graph" | "frontier"): Promise<Response> {
  const {ctx, extra, project} = await projectCtx(request, env, slug);
  if (!project) return notFoundPage(extra);
  const url = new URL(request.url);
  const href = (ref: string) => { const u = new URL(url); u.searchParams.set("work", ref); return u.pathname + u.search; };
  const row = (v: View): KitRow => ({href: href(v.ref), selected: url.searchParams.get("work") === v.ref, cells: [{html: `<a href="${esc(href(v.ref))}">${esc(v.ref)} ${esc(v.title)}</a>`}, {html: `P${v.priority}`}, {html: readinessHtml(v.readiness)}]});
  const table = (label: string, items: View[]) => items.length ? kitTable(label, [{label: "Item"}, {label: "Priority"}, {label: "Readiness"}], items.map(row)) : `<p class="lede">No ${esc(label.toLowerCase())}.</p>`;
  let content: string;
  if (view === "graph") {
    const result = await workGraph.run(ctx, workGraph.parse({project: slug}));
    if (!("items" in result)) throw new HubError(500, "internal");
    const levels = new Map<string, number>();
    for (const n of result.items) levels.set(n.ref, Math.max(0, ...result.edges.filter(e => e.dependent === n.ref).map(e => (levels.get(e.prerequisite) ?? 0) + 1)));
    const layers = [...new Set(levels.values())].sort((a,b) => a-b);
    content = `<p class="lede">Prerequisites first; each later stage waits on earlier work. External prerequisites are included.</p><div class="wb-dependency-graph">${layers.map(level => `<section aria-label="Dependency stage ${level + 1}"><h2>Stage ${level + 1}</h2>${kitList(`Dependency stage ${level + 1}`, result.items.filter(n => levels.get(n.ref) === level).map(n => ({href: href(n.ref), selected: url.searchParams.get("work") === n.ref, html: `<a href="${esc(href(n.ref))}">${esc(n.ref)} ${esc(n.title)}</a> P${n.priority}<br>${readinessHtml(n.readiness)}<div class="lede">Waits on: ${result.edges.filter(e => e.dependent === n.ref).map(e => `<a href="${esc(href(e.prerequisite))}">${esc(e.prerequisite)}</a>`).join(", ") || "nothing"}</div>`})))}</section>`).join("")}</div>${!result.items.length ? '<p class="lede">No open items. File work from + File.</p>' : ""}`;
  } else {
    const result = await workFrontier.run(ctx, workFrontier.parse({project: slug, limit: 100}));
    content = `<p aria-label="Readiness counts">Ready ${result.counts.ready} · Blocked ${result.counts.blocked} · Claimed ${result.counts.claimed} · Waiting for a resource ${result.counts.conflict}</p><h2>Ready now</h2><p class="lede">Ranked by priority, critical chain, downstream work, estimate and age. Showing ${result.ready.length} of ${result.counts.ready}.</p>${result.ready.length ? kitTable("Ready now", [{label:"Item"},{label:"Priority"},{label:"Readiness"},{label:"Chain",className:"hide-s"},{label:"Downstream",className:"hide-s"}], result.ready.map(v => { const r = row(v); r.cells.push({html:`${v.critical}h`,className:"hide-s"}, {html:String(v.downstream),className:"hide-s"}); return r; })) : '<p class="lede">No executable work can start now.</p>'}<h2>Stuck behind dropped items</h2>${table("Stuck items", result.stuck)}`;
  }
  let selected;
  try { selected = await selectedWorkInspector(ctx, env, url, null); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
  const label = view === "graph" ? "Dependency graph" : "Execution frontier";
  const list = `<h1>${label}</h1>${toolbar("Work views", kitTabs("Work views", ["docket", "graph", "frontier"].map(v => ({label: v === "docket" ? "Docket" : v === "graph" ? "Graph" : "Frontier", href: `/${slug}/${v}${url.searchParams.has("filter") ? `?filter=${encodeURIComponent(url.searchParams.get("filter")!)}` : ""}`, current: v === view}))), '<form method="get"><input data-filter name="filter" aria-label="Filter the list" placeholder="Filter these (/)" size="16"></form>')}${content}`;
  return htmlResponse(workbench(label, {list, listKey: `${view}:${slug}`, stackOnPhone: true, inspector: selected.html, inspectorKey: selected.key}, shellFor(ctx, env, "project", slug)!), 200, extra);
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

function docketList(ctx: Ctx, project: Project | null, items: WorkItem[], members: Member[], quests: Quest[], slugs: Map<string, string>, f: Filters, selected: string | null = null, readiness = new Map<string, ReadinessView>()): string {
  const base = f.org || !project ? "/docket" : `/${project.slug}/docket`;
  const to = (change: Partial<Filters>) => { const q = qs(f, change); return `${base}${q ? `?${q}` : ""}`; };
  const names = new Map(members.map((m) => [m.id, m.display_name]));
  const kinds = kitTabs("Work kinds", [{label: "All kinds", href: to({kind: null}), current: f.kind === null},
    ...Object.entries(KINDS).map(([k, v]) => ({label: v.plural, href: to({kind: k as WorkKind}), current: f.kind === k}))]);
  const ownerKnown = f.owner === null || f.owner === "me" || members.some((m) => m.email === f.owner);
  const filterForm = `<form class="filters" method="get" action="${base}">${f.kind ? `<input type="hidden" name="kind" value="${f.kind}">` : ""}
<select name="closed" aria-label="State">${option("", "Open", !f.closed)}${option("1", "Finished", f.closed)}</select>
<select name="owner" aria-label="Owner">${option("", "Anyone", f.owner === null)}${option("me", "Me", f.owner === "me")}${ownerKnown ? "" : option(f.owner!, f.owner!, true)}${members.map((m) => option(m.email, `${m.display_name}${m.kind === "agent" ? " (agent)" : ""}`, f.owner === m.email)).join("")}</select>
${project && !f.org ? `<select name="quest" aria-label="Quest">${option("", "Any quest", f.quest === null)}${quests.map((q) => option(String(q.number), `#${q.number} ${q.title}`, f.quest === q.number)).join("")}</select>` : ""}
<noscript><button type="submit" class="quiet">Apply filters</button></noscript><input data-filter name="filter" placeholder="Filter these (/)" aria-label="Filter the list" size="16"></form>`;
  const itemQs = qs(f, {}, true);
  const canBulk = rank(ctx.role) >= rank("member") && items.length > 0;
  const rows = items.map((w) => {
    const sl = slugs.get(w.project_id) ?? project?.slug ?? "?";
    const href = `/${sl}/w/${w.number}${itemQs ? `?${itemQs}` : ""}`;
    const who = w.owner_id ? (w.owner_id === ctx.identity!.id ? "You" : names.get(w.owner_id) ?? "Former member") : "";
    const box = canBulk ? [{className: "hide-s", html: `<input type="checkbox" name="ids" value="${esc(`${sl}#${w.number}`)}" form="bulk" aria-label="Select ${esc(`${sl}#${w.number}`)}">`}] : [];
    return {href, selected: w.id === selected, cells: [...box,
      {className: "ref", html: esc(f.org || !project ? `${sl}#${w.number}` : `#${w.number}`)},
      {className: "hide-s", html: statusChip(KINDS[w.kind].name, w.kind)},
      {className: "work-title", html: `<a href="${esc(href)}" title="${esc(w.title)}">${esc(w.title)}</a>`},
      {className: "wb-priority", html: `P${w.priority}`},
      {html: readinessHtml(readiness.get(w.id) ?? {status: "closed"}, true)},
      {className: "hide-s", html: esc(who)},
      {className: "hide-s", html: statusChip(STATES[w.state], w.state)},
      {className: "when hide-s", html: `${ago(w.updated_at, ctx.now)}`}]};
  });
  const filtered = f.kind !== null || f.owner !== null || f.quest !== null;
  const empty = f.owner === "me" && !f.closed && f.kind === null && f.quest === null
    ? `Nothing is yours right now. Take something from <a href="${to({ owner: null })}">the open list</a>, or file what you are about to start.`
    : filtered ? `Nothing matches these filters. <a href="${base}">Show everything open</a>.`
    : f.closed ? "Nothing finished yet."
    : project ? "Nothing open. File something, or forward a thread to the project's address."
    : "Nothing open. File work with + File, or forward a thread to a project's address.";
  const where = f.org || !project ? esc(ctx.tenant!.display_name) : esc(project.display_name);
  const bulk = canBulk ? `<form id="bulk" class="bulk hide-s" method="post" action="/api/work.bulk_update"><input type="hidden" name="_back" value="${esc(base)}${qs(f) ? `?${esc(qs(f))}` : ""}"><span>With the checked:</span>
<select name="state"><option value="">state…</option><option value="open">Open</option><option value="doing">Under way</option><option value="done">Done</option><option value="dropped">Let go</option></select>
<select name="owner"><option value="">owner…</option><option value="me">Me</option><option value="none">Nobody</option>${members.map((m) => option(m.email, m.display_name, false)).join("")}</select>
<button type="submit" class="quiet">Apply</button></form>` : "";
  return `<div class="head"><h1>${esc(DOCKET.name)}</h1><span>${items.length} ${f.closed ? "finished" : "open"} in ${where}</span></div>
${toolbar("Docket actions and filters", kinds, filterForm)}
${bulk}
${items.length ? kitTable("Docket", [...(canBulk ? [{label: "Select", className: "hide-s"}] : []), {label: "Reference"}, {label: "Kind", className: "hide-s"}, {label: "Title"}, {label: "Priority"}, {label: "Readiness"}, {label: "Owner", className: "hide-s"}, {label: "State", className: "hide-s"}, {label: "Updated", className: "hide-s"}], rows) : emptyState("No work here", empty.replace(/<[^>]*>/g, ""), {label: filtered ? "Show everything open" : "File work", href: filtered ? base : "/new"})}`;
}

// ---------- Inspector panes ----------

function plannedBlock(name: string, label: string): string {
  const p = PLANNED.get(name);
  if (!p) return "";
  return `<div class="planned"><b>${esc(label)}</b> <span class="pill">planned</span> ${esc(p.summary)} <a href="/planned/${p.area}?v=${esc(name)}">What it will do</a></div>`;
}

function mailEvidenceHref(reference: string | null): string | null {
  return reference?.length === 26 && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(reference) ? `/mail/${reference}` : null;
}

function messageEvidenceHref(reference: string | null): string | null {
  return reference?.length === 26 && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(reference) ? `/m/${reference}` : null;
}

function workLinkHtml(l: WorkLink): string {
  let href: string | null = null;
  if (l.target_kind === "url") href = safeExternalUrl(l.target_ref);
  else if (l.target_kind === "mail") href = mailEvidenceHref(l.target_ref);
  else if (l.target_kind === "message") href = messageEvidenceHref(l.target_ref);
  else if (!/\s/.test(l.target_ref)) {
    const name = "([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
    if (l.target_kind === "commit") {
      const m = new RegExp(`^${name}(?:/${name})?@([0-9a-fA-F]{40})$`).exec(l.target_ref);
      if (m) href = `/${m[1]}/code?c=${m[3]!.toLowerCase()}${m[2] ? `&repo=${encodeURIComponent(m[2])}` : ""}`;
    } else if (l.target_kind === "item") {
      const m = new RegExp(`^${name}#([1-9][0-9]{0,7})$`).exec(l.target_ref);
      if (m) href = `/${m[1]}/w/${m[2]}`;
    }
  }
  // A recorded reference is not proof of existence or access; the destination rechecks the viewer.
  const target = href ? `<a href="${esc(href)}"${l.target_kind === "url" ? ' rel="noopener noreferrer" data-reload' : ""}>${esc(l.target_ref)}</a>` : `<code>${esc(l.target_ref)}</code>`;
  return `<li>${esc(l.target_kind)}: ${target}${l.note ? ` <small>(${esc(l.note)})</small>` : ""}</li>`;
}

async function itemInspector(ctx: Ctx, env: Env, project: Project, w: WorkItem, d: { links: WorkLink[]; children: WorkItem[]; owner: Member | null; parent: Quest | null; members: Member[]; quests: Quest[]; activity: Activity[]; comments: Comment[]; following: boolean }, back: string, selectedUrl?: string, suppliedGraph?: Awaited<ReturnType<typeof graphContext>>): Promise<string> {
  const canWrite = rank(ctx.role) >= rank("member") && project.state === "active";
  const graph = suppliedGraph ?? await graphContext(ctx);
  const sourceMail = w.source_kind === "mail" ? mailEvidenceHref(w.source_ref) : null;
  const sourceMessage = w.source_kind === "message" ? messageEvidenceHref(w.source_ref) : null;
  const sourceUrl = w.source_kind === "url" && w.source_ref ? safeExternalUrl(w.source_ref) : null;
  const self = `/${esc(project.slug)}/w/${w.number}`;
  const keepParams = new URLSearchParams(back.includes("?") ? back.slice(back.indexOf("?") + 1) : "");
  if (back.startsWith("/docket")) keepParams.set("in", "org");
  const keep = esc(selectedUrl ?? `${self}${keepParams.size ? `?${keepParams}` : ""}`);
  const expectedUpdate = `<input type="hidden" name="expected_updated_at" value="${w.updated_at}">`;
  const action = (state: string, label: string, quiet = true) => `<form class="inline" method="post" action="/api/work.update"><input type="hidden" name="id" value="${esc(w.id)}">${expectedUpdate}<input type="hidden" name="state" value="${state}"><input type="hidden" name="_back" value="${keep}"><button type="submit"${quiet ? ' class="quiet"' : ""}>${esc(label)}</button></form>`;
  const follow = `<form class="inline" method="post" action="/api/work.subscribe"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="follow" value="${d.following ? "0" : "1"}"><input type="hidden" name="_back" value="${keep}"><button type="submit" class="quiet" title="${d.following ? "Stop hearing about changes" : "Hear about every change in What needs me"}">${d.following ? "Following ✓" : "Follow"}</button></form>`;
  const controls = canWrite ? `<p>${w.state !== "doing" ? `<form class="inline" method="post" action="/api/work.claim"><input type="hidden" name="id" value="${esc(w.id)}">${expectedUpdate}<input type="hidden" name="_back" value="${keep}"><button type="submit">I'm on it</button></form> ` : ""}${w.state !== "done" ? action("done", "Done") : ""} ${w.state !== "dropped" ? action("dropped", "Let it go") : ""} ${(w.state === "done" || w.state === "dropped") ? action("open", "Reopen") : ""} ${follow}</p>` : `<p>${follow}</p>`;
  const bodyHtml = await projectImages(ctx, project.slug, w.body, esc);
  const commentHtml = await Promise.all(d.comments.map(c => projectImages(ctx, project.slug, c.body, esc)));
  const comments = `<h2>Comments${d.comments.length ? ` <span class="pill">${d.comments.length}</span>` : ""}</h2>
${d.comments.length ? kitList("comments", d.comments.map((c, i)=>({html:`${ago(c.created_at, ctx.now)} · <span><b>${esc(c.author)}</b>${c.handle ? ` <small>@${esc(c.handle)}</small>` : ""}<div class="prose" style="margin-top:2px">${commentHtml[i]}</div></span>`}))) : `<p class="lede">No comments yet.</p>`}
${canWrite ? `<form class="wb-comment" method="post" action="/api/work.comment"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${keep}">
<textarea aria-label="Comment" data-voice data-enter-submits name="body" rows="1" required maxlength="10000" placeholder="Comment…"></textarea><button type="submit" class="quiet" aria-label="Send comment">↑</button></form>` : ""}`;
  const ownerChoices = d.owner && !d.members.some((m) => m.id === d.owner!.id) ? [d.owner, ...d.members] : d.members;
  const questChoices = d.parent && !d.quests.some((q) => q.id === d.parent!.id) ? [d.parent, ...d.quests] : d.quests;
  const field = (label: string, value: string, control: string) => ({label, html: value, editHtml: canWrite ? `<form method="post" action="/api/work.update"><input type="hidden" name="id" value="${esc(w.id)}">${expectedUpdate}<input type="hidden" name="_back" value="${keep}"><label>${esc(label)} ${control}</label><button type="submit">Save ${esc(label.toLowerCase())}</button></form>` : ""});
  const inlineField = (f: ReturnType<typeof field>) => f.editHtml ? `<details class="wb-inline-edit"><summary aria-label="Change ${esc(f.label)}">${f.html}<span class="wb-pencil" aria-hidden="true">✎</span></summary>${f.editHtml}</details>` : f.html;
  const titleField = inlineField(field("Title", esc(w.title), `<input name="title" required maxlength="200" value="${esc(w.title)}">`));
  const stateField = inlineField(field("State", esc(STATES[w.state]), `<select name="state">${Object.entries(STATES).map(([s, label]) => option(s, label, s === w.state)).join("")}</select>`));
  const kindField = inlineField(field("Kind", `${esc(KINDS[w.kind].name)} (${esc(KINDS[w.kind].plain)})`, `<select name="kind">${Object.entries(KINDS).map(([k, v]) => option(k, v.name, w.kind === k)).join("")}</select>`));
  const edit = inspectorSection("Fields", [
    field("Owner", esc(d.owner?.display_name ?? "Nobody"), `<select name="owner">${option("none", "Nobody", !d.owner)}${ownerChoices.map(m => option(m.email, m.display_name, d.owner?.id === m.id)).join("")}</select>`),
    field("Priority", `P${w.priority}`, `<select name="priority">${[0, 1, 2, 3].map(p => option(String(p), `P${p}`, p === w.priority)).join("")}</select>`),
    field("Quest", d.parent ? esc(d.parent.title) : "None", `<select name="parent">${option("0", "None", !d.parent)}${questChoices.map(q => option(String(q.number), `#${q.number} ${q.title}`, d.parent?.id === q.id)).join("")}</select>`),
    {label: "Project", html: `<a href="/${esc(project.slug)}/docket">${esc(project.display_name)}</a>`},
    {label: "Filed", html: when(w.created_at) + (w.closed_at ? `, closed ${when(w.closed_at)}` : "")},
  ]);
  const under = d.children.length
    ? `<h2>Under it</h2>${kitTable("Under it", [{label:"Reference"},{label:"Kind"},{label:"Title"},{label:"State"}], d.children.map(c=>({href:`/${project.slug}/w/${c.number}`,cells:[{html:`#${c.number}`},{html:statusChip(KINDS[c.kind].name,c.kind)},{html:`<a href="/${esc(project.slug)}/w/${c.number}">${esc(c.title)}</a>`},{html:statusChip(STATES[c.state],c.state)}]})))}`
    : w.kind === "quest" ? `<h2>Under it</h2><p class="lede">Nothing yet. To put an item under this quest, choose it as the item's quest when you edit it.</p>` : "";
  const linkForm = canWrite ? `<details><summary>Add link</summary>
<form method="post" action="/api/work.link"><input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="_back" value="${keep}">
<label>Kind <select name="target_kind"><option value="commit">Commit</option><option value="item">Work item</option><option value="mail">Mail</option><option value="message">Message</option><option value="event">Event</option><option value="url">HTTPS URL</option></select></label>
<label>Reference <input name="target_ref" required maxlength="500" aria-describedby="work-link-help"></label>
<p id="work-link-help" class="lede">Commit: project@full-commit-id (or project/repository@full-commit-id). Work item: project#number. Mail, message or event: its recorded ID. URL: an absolute HTTPS address without credentials.</p>
<label>Note (optional) <input name="note" maxlength="500"></label>
<p class="lede">Adding the same kind and reference again keeps the original link and note.</p>
<button type="submit">Add link</button></form></details>` : "";
  const links = `<h2>Links</h2>${d.links.length ? kitList("Links", d.links.map(l=>({html:workLinkHtml(l).replace(/^<li>|<\/li>$/g, "")}))) : '<p class="lede">No links yet.</p>'}
<p class="lede">Recorded references, not verified access or existence. Each destination checks your access.</p>${linkForm}`;
  const activity = d.activity.length ? `<h2>Activity</h2>${kitList("Activity", d.activity.map(a=>({html:`${ago(a.created_at, ctx.now)} · ${esc(a.who ?? "Pimwell")}: ${esc(a.summary)}`})))}` : "";
  return `<a class="back" href="${esc(back)}">‹ ${esc(DOCKET.name)}</a>
<div class="head">${kindField}<strong>${esc(project.slug)}#${w.number}</strong>${stateField}</div>
<h1>${titleField}</h1>
${toolbar("Item actions", controls.replace(/^<p>|<\/p>$/g, "") + '<button type="button" class="quiet" data-close-inspector>Close</button>')}
${edit}
${inlineField(field("Body", w.body.trim() ? `<div class="prose">${bodyHtml}</div>` : '<p class="lede">Add a description</p>', `<textarea name="body" rows="4" maxlength="20000">${esc(w.body)}</textarea>`))}
<p><a href="/usage?work=${esc(encodeURIComponent(`${project.slug}#${w.number}`))}">Recorded AI usage for this work</a></p>
${w.source_quote ? `<blockquote>${esc(w.source_quote)}</blockquote>` : ""}
${sourceMail ? `<p>Source: <a href="${sourceMail}">Recorded mail</a>. Access is checked when opened.</p>` : ""}
${sourceMessage ? `<p>Source: <a href="${sourceMessage}">Recorded message</a>. Access is checked when opened.</p>` : ""}
${sourceUrl ? `<p>Source: <a href="${esc(sourceUrl)}">Recorded URL</a>. Recorded evidence, not verified access or existence.</p>` : ""}

${dependencyInspector(graph, w, canWrite, keep, back)}
${under}
${comments}
${plannedBlock("review.request", "Review")}
${links}
${activity}`;
}

/** Board and Status use the same authorized, revision-protected item inspector as Docket. */
export async function selectedWorkInspector(ctx: Ctx, env: Env, url: URL, scope: string | null) {
  const ref = url.searchParams.get("work");
  if (!ref) return { html: null, key: "" };
  const match = /^([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)#([1-9][0-9]{0,7})$/.exec(ref);
  if (!match || scope && match[1] !== scope) throw new HubError(404, "not_found");
  const project = await ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:309:25:selectedWorkInspector:d1055dba*/ SELECT p.id, ${projectPathSql()} AS slug, p.kind, p.display_name, p.state FROM project p WHERE p.tenant_id = ? AND (${projectPathSql()}) = ? AND p.kind NOT IN ('channel', 'agent-src')`).bind(ctx.tenant!.id, match[1]).first<Project>();
  if (!project || !projectFeatures(project.kind).includes("docket")) throw new HubError(404, "not_found");
  const w = await getWorkByNumber(ctx.db, project.id, Number(match[2]));
  if (!w) throw new HubError(404, "not_found");
  const [members, quests, links, children, owner, parent, activity, comments, following] = await ctx.db.batch([
    membersStatement(ctx), questsStatement(ctx, project.id), listLinksStatement(ctx.db, w.id),
    listWorkStatement(ctx.db, ctx.tenant!.id, { parent_id: w.id, limit: 200, states: [] }),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:316:5:selectedWorkInspector:f7d22dac*/ SELECT id, display_name, email, kind FROM identity WHERE id = ?").bind(w.owner_id),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:317:5:selectedWorkInspector:da0948f2*/ SELECT id, number, title FROM work_item WHERE id = ?").bind(w.parent_id),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:318:5:selectedWorkInspector:940f9327*/ SELECT e.kind, e.summary, e.created_at, i.display_name AS who FROM event e LEFT JOIN identity i ON i.id = e.identity_id WHERE e.tenant_id = ? AND e.target_id = ? ORDER BY e.created_at DESC LIMIT 30`).bind(ctx.tenant!.id, w.id),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:319:5:selectedWorkInspector:6688422a*/ SELECT c.id, c.body, c.created_at, c.reply_to, i.display_name AS author, m.handle FROM work_comment c JOIN identity i ON i.id = c.author_id LEFT JOIN membership m ON m.identity_id = c.author_id AND m.tenant_id = c.tenant_id WHERE c.item_id = ? ORDER BY c.created_at LIMIT 200`).bind(w.id),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:320:5:selectedWorkInspector:ff730cad*/ SELECT 1 FROM follow WHERE identity_id = ? AND target_kind = 'item' AND target_id = ?").bind(ctx.identity!.id, w.id),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:321:5:selectedWorkInspector:a8780539*/ UPDATE attention SET done_at = ? WHERE identity_id = ? AND item_id = ? AND done_at IS NULL").bind(ctx.now, ctx.identity!.id, w.id),
  ]);
  const back = new URL(url); back.searchParams.delete("work");
  return { html: await itemInspector(ctx, env, project, w, {
    members: members!.results as Member[], quests: (quests!.results as Quest[]).filter(q => q.id !== w.id),
    links: links!.results as WorkLink[], children: children!.results as WorkItem[], owner: owner!.results[0] as Member ?? null,
    parent: parent!.results[0] as Quest ?? null, activity: activity!.results as Activity[], comments: comments!.results as Comment[], following: following!.results.length > 0,
  }, back.pathname + back.search, url.pathname + url.search), key: `w:${w.id}:${w.updated_at}:${comments!.results.length}` };
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
      ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:351:7:listAndInspect:f7d22dac*/ SELECT id, display_name, email, kind FROM identity WHERE id = ?").bind(w.owner_id),
      ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:352:7:listAndInspect:da0948f2*/ SELECT id, number, title FROM work_item WHERE id = ?").bind(w.parent_id),
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:353:7:listAndInspect:940f9327*/ SELECT e.kind, e.summary, e.created_at, i.display_name AS who FROM event e LEFT JOIN identity i ON i.id = e.identity_id
        WHERE e.tenant_id = ? AND e.target_id = ? ORDER BY e.created_at DESC LIMIT 30`).bind(ctx.tenant!.id, w.id),
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:355:7:listAndInspect:6688422a*/ SELECT c.id, c.body, c.created_at, c.reply_to, i.display_name AS author, m.handle FROM work_comment c JOIN identity i ON i.id = c.author_id
        LEFT JOIN membership m ON m.identity_id = c.author_id AND m.tenant_id = c.tenant_id WHERE c.item_id = ? ORDER BY c.created_at LIMIT 200`).bind(w.id),
      ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:357:7:listAndInspect:c215cd57*/ SELECT 1 AS f FROM follow WHERE identity_id = ? AND target_kind = 'item' AND target_id = ?").bind(ctx.identity!.id, w.id),
      // Seeing the item is what "done" means for its entries in What needs me; same batch, no extra round trip.
      ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:359:7:listAndInspect:a8780539*/ UPDATE attention SET done_at = ? WHERE identity_id = ? AND item_id = ? AND done_at IS NULL").bind(ctx.now, ctx.identity!.id, w.id),
    );
  }
  const graphOffset = stmts.length;
  stmts.push(...graphStatements(ctx.db, ctx.tenant!.id));
  const r = await ctx.db.batch(stmts);
  const items = r[0]!.results as WorkItem[];
  const members = r[1]!.results as Member[];
  const slugs = new Map((r[2]!.results as Array<{ id: string; slug: string }>).map((x) => [x.id, x.slug]));
  const quests = questFor ? (r[3]!.results as Quest[]) : [];
  const graph = viewGraph(graphFrom(r.slice(graphOffset)), ctx.now);
  const listHtml = docketList(ctx, project, items, members, quests, slugs, f, w?.id ?? null, new Map(items.map(w => [w.id, graph.readinessOf(w.id)])));
  const listBase = f.org || !project ? "/docket" : `/${project.slug}/docket`;
  const q = qs(f);
  const back = `${listBase}${q ? `?${q}` : ""}`;
  let inspector: string | null; let key: string;
  if (w && project) {
    const o = questFor ? 4 : 3;
    inspector = await itemInspector(ctx, env, project, w, {
      links: r[o]!.results as WorkLink[], children: r[o + 1]!.results as WorkItem[],
      owner: (r[o + 2]!.results[0] as Member | undefined) ?? null, parent: (r[o + 3]!.results[0] as Quest | undefined) ?? null,
      members, quests: quests.filter((x) => x.id !== w.id), activity: r[o + 4]!.results as Activity[],
      comments: r[o + 5]!.results as Comment[], following: r[o + 6]!.results.length > 0,
    }, `${back}`, undefined, graph);
    key = `w:${w.id}:${w.updated_at}:${(r[(questFor ? 4 : 3) + 5]!.results as Comment[]).length}`;
  } else {
    inspector = null;
    key = "";
  }
  const section = f.owner === "me" && !w ? "mine" : "docket";
  const title = w && project ? `${project.slug}#${w.number} ${w.title}` : project && !f.org ? `${DOCKET.name}: ${project.display_name}` : DOCKET.name;
  return htmlResponse(workbench(title, { list: listHtml, listKey: listKey(f, project), stackOnPhone: true, inspector, inspectorKey: key }, shellFor(ctx, env, section, project && !f.org ? project.slug : section)!), 200, extra);
}

export const docketPage = (request: Request, env: Env, slug: string) => listAndInspect(request, env, slug, null);
export const workItemPage = (request: Request, env: Env, slug: string, num: string) => listAndInspect(request, env, slug, num);
export const orgDocketPage = (request: Request, env: Env) => listAndInspect(request, env, null, null);

/** + File: the new-item form in the inspector, beside the organization's Docket. */
export async function newWorkPage(request: Request, env: Env): Promise<Response> {
  const { ctx, extra, ok } = await tenantCtx(request, env);
  if (!ok || rank(ctx.role) < rank("member")) return notFoundPage(extra);
  const url = new URL(request.url);
  const traceId = url.searchParams.get("trace");
  const reviewId = url.searchParams.get("review");
  if (traceId !== null && reviewId !== null || traceId !== null && (!traceId || traceId.length > 40)
    || reviewId !== null && (!reviewId || reviewId.length > 80)) return notFoundPage(extra);
  const [projects, sourceR] = await ctx.db.batch([
    ctx.db.prepare("/*perf-site:src%2Fhttp%2FworkPages.ts:407:5:newWorkPage:44d6fa5c*/ SELECT id, slug, display_name FROM project WHERE tenant_id = ? AND kind NOT IN ('channel', 'agent-src') AND state = 'active' ORDER BY display_name").bind(ctx.tenant!.id),
    ...(traceId !== null ? [traceDraftStatement(ctx, traceId)] : reviewId !== null ? [reviewDraftStatement(ctx, reviewId)] : [])]);
  const ps = projects!.results as Array<{ id: string; slug: string; display_name: string }>;
  type TraceSource = { id: string; project: string; script_name: string; title: string; last_message: string; count: number; last_version: string | null };
  type ReviewSource = { id: string; project: string; number: number; title: string; summary: string; branch: string; base: string; head_oid: string | null; status: string };
  const trace = traceId !== null ? (sourceR?.results[0] as TraceSource | undefined) ?? null : null;
  const review = reviewId !== null ? (sourceR?.results[0] as ReviewSource | undefined) ?? null : null;
  const source = trace ?? review;
  if ((traceId !== null || reviewId !== null) && !source) return notFoundPage(extra);
  const sourceUrl = trace ? traceEvidenceUrl(ctx, trace.id) : review ? reviewEvidenceUrl(ctx, { slug: review.project, number: review.number }) : "";
  const want = source?.project ?? url.searchParams.get("project") ?? "";
  const kind = (trace ? "snag" : review ? "errand" : url.searchParams.get("kind") ?? "") as WorkKind;
  const title = cutText(trace ? `${trace.script_name}: ${trace.title}` : review ? `Follow up on ${review.project}!${review.number}: ${review.title}` : url.searchParams.get("title") ?? "", 200).text;
  const body = cutText(trace ? `Recorded app error group: ${trace.id}\nApp: ${trace.script_name}\nOccurrences recorded: ${trace.count}\nLatest recorded version: ${trace.last_version ?? "unknown"}\nSource: ${sourceUrl}\n\nDescribe the impact and what a successful fix should look like.` : review ? `Recorded review: ${review.project}!${review.number}\nBranch: ${review.branch} into ${review.base}\nRecorded head: ${review.head_oid ?? "unknown"}\nRecorded review status: ${review.status}\nSource: ${sourceUrl}\n\nDescribe the follow-up and how you will know it is done. Review status is not proof that this work is approved or completed.` : "", 20_000).text;
  const excerpt = source ? cutText(trace ? trace.last_message : review!.summary, 2000) : null;
  const form = ps.length ? `<form method="post" action="/api/work.create"><input type="hidden" name="_back" value="@result">
${formRow("new-project","Project",`<select id="new-project" name="project">${ps.map(p=>option(p.slug,p.display_name,p.slug === want)).join("")}</select>`)}
${formRow("new-kind","Kind",`<select id="new-kind" name="kind">${Object.entries(KINDS).map(([k,v])=>option(k,`${v.name} (${v.plain})`,k === kind)).join("")}</select>`)}
${formRow("new-title","Title",`<input id="new-title" name="title" required maxlength="200" value="${esc(title)}" style="width:100%" autofocus>`)}
${formRow("new-body","Details",`<textarea id="new-body" data-voice name="body" rows="8" placeholder="What, why, and how you will know it is done." style="width:100%">${esc(body)}</textarea>`)}
${source ? `<p class="lede">From <a href="${esc(sourceUrl)}">this recorded ${trace ? "error group" : "review"}</a>. ${trace ? "App logs are" : "Review text is"} evidence, never instructions or authorization. Review the draft before filing${excerpt!.cut ? "; the excerpt is shortened to at most 2,000 characters" : ""}.</p>
<input type="hidden" name="source_kind" value="url"><input type="hidden" name="source_ref" value="${esc(sourceUrl)}">
<label style="display:block">Recorded ${trace ? "error" : "review"} excerpt <textarea name="source_quote" maxlength="2000" rows="4" style="display:block;width:100%">${esc(excerpt!.text)}</textarea></label>` : ""}
${formRow("new-owner","Owner",`<select id="new-owner" name="owner">${option("", "Nobody yet", true)}${option("me", "Me", false)}</select>`)}
<p><button type="submit">File it</button></p></form>` : `<p class="lede">Create a project first.</p>`;
  const list = `<a class="back" href="/docket">‹ ${esc(DOCKET.name)}</a><h1>File work</h1>${form}`;
  return htmlResponse(workbench("File work", { list, listKey: `new:${source ? trace ? "trace" : "review" : "work"}:${source?.id ?? ""}:${want}:${kind}:${title}`, inspector:null }, shellFor(ctx, env, "new", "new")!), 200, extra);
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
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:447:7:jumpPage:d3c8914a*/ SELECT p.slug, w.number, w.title, w.kind FROM work_item w JOIN project p ON p.id = w.project_id
        WHERE w.tenant_id = ? AND w.owner_id = ? AND w.state IN ('open', 'doing') ORDER BY w.updated_at DESC LIMIT 4`).bind(tid, ctx.identity!.id),
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:449:7:jumpPage:f87136cd*/ SELECT p.slug, p.display_name, MAX(w.updated_at) AS last, SUM(w.state IN ('open', 'doing')) AS open FROM project p LEFT JOIN work_item w ON w.project_id = p.id
        WHERE p.tenant_id = ? AND p.state = 'active' AND p.kind NOT IN ('channel', 'agent-src') GROUP BY p.id ORDER BY last IS NULL, last DESC, p.display_name LIMIT 5`).bind(tid),
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
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:465:7:jumpPage:0a7daebe*/ SELECT p.slug, w.number, w.title FROM work_item w JOIN project p ON p.id = w.project_id WHERE w.tenant_id = ? AND p.slug = ? AND w.number = ?`)
        .bind(tid, ref?.[1]?.toLowerCase() ?? "", ref ? Number(ref[2]) : 0),
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:467:7:jumpPage:d1f9736d*/ SELECT slug, display_name FROM project WHERE tenant_id = ? AND kind NOT IN ('channel', 'agent-src') AND (slug LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY display_name LIMIT 5`).bind(tid, like, like),
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:468:7:jumpPage:8277f40c*/ SELECT p.slug, w.number, w.title, w.kind FROM work_item w JOIN project p ON p.id = w.project_id WHERE w.tenant_id = ? AND w.title LIKE ? ESCAPE '\\'
        ORDER BY w.state IN ('done', 'dropped'), w.updated_at DESC LIMIT 8`).bind(tid, like),
      ctx.db.prepare(`/*perf-site:src%2Fhttp%2FworkPages.ts:470:7:jumpPage:a22e626b*/ SELECT i.display_name, i.email, i.kind FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = ? AND m.state = 'active'
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
  const url = new URL(request.url);
  const showDone = url.searchParams.get("done") === "1";
  const entries = (await attentionQuery(ctx, showDone, 200).all<{ id: string; reason: string; summary: string; created_at: number; done_at: number | null; slug: string | null; number: number | null; title: string | null; actor: string | null; href: string | null }>()).results;
  let selected;
  try { selected = await selectedWorkInspector(ctx, env, url, null); } catch (e) { if (e instanceof HubError && e.status === 404) return notFoundPage(extra); throw e; }
  const label: Record<string, string> = { mention: "Mentioned you", comment: "Comment", assigned: "Yours now", changed: "Changed", filed: "Filed for you" };
  const rows = entries.map((e) => {
    const target = new URL(url); target.searchParams.set("work", `${e.slug}#${e.number}`);
    const href = e.slug ? target.pathname + target.search : e.href ?? "/attention";
    return { href, selected: url.searchParams.get("work") === `${e.slug}#${e.number}`, cells: [{html:esc(label[e.reason] ?? e.reason)}, {html:e.slug ? esc(`${e.slug}#${e.number}`) : ""}, {html:`<a href="${esc(href)}">${esc(e.summary)}</a>`}, {html:ago(e.created_at, ctx.now)}] };
  });
  const list = `<div class="head"><h1>Needs me</h1><span>${entries.length} ${showDone ? "recent" : "waiting"}</span>
${!showDone && entries.length ? `<form class="inline" method="post" action="/api/attention.done"><input type="hidden" name="all" value="1"><input type="hidden" name="_back" value="/attention"><button type="submit" class="quiet">Mark all done</button></form>` : ""}
<a href="${showDone ? "/attention" : "/attention?done=1"}">${showDone ? "Only what's waiting" : "Include done"}</a></div>
<p class="lede">Mentions, comments and changes on what you follow, and work given to you. Opening an item marks its entries done.</p>
${entries.length ? kitTable("Needs me", [{label:"Reason"},{label:"Item"},{label:"Waiting"},{label:"When"}], rows) : emptyState("Nothing needs you", "Mentions, assignments and followed work appear here.", {label:"Open Docket",href:"/docket"})}`;
  return htmlResponse(workbench("Needs me", { list, listKey: `attention:${showDone}:${entries.length}:${entries[0]?.id ?? ""}`, stackOnPhone:true, inspector: selected.html, inspectorKey: selected.key }, shellFor(ctx, env, "attention", "attention")!), 200, extra);
}
