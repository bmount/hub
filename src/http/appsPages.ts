// Apps in the workbench (migration 0013): the organization's apps and their error groups as the list, one group in the
// inspector; and, on the hub, root's list of registrations to approve.
import type { Env } from "../env";
import { esc, htmlResponse, page, workbench } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { appsStatement } from "../verbs/apps";
import { traceGroupStatement, traceWorkStatement, traceWorkResults, type TraceWorkItem } from "../apps/work";
import { KINDS, STATES } from "../work/names";

const ago = (ms: number | null, now: number) => {
  if (!ms) return "never";
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

type App = { script_name: string; project: string; state: string; last_event_at: number | null; requests: number; errors: number; groups: number; last_deploy: string | null };
type Group = { id: string; project: string; script_name: string; kind: string; title: string; last_message: string; count: number; first_seen: number; last_seen: number; last_version: string | null };

export async function appsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const gid = new URL(request.url).searchParams.get("g") ?? "";
  const [appsR, groupsR, oneR, eventsR, deploysR, relatedR] = await ctx.db.batch([
    appsStatement(ctx.db, ctx.tenant.id, ctx.now),
    ctx.db.prepare(`SELECT g.id, p.slug AS project, g.script_name, g.kind, g.title, g.last_message, g.count, g.first_seen, g.last_seen, g.last_version FROM app_error_group g JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id AND p.kind <> 'channel'
      WHERE g.tenant_id = ? AND g.last_seen >= ? ORDER BY g.last_seen DESC LIMIT 100`).bind(ctx.tenant.id, ctx.now - 7 * 86_400_000),
    traceGroupStatement(ctx, gid),
    ctx.db.prepare("SELECT e.at, e.method, e.path, e.status, e.ray FROM app_event e JOIN app_error_group g ON g.id = e.group_id AND g.tenant_id = e.tenant_id WHERE g.id = ? AND g.tenant_id = ? ORDER BY e.at DESC LIMIT 20").bind(gid, ctx.tenant.id),
    ctx.db.prepare("SELECT d.tag, d.version_id, d.message, d.seen_at FROM app_deploy d JOIN app_error_group g ON g.script_name = d.script_name AND g.tenant_id = d.tenant_id AND g.project_id = d.project_id WHERE g.id = ? AND g.tenant_id = ? ORDER BY d.seen_at DESC LIMIT 5").bind(gid, ctx.tenant.id),
    traceWorkStatement(ctx, gid),
  ]);
  const apps = appsR!.results as App[];
  const groups = groupsR!.results as Group[];
  const g = (oneR!.results[0] as Group | undefined) ?? null;
  const list = `<div class="head"><h1>Apps</h1><span>${apps.length} reporting</span></div>
<p class="lede">Errors grouped by cause, deploys, and AI usage from the apps that report here. To add one, ask your agent to set up Pimwell (the onboard skill).</p>
${apps.length ? `<table><thead><tr><th>App</th><th>Project</th><th>24h requests</th><th>Errors</th><th class="hide-s">Last deploy</th><th class="hide-s">Last seen</th></tr></thead><tbody>${apps.map((a) =>
    `<tr><td><code>${esc(a.script_name)}</code>${a.state !== "active" ? ` <span class="pill">${esc(a.state === "pending" ? "waiting for approval" : a.state)}</span>` : ""}</td><td>${esc(a.project)}</td><td class="when">${a.requests}</td><td class="when">${a.errors}${a.groups ? ` <small>${a.groups} groups</small>` : ""}</td><td class="hide-s">${esc(a.last_deploy ?? "")}</td><td class="when hide-s">${ago(a.last_event_at, ctx.now)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No apps yet. Tell your agent: "set up pimwell.com". It will read ${esc(env.HUB_DOMAIN)}/setup and do the rest.</p>`}
<h2>Errors, last 7 days</h2>
${groups.length ? `<table><tbody>${groups.map((x) => `<tr data-href="/apps?g=${esc(x.id)}"${g?.id === x.id ? ' aria-selected="true"' : ""}><td class="ref">${esc(x.script_name)}</td><td><a href="/apps?g=${esc(x.id)}">${esc(x.title)}</a></td><td class="when">×${x.count}</td><td class="when">${ago(x.last_seen, ctx.now)}</td></tr>`).join("")}</tbody></table>` : `<p class="lede">None. Quiet is good.</p>`}`;
  const { relatedWork, relatedWorkCoverage } = traceWorkResults(relatedR!.results as TraceWorkItem[]);
  const relatedHtml = relatedWork.length ? `<h2>Recorded work</h2><table><tbody>${relatedWork.map(w => `<tr><td class="ref">${esc(w.ref)}</td><td>${esc(KINDS[w.kind].name)}</td><td><a href="/${esc(encodeURIComponent(w.project))}/w/${w.number}">${esc(w.title)}</a></td><td>${esc(STATES[w.state])}</td><td>${w.relationship}</td></tr>`).join("")}</tbody></table><p class="lede">${relatedWorkCoverage.shown} related work items shown${relatedWorkCoverage.truncated ? `; capped at ${relatedWorkCoverage.limit}, more omitted` : "; complete for recorded associations"}. Recorded associations do not prove these logs authorized the work.</p>` : "";
  const inspector = g ? `<a class="back" href="/apps">‹ Apps</a><div class="head"><span>${esc(g.kind)}</span><code>${esc(g.script_name)}</code><span>×${g.count}</span></div>
<h1>${esc(g.title)}</h1>
<dl class="meta"><dt>Project</dt><dd><a href="/${esc(g.project)}/docket">${esc(g.project)}</a></dd><dt>First seen</dt><dd>${new Date(g.first_seen).toISOString().slice(0, 16).replace("T", " ")}</dd><dt>Last seen</dt><dd>${ago(g.last_seen, ctx.now)} ago</dd><dt>Version</dt><dd><code>${esc(g.last_version?.slice(0, 8) ?? "unknown")}</code></dd></dl>
${rank(ctx.role) >= rank("member") ? `<p><a class="button" href="/new?trace=${esc(encodeURIComponent(g.id))}">File a snag</a></p>` : ""}
${relatedHtml}
<pre>${esc(g.last_message)}</pre>
<h2>Recent</h2><table><tbody>${(eventsR!.results as Array<{ at: number; method: string | null; path: string | null; status: number | null; ray: string | null }>).map((e) =>
    `<tr><td class="when">${ago(e.at, ctx.now)}</td><td><code>${esc(`${e.method ?? ""} ${e.path ?? ""}`.trim())}</code></td><td class="when">${e.status ?? ""}</td><td class="when hide-s">${esc(e.ray ?? "")}</td></tr>`).join("")}</tbody></table>
<h2>Deploys</h2>${(deploysR!.results as Array<{ tag: string | null; version_id: string; message: string | null; seen_at: number }>).map((d) => `<p><code>${esc(d.tag ?? d.version_id.slice(0, 8))}</code> ${esc(d.message ?? "")} <small>${ago(d.seen_at, ctx.now)} ago</small></p>`).join("") || "<p class=\"lede\">None seen.</p>"}` : null;
  return htmlResponse(workbench(g ? g.title : "Apps", { list, listKey: `apps:${apps.length}:${groups.length}`, inspector, inspectorKey: g ? `group:${g.id}:${g.count}:${relatedWork.length}:${relatedWorkCoverage.truncated}` : "" }, shellFor(ctx, env, "apps", "apps")!), 200, extra);
}

/** Root approves (or disables) app registrations: mapping an account-wide script name to an organization. */
export async function adminAppsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex" || !ctx.identity || ctx.identity.kind !== "human" || ctx.identity.is_root !== 1) return notFoundPage(extra);
  const rows = (await ctx.db.prepare(`SELECT s.script_name, s.state, s.created_at, s.last_event_at, t.slug AS org, p.slug AS project, i.display_name AS who FROM app_source s
    JOIN tenant t ON t.id = s.tenant_id JOIN project p ON p.id = s.project_id LEFT JOIN identity i ON i.id = s.created_by ORDER BY s.state = 'pending' DESC, s.created_at DESC`)
    .all<{ script_name: string; state: string; created_at: number; last_event_at: number | null; org: string; project: string; who: string | null }>()).results;
  const form = (script: string, enable: boolean, label: string) => `<form class="inline" method="post" action="/api/app.approve"><input type="hidden" name="script" value="${esc(script)}"><input type="hidden" name="enable" value="${enable ? "1" : "0"}"><input type="hidden" name="_back" value="/admin/apps"><button type="submit"${enable ? "" : ' class="quiet"'}>${label}</button></form>`;
  const body = `<h1>Apps</h1><p class="lede">Apps in this Cloudflare account that report through pimwell-tail. A script name is account-wide, so which organization receives an app's errors is yours to approve.</p>
${rows.length ? `<table><thead><tr><th>App</th><th>Into</th><th>State</th><th>Asked by</th><th>Last event</th><th></th></tr></thead><tbody>${rows.map((r) =>
    `<tr><td><code>${esc(r.script_name)}</code></td><td>${esc(r.org)} / ${esc(r.project)}</td><td>${esc(r.state)}</td><td>${esc(r.who ?? "")}</td><td>${ago(r.last_event_at, ctx.now)}</td><td>${r.state === "active" ? form(r.script_name, false, "Disable") : form(r.script_name, true, "Approve")}</td></tr>`).join("")}</tbody></table>` : "<p>No registrations yet.</p>"}`;
  return htmlResponse(page("Apps", body, shellFor(ctx, env, "admin", "apps")), 200, extra);
}
