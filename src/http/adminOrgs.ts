// Organizations (admin spec 8.1): every organization with its people and projects; archive, unarchive, and the
// super-admin delete. Apex, root only. Delete needs the organization archived, a fresh proof, and its name typed.
import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, page } from "../html";
import { buildContext } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { listDeletedTenants } from "../db/tenantDelete";

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");
const BACK = `<input type="hidden" name="_back" value="/admin/orgs">`;

export async function adminOrgsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex" || !ctx.identity || ctx.identity.kind !== "human" || ctx.identity.is_root !== 1) return notFoundPage(extra);

  const orgs = (await ctx.db.prepare(
    `SELECT t.slug, t.display_name, t.state, t.created_at,
       (SELECT COUNT(*) FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = t.id AND m.state = 'active' AND i.kind = 'human') AS people,
       (SELECT COUNT(*) FROM membership m JOIN identity i ON i.id = m.identity_id WHERE m.tenant_id = t.id AND m.state = 'active' AND i.kind = 'agent') AS helpers,
       (SELECT COUNT(*) FROM project p WHERE p.tenant_id = t.id) AS projects
     FROM tenant t ORDER BY t.state, t.slug`,
  ).all<{ slug: string; display_name: string; state: string; created_at: number; people: number; helpers: number; projects: number }>()).results;
  const deleted = await listDeletedTenants(ctx.db);

  const row = (o: (typeof orgs)[number]) => {
    const link = `<a href="https://${esc(o.slug)}.${esc(env.HUB_DOMAIN)}/">${esc(o.display_name)}</a> <code>${esc(o.slug)}</code>`;
    const action = o.state === "active"
      ? `<form class="inline" method="post" action="/api/tenant.archive"><input type="hidden" name="slug" value="${esc(o.slug)}">${BACK}<button type="submit">Archive</button></form>`
      : `<form class="inline" method="post" action="/api/tenant.unarchive"><input type="hidden" name="slug" value="${esc(o.slug)}">${BACK}<button type="submit">Unarchive</button></form>
<form class="inline" method="post" action="/api/tenant.delete"><input type="hidden" name="slug" value="${esc(o.slug)}">
<input name="confirm" placeholder="type ${esc(o.slug)} to delete" size="22" autocomplete="off" required>${BACK}<button type="submit">Delete permanently</button></form>`;
    return `<tr><td>${link}</td><td>${esc(o.state)}</td><td>${o.people}</td><td>${o.helpers}</td><td>${o.projects}</td><td>${when(o.created_at)}</td><td>${action}</td></tr>`;
  };
  const deletedRows = deleted.map((d) => {
    const counts = Object.entries(JSON.parse(d.counts) as Record<string, number>).map(([k, v]) => `${v} ${k}`).join(", ") || "no rows";
    return `<tr><td>${esc(d.display_name)} <code>${esc(d.slug)}</code></td><td>${when(d.deleted_at)}</td><td><small>${esc(counts)}</small></td><td>${d.git_purged_at ? `purged ${when(d.git_purged_at)}` : "kept; name reserved"}</td></tr>`;
  }).join("");

  const body = `<h1>Organizations</h1><p><a href="/">back</a></p>
<table><thead><tr><th>Organization</th><th>State</th><th>People</th><th>Helpers</th><th>Projects</th><th>Created</th><th></th></tr></thead><tbody>${orgs.map(row).join("")}</tbody></table>
<p><small>Deleting removes everything the hub holds for an archived organization: members, projects, conversations, events, keys, and its helper accounts. It cannot be undone. Git data stays with the git host until it can purge it, and until then the name stays reserved.</small></p>
<h2>Deleted</h2>
${deleted.length ? `<table><thead><tr><th>Organization</th><th>Deleted</th><th>Removed</th><th>Git data</th></tr></thead><tbody>${deletedRows}</tbody></table>` : "<p>None.</p>"}`;
  return htmlResponse(page("Organizations", body, shellFor(ctx, env, "admin", "orgs")), 200, extra);
}
