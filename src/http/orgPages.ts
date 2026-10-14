import { projectControls } from "./projectControls";
import { PROJECT_KINDS, projectFeatures } from "../projectFeatures";
import type { Env } from "../env";
import { localTime, naturalName, plural, COPY_SCRIPT, esc, htmlResponse, inspectorSection, kitTable, page, toolbar, workbench } from "../html";
import { buildContext, rank, type Ctx } from "../auth/context";
import { readableMailEvents } from "../auth/mailAccess";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { KINDS, type WorkKind } from "../work/names";
import { projectPathSql } from "../db/projects";
import { HubError } from "../errors";
import { selectedWorkInspector } from "./workPages";

const ago = (_now: number, t: number | null) => localTime(t);

async function orgCtx(request: Request, env: Env): Promise<{ ctx: Ctx; extra: Record<string, string> } | Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  return { ctx, extra };
}

type Project = { id: string; slug: string; namespace: string | null; display_name: string; kind: string; state: string; path: string };
type Resource = { key: string; label: string; href: string; n: number; at: number | null };
type Entry = { id: string; summary: string; created_at: number; slug: string | null; number: number | null; href: string | null };

export async function orgHomePage(request: Request, env: Env): Promise<Response> {
  const oc = await orgCtx(request, env);
  if (oc instanceof Response) return oc;
  const { ctx, extra } = oc;
  const t = ctx.tenant!, eventAccess = readableMailEvents(ctx);
  const [projects, needs] = await ctx.db.batch([
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2ForgPages.ts:34:5:%5Bprojects%2C%20needs%5D:f961f8e2*/ SELECT p.*, ${projectPathSql()} AS path, (SELECT slug FROM namespace WHERE id = p.namespace_id AND tenant_id = p.tenant_id) AS namespace,
      (SELECT COUNT(*) FROM work_item w WHERE w.project_id = p.id AND w.state IN ('open','doing')) AS open_work,
      (SELECT COUNT(*) FROM attention a LEFT JOIN work_item w ON w.id = a.item_id WHERE a.tenant_id = p.tenant_id AND a.identity_id = ? AND a.done_at IS NULL AND (w.project_id = p.id OR (a.item_id IS NULL AND a.href LIKE '/' || (${projectPathSql()}) || '/reviews/%'))) AS needs,
      MAX(p.created_at, COALESCE((SELECT MAX(w.updated_at) FROM work_item w WHERE w.project_id = p.id),0),
        COALESCE((SELECT MAX(e.created_at) FROM event e WHERE e.tenant_id = p.tenant_id AND ((e.target_kind = 'project' AND e.target_id = p.id) OR (e.target_kind = 'inbound_mail' AND e.target_id IN (SELECT id FROM inbound_mail WHERE tenant_id = p.tenant_id AND project_id = p.id)) OR (e.target_kind = 'outbound_mail' AND e.target_id IN (SELECT o.id FROM outbound_mail o JOIN inbound_mail m ON m.id = o.in_reply_to AND m.tenant_id = o.tenant_id WHERE o.tenant_id = p.tenant_id AND m.project_id = p.id))) AND ${eventAccess.sql}),0),
        COALESCE((SELECT MAX(created_at) FROM wiki_revision WHERE project_id = p.id),0),
        COALESCE((SELECT MAX(created_at) FROM file_revision WHERE project_id = p.id),0),
        COALESCE((SELECT MAX(updated_at) FROM contact_entity WHERE project_id = p.id),0),
        COALESCE((SELECT MAX(updated_at) FROM review WHERE project_id = p.id),0),
        COALESCE((SELECT MAX(seen_at) FROM app_deploy WHERE project_id = p.id),0),
        COALESCE((SELECT MAX(last_seen) FROM app_error_group WHERE project_id = p.id),0),
        COALESCE((SELECT MAX(mi.created_at) FROM msg_index mi JOIN channel c ON c.project_id = mi.conversation_id AND c.tenant_id = mi.tenant_id JOIN meta owner ON owner.key = 'project_channel:v1:' || c.tenant_id || ':' || c.project_id AND owner.value = p.id WHERE mi.tenant_id = p.tenant_id ${ctx.identity!.kind === "human" ? "" : "AND EXISTS (SELECT 1 FROM conversation_member cm WHERE cm.tenant_id = mi.tenant_id AND cm.conversation_id = mi.conversation_id AND cm.identity_id = ? AND cm.removed_at IS NULL)"}),0)) AS last_activity
      FROM project p WHERE p.tenant_id = ? AND p.state = 'active' AND p.kind NOT IN ('channel','agent-src') ORDER BY path`).bind(ctx.identity!.id, ...eventAccess.bindings, ...(ctx.identity!.kind === "human" ? [] : [ctx.identity!.id]), t.id),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2ForgPages.ts:47:5:%5Bprojects%2C%20needs%5D:15854749*/ SELECT a.id, a.summary, a.created_at, ${projectPathSql()} AS slug, w.number, a.href FROM attention a LEFT JOIN work_item w ON w.id = a.item_id LEFT JOIN project p ON p.id = w.project_id AND p.tenant_id = a.tenant_id WHERE a.tenant_id = ? AND a.identity_id = ? AND a.done_at IS NULL ORDER BY a.created_at DESC LIMIT 6`).bind(t.id,ctx.identity!.id),
  ]);
  const rows = (projects!.results as Array<Project & { open_work: number; needs: number; last_activity: number }>).sort((a,b)=>naturalName(a.display_name,b.display_name));
  const entries = needs!.results as Entry[];
  const url = new URL(request.url);
  const selected = url.searchParams.get("project");
  if (selected !== null && url.searchParams.has("work")) return notFoundPage(extra);
  const work = await selectedWorkInspector(ctx,env,url,null).catch(error => {
    if (error instanceof HubError && error.status === 404) return null;
    throw error;
  });
  if (!work) return notFoundPage(extra);
  const chosen = selected === null ? null : rows.find(p => p.path === selected);
  if (selected !== null && !chosen) return notFoundPage(extra);
  const actions = `${rank(ctx.role) >= rank("member") ? '<a href="/projects/new">New project</a><a href="/people?connect=1">Connect an agent</a>' : ""}${rank(ctx.role) >= rank("admin") ? '<a href="/people?invite=1">Invite a person</a>' : ""}${rank(ctx.role) >= rank("member") ? '<a href="/new">File</a>' : ""}<a href="/archive">Archive</a>`;
  const list = `<div class="head"><h1>${esc(t.display_name)}</h1><span>${plural(rows.length,"project")}</span></div>${toolbar("Home actions", actions)}<p class="wb-hint">${esc(shellFor(ctx,env,"home")!.tip)}</p>
<h2>Projects</h2>${kitTable("Projects", [{label:"Project"},{label:"Kind"},{label:"Open work"},{label:"Needs me"},{label:"Last activity"}], rows.map(p => {
    const href = `/?project=${encodeURIComponent(p.path)}`;
    return {href, selected: p.path === selected, cells: [{html:`<a href="${esc(href)}">${esc(p.display_name)}</a> <small>${esc(p.path)}</small>`},{html:esc(p.kind)},{html:String(p.open_work)},{html:String(p.needs)},{html:ago(ctx.now,p.last_activity)}]};
  }))}
<h2><a href="/attention">Needs me</a></h2>${entries.length ? kitTable("Needs me",[{label:"Waiting"},{label:"When"}],entries.slice(0,5).map(e => ({href:e.slug ? `/?work=${encodeURIComponent(`${e.slug}#${e.number}`)}` : e.href ?? "/attention",cells:[{html:`<a href="${esc(e.slug ? `/?work=${encodeURIComponent(`${e.slug}#${e.number}`)}` : e.href ?? "/attention")}">${esc(e.summary)}</a>`},{html:ago(ctx.now,e.created_at)}]}))) : '<p class="empty">Nothing needs you right now.</p>'}${entries.length > 5 ? '<a href="/attention">All Needs me →</a>' : ""}`;
  const overview = chosen ? await projectOverview(ctx, env, chosen, null) : null;
  return htmlResponse(workbench(t.display_name, {list, listKey:`home:${rows.map(p => `${p.path}:${p.open_work}:${p.needs}:${p.last_activity}`).join(",")}:${entries.map(e => e.id).join(",")}`, inspector:overview ? `<a class="back" href="/">‹ Home</a>${overview.list}<p><a href="/${esc(chosen!.path)}">Open project workspace →</a></p>` : work.html, inspectorKey:chosen ? `home:${chosen.path}` : work.key}, shellFor(ctx,env,"home",t.slug)!),200,extra);
}

export async function newProjectPage(request: Request, env: Env): Promise<Response> {
  const oc = await orgCtx(request, env);
  if (oc instanceof Response) return oc;
  const { ctx, extra } = oc;
  if (rank(ctx.role) < rank("member")) return notFoundPage(extra);
  return htmlResponse(page("New project", `<h1>New project</h1>
<form method="post" action="/api/project.create"><input type="hidden" name="_back" value="@result">
<label>Name <input name="display_name" required maxlength="80"></label>
<label>Slug <input name="slug" required maxlength="63" pattern="[a-z0-9-]+"></label>
<label>Kind <select name="kind">${PROJECT_KINDS.map((k) => `<option value="${k}">${k}</option>`).join("")}</select></label>
<button>Create project</button></form>`, shellFor(ctx, env, "home")), 200, extra);
}

async function projectOverview(ctx: Ctx, env: Env, p: Project, selected: string | null) {
  const features = projectFeatures(p.kind), base = `/${p.path}`, t = ctx.tenant!;
  // Current revisions, not history, count as resources. Channel ownership is the existing metadata link.
  const [work, wiki, files, contacts, reviews, channels, errors, deploy] = await ctx.db.batch([
    ctx.db.prepare("/*perf-site:src%2Fhttp%2ForgPages.ts:89:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:feaabfb7*/ SELECT kind, COUNT(*) AS n, MAX(updated_at) AS at FROM work_item WHERE project_id = ? AND state IN ('open','doing') GROUP BY kind").bind(p.id),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2ForgPages.ts:90:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:e9c7fb8f*/ SELECT CASE WHEN research IS NULL THEN 'wiki' ELSE 'research' END AS kind, SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS n, MAX(created_at) AS at FROM wiki_revision r WHERE tenant_id = ? AND project_id = ? AND revision = (SELECT MAX(revision) FROM wiki_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.slug = r.slug) GROUP BY kind`).bind(t.id,p.id),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2ForgPages.ts:91:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:6416336b*/ SELECT COALESCE(SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END),0) AS n, MAX(created_at) AS at FROM file_revision r WHERE tenant_id = ? AND project_id = ? AND revision = (SELECT MAX(revision) FROM file_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.path = r.path)`).bind(t.id,p.id),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2ForgPages.ts:92:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:697f7b2d*/ SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM contact_entity WHERE tenant_id = ? AND project_id = ?").bind(t.id,p.id),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2ForgPages.ts:93:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:122e8163*/ SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM review WHERE tenant_id = ? AND project_id = ? AND status <> 'closed'").bind(t.id,p.id),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2ForgPages.ts:94:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:f5a4e30b*/ SELECT cp.slug, cp.display_name, COALESCE((SELECT MAX(created_at) FROM msg_index WHERE tenant_id = cp.tenant_id AND conversation_id = cp.id),c.created_at) AS at FROM channel c JOIN project cp ON cp.id = c.project_id JOIN meta owner ON owner.key = 'project_channel:v1:' || cp.tenant_id || ':' || cp.id AND owner.value = ? WHERE cp.tenant_id = ? AND cp.state = 'active' ${ctx.identity!.kind === "human" ? "" : "AND EXISTS (SELECT 1 FROM conversation_member cm WHERE cm.tenant_id = cp.tenant_id AND cm.conversation_id = cp.id AND cm.identity_id = ? AND cm.removed_at IS NULL)"} ORDER BY cp.slug`).bind(p.id,t.id,...(ctx.identity!.kind === "human" ? [] : [ctx.identity!.id])),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2ForgPages.ts:95:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:b358fb06*/ SELECT COUNT(*) AS n, MAX(last_seen) AS at FROM app_error_group WHERE tenant_id = ? AND project_id = ?").bind(t.id,p.id),
    ctx.db.prepare("/*perf-site:src%2Fhttp%2ForgPages.ts:96:5:%5Bwork%2C%20wiki%2C%20files%2C%20contacts%2C%20reviews%2C%20channels%2C%20errors%2C%20deploy%5D:9e6e8f51*/ SELECT id, COALESCE(tag,version_id) AS version, seen_at AS at FROM app_deploy WHERE tenant_id = ? AND project_id = ? ORDER BY seen_at DESC LIMIT 1").bind(t.id,p.id),
  ]);
  const resources: Resource[] = [];
  const add = (key: string, label: string, href: string, result: D1Result | undefined, kind?: string) => {
    const rows = result!.results as Array<{kind?: string; n: number; at: number | null}>;
    const r = kind ? rows.find(r => r.kind === kind) : rows[0];
    resources.push({key,label,href,n:r?.n ?? 0,at:r?.at ?? null});
  };
  if (features.includes("docket")) for (const k of Object.keys(KINDS) as WorkKind[]) add(k, `Open ${KINDS[k].plural}`, `${base}/docket?kind=${k}`,work,k);
  if (features.includes("repo")) add("reviews","Open reviews",`${base}/reviews`,reviews);
  if (features.includes("wiki")) add("wiki","Wiki pages",`${base}/wiki`,wiki,"wiki");
  if (features.includes("knowledge")) add("research","Research",`${base}/wiki`,wiki,"research");
  if (features.includes("files")) add("files","Files",`${base}/documents`,files);
  if (features.includes("people")) add("contacts","Contacts",`${base}/contacts`,contacts);
  const channelRows = channels!.results as Array<{slug: string; display_name: string; at: number}>;
  resources.push({key:"channels",label:"Channels",href:"/c",n:channelRows.length,at:channelRows.length ? Math.max(...channelRows.map(c=>c.at)) : null});
  add("errors","App errors","/apps",errors);
  const last = deploy!.results[0] as {id: string; version: string; at: number} | undefined;
  resources.push({key:"deploy",label:"Last deploy",href:last ? `/apps?project=${encodeURIComponent(p.path)}&d=${encodeURIComponent(last.id)}` : `/apps?project=${encodeURIComponent(p.path)}`,n:last ? 1 : 0,at:last?.at ?? null});
  const writable = p.state === "active" && rank(ctx.role) >= rank("member");
  const select = (key: string) => `${base}?resource=${encodeURIComponent(key)}`;
  const actions = `${features.includes("repo") ? `<a href="${esc(base)}/code">Code</a>` : ""}${writable && features.includes("docket") ? `<a class="primary" href="/new?project=${esc(encodeURIComponent(p.path))}">File</a>` : ""}${writable && features.includes("wiki") ? `<a href="${esc(select("new-page"))}">New page</a>` : ""}${writable && features.includes("files") ? `<a href="${esc(select("upload"))}">Upload</a>` : ""}${writable && features.includes("people") ? `<a href="${esc(select("add-contact"))}">Add contact</a>` : ""}${writable && features.includes("wiki") ? `<a href="${esc(select("share"))}">Share</a>` : ""}<a href="/usage?project=${esc(encodeURIComponent(p.path))}">AI usage</a>${writable && rank(ctx.role) >= rank("admin") && ctx.identity!.kind === "human" ? projectControls(p,false) : ""}`;
  const list = `<div class="overview"><div class="head"><h1>${esc(p.display_name)}</h1>${p.state === "archived" ? '<span>Archived</span>' : ""}</div>
${toolbar("Project actions",actions)}
${kitTable("Project contents",[{label:"Resource"},{label:"Count"},{label:"Latest activity"}],resources.map(r=>({href:select(r.key),selected:selected === r.key,cells:[{html:`<a href="${esc(select(r.key))}">${esc(r.label)}</a>`},{html:r.key === "deploy" && last ? `<code title="${esc(last.version)}">${esc(last.version.slice(0,12))}</code>` : String(r.n)},{html:ago(ctx.now,r.at)}]})))}
${inspectorSection("Identity",[{label:"Kind",html:esc(p.kind)},{label:"Mail",html:`<code>${esc(t.slug)}.${esc(p.path.replace("/", "."))}@${esc(env.HUB_DOMAIN)}</code>`},{label:"MCP",html:`<code id="project-mcp-url">https://${esc(t.slug)}.${esc(env.HUB_DOMAIN)}/p/${esc(p.path)}/mcp</code> <button type="button" class="quiet" aria-label="Copy MCP URL" title="Copy MCP URL" data-copy="#project-mcp-url">⧉</button>`}, ...(features.includes("repo") ? [{label:"Clone",html:`<code>git clone https://${esc(t.slug)}.${esc(env.HUB_DOMAIN)}/${esc(p.path)}.git</code>`}] : [])])}
</div>`;
  const resource = resources.find(r=>r.key === selected);
  const actionAllowed = writable && (selected === "new-page" && features.includes("wiki") || selected === "upload" && features.includes("files") || selected === "add-contact" && features.includes("people") || selected === "share" && features.includes("wiki"));
  if (selected !== null && !resource && !actionAllowed) return null;
  let inspector: string | null = null;
  if (selected !== null) {
    inspector = `<a class="back" href="${esc(base)}">‹ ${esc(p.display_name)}</a><h1>${esc(resource?.label ?? ({"new-page":"New page",upload:"Upload","add-contact":"Add contact",share:"Share"}[selected] ?? selected))}</h1>`;
    const hidden = `<input type="hidden" name="project" value="${esc(p.path)}"><input type="hidden" name="_back" value="@result">`;
    if (selected === "new-page") inspector += `<form method="post" action="/api/wiki.write">${hidden}<input type="hidden" name="expected_revision" value="0"><label>Slug <input name="slug" required maxlength="100" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label><label>Title <input name="title" required maxlength="200"></label><label>Markdown <textarea name="body" rows="8"></textarea></label><label>Revision note <input name="note" required maxlength="500"></label><button>Create page</button></form>`;
    else if (selected === "upload") inspector += `<form method="post" data-reload enctype="multipart/form-data" action="${esc(base)}/documents/upload"><label>File <input type="file" name="file" required></label><label>Folder/name (blank uses filename) <input name="path" maxlength="240"></label><button>Upload</button></form>`;
    else if (selected === "add-contact") inspector += `<form method="post" action="/api/person.upsert">${hidden}<label>Name <input name="name" required maxlength="200"></label><label>Notes <textarea name="notes" rows="6"></textarea></label><button>Create contact</button></form>`;
    else if (selected === "share") inspector += `<p>Select a document, then use its Share by mail action. Only workspace members can receive it.</p><p><a href="${esc(select("wiki"))}">Pages</a> · <a href="${esc(select("files"))}">Files</a></p>`;
    else inspector += await resourceInspector(ctx,p,selected,resource,channelRows,last);
  }
  return {list,inspector};
}

async function resourceInspector(ctx: Ctx, p: Project, key: string, resource: Resource | undefined, channels: Array<{slug: string; display_name: string; at: number}>, last: {id: string; version: string; at: number} | undefined) {
  const base = `/${p.path}`, tid = ctx.tenant!.id;
  let rows: Array<{title: string; href: string; at: number}> = [];
  if (key === "channels") rows = channels.map(c=>({title:c.display_name,href:`/c/${c.slug}`,at:c.at}));
  else if (key === "deploy") rows = last ? [{title:last.version,href:resource!.href,at:last.at}] : [];
  else {
    let sql: string, bindings: (string | number)[] = [tid,p.id];
    if (key in KINDS) { sql = "SELECT title, number AS ref, updated_at AS at FROM work_item WHERE tenant_id = ? AND project_id = ? AND state IN ('open','doing') AND kind = ? ORDER BY updated_at DESC LIMIT 21"; bindings.push(key); }
    else if (["wiki","research"].includes(key)) { sql = `SELECT title, slug AS ref, created_at AS at FROM wiki_revision r WHERE tenant_id = ? AND project_id = ? AND deleted = 0 AND revision = (SELECT MAX(revision) FROM wiki_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.slug = r.slug) ${key === "research" ? "AND research IS NOT NULL" : "AND research IS NULL"} ORDER BY created_at DESC LIMIT 21`; }
    else if (key === "files") sql = `SELECT path AS title, path AS ref, created_at AS at FROM file_revision r WHERE tenant_id = ? AND project_id = ? AND deleted = 0 AND revision = (SELECT MAX(revision) FROM file_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.path = r.path) ORDER BY created_at DESC LIMIT 21`;
    else if (key === "contacts") sql = "SELECT name AS title, id AS ref, updated_at AS at FROM contact_entity WHERE tenant_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 21";
    else if (key === "reviews") sql = "SELECT title, number AS ref, updated_at AS at FROM review WHERE tenant_id = ? AND project_id = ? AND status <> 'closed' ORDER BY updated_at DESC LIMIT 21";
    else sql = "SELECT title, id AS ref, last_seen AS at FROM app_error_group WHERE tenant_id = ? AND project_id = ? ORDER BY last_seen DESC LIMIT 21";
    const result = await ctx.db.prepare("/*perf-site:src%2Fhttp%2ForgPages.ts:152:26:result:c34d43fb*/ " + (sql)).bind(...bindings).all<{title: string; ref: string | number; at: number}>();
    rows = result.results.map(r=>({title:r.title,at:r.at,href:key in KINDS ? `${base}/w/${r.ref}` : ["wiki","research"].includes(key) ? `${base}/wiki/${encodeURIComponent(r.ref)}` : key === "files" ? `${base}/documents?path=${encodeURIComponent(r.ref)}` : key === "contacts" ? `${base}/contacts/${encodeURIComponent(r.ref)}` : key === "reviews" ? `${base}/reviews/${r.ref}` : `/apps?g=${encodeURIComponent(r.ref)}`}));
  }
  return `${rows.length ? kitTable("Resource entries",[{label:"Name"},{label:"Updated"}],rows.slice(0,20).map(r=>({href:r.href,cells:[{html:`<a href="${esc(r.href)}">${esc(r.title)}</a>`},{html:ago(ctx.now,r.at)}]}))) : '<p class="empty">Nothing here yet.</p>'}${resource ? `<p><a href="${esc(resource.href)}">Open ${esc(resource.label)} →</a>${rows.length > 20 ? " · First 20 shown" : ""}</p>` : ""}`;
}

export async function projectPage(request: Request, env: Env, slug: string): Promise<Response> {
  const oc = await orgCtx(request, env);
  if (oc instanceof Response) return oc;
  const {ctx,extra} = oc;
  const p = await ctx.db.prepare(`/*perf-site:src%2Fhttp%2ForgPages.ts:162:19:p:d40a3d5c*/ SELECT p.*, n.slug AS namespace, ${projectPathSql("p","n")} AS path FROM project p LEFT JOIN namespace n ON n.id = p.namespace_id AND n.tenant_id = p.tenant_id WHERE p.tenant_id = ? AND (${projectPathSql("p","n")}) = ? AND p.kind NOT IN ('channel','agent-src')`).bind(ctx.tenant!.id,slug).first<Project>();
  if (!p) return notFoundPage(extra);
  const selected = new URL(request.url).searchParams.get("resource");
  const overview = await projectOverview(ctx,env,p,selected);
  if (!overview) return notFoundPage(extra);
  return htmlResponse(workbench(p.display_name,{list:overview.list + COPY_SCRIPT,listKey:`overview:${p.path}`,inspector:overview.inspector,inspectorKey:selected ? `overview:${p.path}:${selected}` : ""},shellFor(ctx,env,"project",p.path)!),200,extra);
}
