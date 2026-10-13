// Apps in the workbench (migration 0013): the organization's apps and their error groups as the list, one group in the
// inspector; and, on the hub, root's list of registrations to approve.
import type { Env } from "../env";
import { localTime, plural, emptyState, esc, htmlResponse, inspectorSection, kitTable, page, toolbar, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { findSite, siteView } from "../verbs/sites";
import { appsStatement } from "../verbs/apps";
import { traceGroupStatement, traceWorkStatement, traceWorkResults, type TraceWorkItem } from "../apps/work";
import { KINDS, STATES } from "../work/names";
import { deployStatement, deploysStatement, deployView, deployListResults, deployWorkStatement, deployWorkResults, type DeployWorkItem, type DeployRow } from "../apps/deploy";
import { sha256Hex } from "../ids";
import { recordedWorkTable } from "./codeMarkup";

const ago = (ms: number | null, _now: number) => localTime(ms);

type App = { script_name: string; project: string; state: string; last_event_at: number | null; requests: number; errors: number; groups: number; last_deploy: string | null };
type Group = { id: string; project: string; script_name: string; kind: string; title: string; last_message: string; count: number; first_seen: number; last_seen: number; last_version: string | null; first_deploy: string | null; first_commit: string | null };

export async function appsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const params = new URL(request.url).searchParams;
  const project = params.get("project");
  let site = null;
  if (params.has("site")) {
    try { site = await findSite(ctx, params.get("site")!); } catch { return notFoundPage(extra); }
    if (project && project !== site.project) return notFoundPage(extra);
  }
  const siteInfo = site ? await siteView(ctx, site) : null;
  const siteScripts = new Set(siteInfo?.apps.map(a => a.script));
  const view = site ? params.get("view") ?? "performance" : null;
  const gid = params.get("g") ?? "";
  const did = params.get("d");
  if (did !== null && (!did || did.length > 40 || params.has("g"))) return notFoundPage(extra);
  const [appsR, groupsR, oneR, eventsR, deploysR, relatedR, allDeploysR, namesR, selectedDeployR] = await ctx.db.batch([
    appsStatement(ctx.db, ctx.tenant.id, ctx.now),
    ctx.db.prepare(`SELECT g.id, p.slug AS project, g.script_name, COALESCE(g.client_kind, g.kind) AS kind, g.title, g.last_message, g.count, g.first_seen, g.last_seen, g.last_version FROM app_error_group g JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id AND p.kind NOT IN ('channel', 'agent-src')
      WHERE g.tenant_id = ? AND g.last_seen >= ? AND (? IS NULL OR p.slug = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM site_app sa JOIN app_source a ON a.id = sa.app_id WHERE sa.site_id = ? AND a.tenant_id = g.tenant_id AND a.project_id = g.project_id AND a.script_name = g.script_name))
      ORDER BY g.last_seen DESC LIMIT 100`).bind(ctx.tenant.id, ctx.now - 7 * 86_400_000, project, project, site?.id ?? null, site?.id ?? null),
    traceGroupStatement(ctx, gid),
    ctx.db.prepare("SELECT e.at, e.method, e.path, e.status, e.ray FROM app_event e JOIN app_error_group g ON g.id = e.group_id AND g.tenant_id = e.tenant_id WHERE g.id = ? AND g.tenant_id = ? ORDER BY e.at DESC LIMIT 20").bind(gid, ctx.tenant.id),
    ctx.db.prepare("SELECT d.id, d.tag, d.version_id, d.message, d.seen_at FROM app_deploy d JOIN app_error_group g ON g.script_name = d.script_name AND g.tenant_id = d.tenant_id AND g.project_id = d.project_id WHERE g.id = ? AND g.tenant_id = ? ORDER BY d.seen_at DESC LIMIT 5").bind(gid, ctx.tenant.id),
    traceWorkStatement(ctx, gid),
    deploysStatement(ctx, project, site?.id ?? null),
    ctx.db.prepare(`SELECT
      (SELECT p.display_name FROM app_error_group g JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id WHERE g.id = ? AND g.tenant_id = ?) AS group_name,
      (SELECT p.display_name FROM app_deploy d JOIN project p ON p.id = d.project_id AND p.tenant_id = d.tenant_id WHERE d.id = ? AND d.tenant_id = ?) AS deploy_name`).bind(gid,ctx.tenant.id,did ?? "",ctx.tenant.id),
    ...(did !== null ? [deployStatement(ctx, did)] : []),
  ]);
  const names = namesR!.results[0] as {group_name:string|null;deploy_name:string|null};
  const apps = (appsR!.results as App[]).filter(a => (!project || a.project === project) && (!site || siteScripts.has(a.script_name)));
  const groups = groupsR!.results as Group[];
  const g = (oneR!.results[0] as Group | undefined) ?? null;
  if (gid && (!g || (site && (!siteScripts.has(g.script_name) || g.project !== site.project)))) return notFoundPage(extra);
  const origin = g?.first_deploy ? await deployStatement(ctx, g.first_deploy).first<DeployRow>() : null;
  const originView = origin ? deployView(origin) : null;
  const selected = (selectedDeployR?.results[0] as DeployRow | undefined) ?? null;
  if (did !== null && (!selected || (site && (!siteScripts.has(selected.script_name) || selected.project !== site.project)))) return notFoundPage(extra);
  const { deploys: recordedDeploys, coverage } = deployListResults(allDeploysR!.results as DeployRow[]);
  const deployHref = (id?: string) => { const q = new URLSearchParams(); if (project) q.set("project",project); if (site) { q.set("site", site.name); q.set("view", "deploys"); } if (id) q.set("d",id); return `/apps${q.size ? `?${q}` : ""}${id ? "" : "#deploys"}`; };
  const errorsHref = site ? `/apps?project=${encodeURIComponent(site.project)}&site=${encodeURIComponent(site.name)}&view=errors` : "/apps";
  const title = site ? view === "errors" ? "Errors" : view === "deploys" ? "Deploys" : "Performance" : project ? "Deploys" : "Apps";
  const deployOnly = site ? view === "deploys" : project !== null;
  const deployList = `<h2 id="deploys">Recorded deploys${project ? ` · ${esc(project)}` : ""}</h2><p class="lede">${coverage.shown} shown${coverage.truncated ? "; capped at 50, more omitted" : "; complete for recorded deploys in scope"}. Observed or reported metadata, not proof of live rollout.</p>
${recordedDeploys.length ? kitTable("Recorded deploys",[{label:"Project"},{label:"App"},{label:"Version"},{label:"Recorded"}],recordedDeploys.map(d=>({href:deployHref(d.id),selected:d.id === did,cells:[{html:esc(d.project)},{html:`<a href="${esc(deployHref(d.id))}">${esc(d.script_name)}</a>`},{html:`<code>${esc(d.tag ?? d.version_id)}</code>`},{html:ago(d.seen_at,ctx.now)}]}))) : emptyState("No deploy records", "Observed or reported deployments will appear here.", {label:"Apps",href:"/apps"})}`;
  let list = deployOnly ? `<div class="head"><h1>Deploys</h1>${project ? `<span>${esc(project)}</span>` : ""}</div>${toolbar("Deploy actions and filters", '<a href="/apps">Apps</a>', '<input data-filter aria-label="Filter the list" placeholder="Filter these (/)" size="16">')}${deployList}` : `<div class="head"><h1>Apps</h1><span>${apps.length} reporting</span></div>
<p class="lede">Errors grouped by cause, deploys, and AI usage from the apps that report here. To add one, ask your agent to set up Pimwell (the onboard skill).</p>
${toolbar("Apps actions",'<a href="/usage">AI usage</a>', '<input data-filter aria-label="Filter the list" placeholder="Filter these (/)" size="16">')}
${apps.length ? kitTable("Apps",[{label:"App"},{label:"Project"},{label:"24h requests"},{label:"Errors"},{label:"Last deploy",className:"hide-s"},{label:"Last seen",className:"hide-s"}],apps.map(a=>({cells:[{html:`<code>${esc(a.script_name)}</code>${a.state !== "active" ? ` · ${esc(a.state === "pending" ? "waiting for approval" : a.state)}` : ""}`},{html:esc(a.project)},{html:String(a.requests)},{html:`${a.errors}${a.groups ? ` · ${plural(a.groups,"group")}` : ""}`},{html:esc(a.last_deploy ?? ""),className:"hide-s"},{html:ago(a.last_event_at,ctx.now),className:"hide-s"}]}))) : emptyState("No apps yet","Ask your agent to set up Pimwell reporting.",{label:"Setup guide",href:`https://${env.HUB_DOMAIN}/setup`})}
${deployList}
<h2>Errors, last 7 days</h2>
${groups.length ? kitTable("Error groups",[{label:"App"},{label:"Error"},{label:"Occurrences"},{label:"Last seen"}],groups.map(x=>({href:`/apps?g=${encodeURIComponent(x.id)}`,selected:g?.id === x.id,cells:[{html:esc(x.script_name)},{html:`<a href="/apps?g=${esc(encodeURIComponent(x.id))}">${esc(x.title)}</a>`},{html:String(x.count)},{html:ago(x.last_seen,ctx.now)}]}))) : '<p class="lede">No errors recorded.</p>'}`;
  if (site && view === "performance") list = `<div class="head"><h1>Performance</h1><span>${esc(site.name)}</span></div>${emptyState("No performance data yet", "Request, span and interaction timings will appear here when site performance reporting is available.", {label:"Deploys",href:deployHref()})}`;
  if (site && view === "errors") list = `<div class="head"><h1>Errors</h1><span>${esc(site.name)}</span></div><h2>Errors, last 7 days</h2>${groups.length ? kitTable("Error groups", [{label:"App"},{label:"Error"},{label:"Occurrences"},{label:"Last seen"}], groups.map(x => { const href = `/apps?project=${encodeURIComponent(site.project)}&site=${encodeURIComponent(site.name)}&view=errors&g=${encodeURIComponent(x.id)}`; return {href,selected:g?.id === x.id,cells:[{html:esc(x.script_name)},{html:`<a href="${esc(href)}">${esc(x.title)}</a>`},{html:String(x.count)},{html:ago(x.last_seen,ctx.now)}]}; })) : emptyState("No errors recorded", "Errors reported by this site’s apps will appear here.", {label:"Deploys",href:deployHref()})}`;
  const { relatedWork, relatedWorkCoverage } = traceWorkResults(relatedR!.results as TraceWorkItem[]);
  const relatedHtml = relatedWork.length ? `<h2>Recorded work</h2><table><tbody>${relatedWork.map(w => `<tr><td class="ref">${esc(w.ref)}</td><td>${esc(KINDS[w.kind].name)}</td><td><a href="/${esc(encodeURIComponent(w.project))}/w/${w.number}">${esc(w.title)}</a></td><td>${esc(STATES[w.state])}</td><td>${w.relationship}</td></tr>`).join("")}</tbody></table><p class="lede">${relatedWorkCoverage.shown} related work items shown${relatedWorkCoverage.truncated ? `; capped at ${relatedWorkCoverage.limit}, more omitted` : "; complete for recorded associations"}. Recorded associations do not prove these logs authorized the work.</p>` : "";
  let inspector = g ? `<a class="back" href="${esc(errorsHref)}">‹ Errors</a><div class="head"><span>${esc(g.kind)}</span><code>${esc(g.script_name)}</code><span>×${g.count}</span></div>
<h1>${esc(g.title)}</h1>
${inspectorSection("Error group",[{label:"Project",html:`<a href="/${esc(g.project)}/docket">${esc(names.group_name ?? g.project)}</a>`},{label:"First seen",html:localTime(g.first_seen)},{label:"Last seen",html:ago(g.last_seen,ctx.now)},{label:"Version",html:`<code>${esc(g.last_version?.slice(0,8) ?? "unknown")}</code>`}])}
<p class="lede">First observed deploy: ${g.first_deploy ? `<a href="${esc(deployHref(g.first_deploy))}">${esc(g.first_deploy)}</a>` : "unknown"}; commit ${originView?.commitHref ? `<a href="${esc(originView.commitHref)}">${esc(g.first_commit ?? "unknown")}</a>` : esc(g.first_commit ?? "unknown")}. Correlation, not proof of causation.</p>
${rank(ctx.role) >= rank("member") ? `<p><a class="button" href="/new?trace=${esc(encodeURIComponent(g.id))}">File a snag</a></p>` : ""}
${relatedHtml}
<pre>${esc(g.last_message)}</pre>
<h2>Recent</h2>${kitTable("Recent occurrences",[{label:"When"},{label:"Request"},{label:"Status"},{label:"Ray",className:"hide-s"}],(eventsR!.results as Array<{at:number;method:string|null;path:string|null;status:number|null;ray:string|null}>).map(e=>({cells:[{html:ago(e.at,ctx.now)},{html:`<code>${esc(`${e.method ?? ""} ${e.path ?? ""}`.trim())}</code>`},{html:String(e.status ?? "")},{html:esc(e.ray ?? ""),className:"hide-s"}]})))}
<h2>Deploys</h2>${(deploysR!.results as Array<{ id: string; tag: string | null; version_id: string; message: string | null; seen_at: number }>).map((d) => `<p><a href="${esc(deployHref(d.id))}"><code>${esc(d.tag ?? d.version_id.slice(0, 8))}</code></a> ${esc(d.message ?? "")} <small>${ago(d.seen_at, ctx.now)}</small></p>`).join("") || "<p class=\"lede\">None seen.</p>"}` : null;
  let inspectorKey = g ? `group:${g.id}:${g.count}:${g.first_deploy}:${g.first_commit}:${relatedWork.length}:${relatedWorkCoverage.truncated}` : "";
  if (selected) {
    const { deploy: d, commitRef, commitHref } = deployView(selected);
    const { relatedWork: work, relatedWorkCoverage: workCoverage } = deployWorkResults((await deployWorkStatement(ctx, selected).all<DeployWorkItem>()).results);
    inspector = `<a class="back" href="${esc(deployHref())}">‹ Deploys</a><div class="head"><span>Deploy record</span><code>${esc(d.id)}</code></div>
<h1>${esc(d.script_name)}</h1><p class="lede">Recorded metadata is not proof of live rollout, continued deployment or execution authority.</p>
${inspectorSection("Deployment", [{label:"Project",html:`${esc(names.deploy_name ?? d.project)}`},{label:"Recorded at",html:`${localTime(d.seen_at)}`},{label:"Version",html:`<code>${esc(d.version_id)}</code>`},{label:"Tag",html:`<code>${esc(d.tag ?? "none recorded")}</code>`}])}
${commitHref ? `<p><a href="${esc(commitHref)}">Recorded commit reference: ${esc(commitRef!)}</a>. The destination checks its own access; this record does not verify the commit exists or was deployed.</p>` : `<p class="lede">No supported full recorded commit reference. Tags, opaque versions and ambiguous repository slugs are not inferred to identify a commit.</p>`}
<h2>Recorded work</h2><p class="lede">Recorded associations are not proof of feature delivery, completion, revenue or execution authority.</p>
${work.length ? recordedWorkTable(work) : `<p class="lede">No work associations recorded for this deploy.</p>`}
<p class="lede">${workCoverage.shown} related work items shown${workCoverage.truncated ? "; capped at 50, more omitted" : "; complete for recorded associations"}.</p>
${d.message ? `<h2>Recorded message</h2><pre>${esc(d.message)}</pre>` : `<p class="lede">No message recorded.</p>`}`;
    inspectorKey = `deploy:${d.id}:${await sha256Hex(JSON.stringify([selected, work, workCoverage]))}`;
  }
  return htmlResponse(workbench(selected ? selected.script_name : g ? g.title : title, { list, stackOnPhone:true, listKey: `apps:${site?.id ?? ""}:${view ?? ""}:${project ?? ""}:${apps.length}:${groups.length}:${await sha256Hex(JSON.stringify(recordedDeploys))}:${coverage.truncated}`, inspector, inspectorKey }, shellFor(ctx, env, "apps", "apps")!), 200, extra);
}

/** Root approves (or disables) app registrations: mapping an account-wide script name to an organization. */
export async function adminAppsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex" || !ctx.identity || ctx.identity.kind !== "human" || ctx.identity.is_root !== 1) return notFoundPage(extra);
  const rows = (await ctx.db.prepare(`SELECT s.script_name, s.state, s.created_at, s.last_event_at, t.slug AS org, p.slug AS project, i.display_name AS who FROM app_source s
    JOIN tenant t ON t.id = s.tenant_id JOIN project p ON p.id = s.project_id LEFT JOIN identity i ON i.id = s.created_by ORDER BY s.state = 'pending' DESC, s.created_at DESC`)
    .all<{ script_name: string; state: string; created_at: number; last_event_at: number | null; org: string; project: string; who: string | null }>()).results;
  const form = (script: string, enable: boolean, label: string) => `<form class="inline" method="post" action="/api/app.approve"><input type="hidden" name="script" value="${esc(script)}"><input type="hidden" name="enable" value="${enable ? "1" : "0"}"><input type="hidden" name="_back" value="/admin/apps"><button type="submit" class="quiet">${label}</button></form>`;
  const body = `<h1>Apps</h1><p class="lede">Apps in this Cloudflare account that report through pimwell-tail. A script name is account-wide, so which organization receives an app's errors is yours to approve.</p>
${toolbar("Hub admin",'<a href="/admin/orgs">Organizations</a><a href="/admin/models">Models and keys</a>')}
${rows.length ? rows.map(r=>inspectorSection(r.script_name,[{label:"App",html:`<code>${esc(r.script_name)}</code>`},{label:"Organization / project",html:esc(r.org) + " / " + esc(r.project)},{label:"State",html:esc(r.state)},{label:"Asked by",html:esc(r.who ?? "")},{label:"Last event",html:ago(r.last_event_at,ctx.now)},{label:"Controls",html:"Manage reporting",editHtml:r.state === "active" ? form(r.script_name,false,"Disable") : form(r.script_name,true,"Approve")}])).join("") : "<p>No registrations yet.</p>"}`;
  return htmlResponse(page("Apps", body, shellFor(ctx, env, "admin", "apps")), 200, extra);
}
