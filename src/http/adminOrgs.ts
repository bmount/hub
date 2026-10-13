// Organizations (admin spec 8.1): every organization with its people and projects; archive, unarchive, and the
// root's organization controls. Own-org admins have controls on the hub home too.
import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, kitTable, localTime, naturalName, page, toolbar } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { listDeletedTenants } from "../db/tenantDelete";

const when = localTime;
const BACK = `<input type="hidden" name="_back" value="/admin/orgs">`;

export async function adminOrgsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex" || !ctx.identity || ctx.identity.kind !== "human" || ctx.identity.is_root !== 1) return notFoundPage(extra);

  const orgs = (await ctx.db.prepare(
    `SELECT t.slug, t.display_name, t.state, t.created_at,
       (SELECT COUNT(*) FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = t.id AND m.state = 'active' AND i.kind = 'human') AS people,
       (SELECT COUNT(*) FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = t.id AND m.state = 'active' AND i.kind = 'agent') AS agents,
       (SELECT COUNT(*) FROM project p WHERE p.tenant_id = t.id) AS projects
     FROM tenant t ORDER BY t.state, t.slug`,
  ).all<{ slug: string; display_name: string; state: string; created_at: number; people: number; agents: number; projects: number }>()).results;
  const deleted = await listDeletedTenants(ctx.db);

  const row = (o: (typeof orgs)[number]) => {
    const link = `<a href="https://${esc(o.slug)}.${esc(env.HUB_DOMAIN)}/">${esc(o.display_name)}</a>`;
    const action = o.state === "active"
      ? `<form data-reload class="inline" method="post" action="/api/tenant.archive"><input type="hidden" name="slug" value="${esc(o.slug)}">${BACK}<button type="submit" class="quiet destructive">Archive</button></form>`
      : `<form data-reload class="inline" method="post" action="/api/tenant.unarchive"><input type="hidden" name="slug" value="${esc(o.slug)}">${BACK}<button type="submit" class="quiet">Unarchive</button></form>
<form data-reload class="inline" method="post" action="/api/tenant.delete"><input type="hidden" name="slug" value="${esc(o.slug)}">
<input name="confirm" placeholder="type ${esc(o.slug)} to delete" size="22" autocomplete="off" required>${BACK}<button type="submit" class="quiet destructive">Delete permanently</button></form>`;
    return {cells:[{html:link},{html:esc(o.state)},{html:String(o.people)},{html:String(o.agents)},{html:String(o.projects)},{html:when(o.created_at)},{html:`<a href="https://${esc(o.slug)}.${esc(env.HUB_DOMAIN)}/admin/agents">Manage</a> <details class="wb-inline-edit"><summary>Controls</summary>${action}</details>`}]};
  };
  const body = `<h1>Organizations</h1>${toolbar("Hub admin",'<a href="/admin/models">Models and keys</a><a href="/admin/apps">Apps</a>')}
${kitTable("Organizations",[{label:"Organization"},{label:"State"},{label:"People"},{label:"Agents"},{label:"Projects"},{label:"Created"},{label:"Controls"}],orgs.sort((a,b)=>naturalName(a.display_name,b.display_name)).map(row))}
<p class="lede">Permanent deletion removes all organization data and reserves its name; it cannot be undone.</p>
<details><summary>Deleted organizations · ${deleted.length}</summary>
${deleted.length ? kitTable("Deleted organizations",[{label:"Organization"},{label:"Deleted"},{label:"Removed"},{label:"Git data"}],deleted.map(d=>({cells:[{html:esc(d.display_name) + " · " + esc(d.slug)},{html:when(d.deleted_at)},{html:esc(Object.entries(JSON.parse(d.counts) as Record<string,number>).map(([k,v])=>`${v} ${k}`).join(", ") || "no rows")},{html:d.git_purged_at ? `purged ${when(d.git_purged_at)}` : "name reserved; see deletion event"}]}))) : "<p>None.</p>"}</details>`;
  return htmlResponse(page("Organizations", body, shellFor(ctx, env, "admin", "orgs")), 200, extra);
}
