// People and agents in the workbench: everyone in the list, one person (or the invite form) in the inspector.
// Admins invite, change roles and remove people here (member.set_role, member.remove, invite.create, invite.revoke);
// everyone else sees who is here and what they are on. One D1 batch per page.
import type { Env } from "../env";
import { esc, htmlResponse, workbench } from "../html";
import { buildContext, rank, type Ctx } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";

type Person = { id: string; display_name: string; email: string; kind: string; is_root: number; role: string; created_at: number; sponsor: string | null; last_seen: number | null; open: number };
type Invite = { id: string; email: string; role: string; display_name: string | null; created_at: number; expires_at: number; by: string | null };
type Activity = { summary: string; created_at: number };

const ago = (ms: number | null, now: number) => {
  if (!ms) return "not yet";
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const option = (v: string, label: string, sel: boolean) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label)}</option>`;

export async function peoplePage(request: Request, env: Env, who: string | null = null): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const admin = rank(ctx.role) >= rank("admin");
  const url = new URL(request.url);
  const inviting = admin && url.searchParams.get("invite") === "1";
  const email = who ? decodeURIComponent(who).trim().toLowerCase() : null;
  const tid = ctx.tenant.id;
  const stmts: D1PreparedStatement[] = [
    ctx.db.prepare(`SELECT i.id, i.display_name, i.email, i.kind, i.is_root, m.role, m.created_at, op.display_name AS sponsor,
        (SELECT MAX(e.created_at) FROM event e WHERE e.identity_id = i.id AND e.tenant_id = m.tenant_id) AS last_seen,
        (SELECT COUNT(*) FROM work_item w WHERE w.tenant_id = m.tenant_id AND w.owner_id = i.id AND w.state IN ('open', 'doing')) AS open
      FROM membership m JOIN identity i ON i.id = m.identity_id LEFT JOIN identity op ON op.id = i.operator_id
      WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' ORDER BY i.kind = 'agent', i.display_name`).bind(tid),
    ctx.db.prepare(`SELECT v.id, v.email, v.role, v.display_name, v.created_at, v.expires_at, b.display_name AS by FROM invite v LEFT JOIN identity b ON b.id = v.created_by
      WHERE v.tenant_id = ? AND v.accepted_at IS NULL AND v.revoked_at IS NULL AND v.expires_at > ? AND ? ORDER BY v.created_at DESC`).bind(tid, ctx.now, admin ? 1 : 0),
    ctx.db.prepare(`SELECT e.summary, e.created_at FROM event e JOIN identity i ON i.id = e.identity_id WHERE e.tenant_id = ? AND i.email = ? ORDER BY e.created_at DESC LIMIT 15`).bind(tid, email ?? ""),
  ];
  const [peopleR, invitesR, activityR] = await ctx.db.batch(stmts);
  const people = peopleR!.results as Person[];
  const invites = invitesR!.results as Invite[];
  const person = email ? people.find((p) => p.email === email) ?? null : null;
  if (email && !person) return notFoundPage(extra);

  const row = (p: Person) => {
    const href = `/people/${encodeURIComponent(p.email)}`;
    return `<tr data-href="${esc(href)}"${person?.id === p.id ? ' aria-selected="true"' : ""}><td><a href="${esc(href)}">${esc(p.display_name)}</a></td><td class="hide-s"><code>${esc(p.email)}</code></td><td>${esc(p.is_root ? "root" : p.role)}</td>${p.kind === "agent" ? `<td class="hide-s">${esc(p.sponsor ?? "nobody")}</td>` : ""}<td class="when">${p.open || ""}</td><td class="when">${ago(p.last_seen, ctx.now)}</td></tr>`;
  };
  const humans = people.filter((p) => p.kind === "human"), agents = people.filter((p) => p.kind !== "human");
  const table = (rows: Person[], agent: boolean) => rows.length
    ? `<table><thead><tr><th>Name</th><th class="hide-s">Address</th><th>Role</th>${agent ? '<th class="hide-s">Answers to</th>' : ""}<th>Open</th><th>Active</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table>`
    : `<p class="empty">${agent ? "No agents yet." : "Nobody yet."}</p>`;
  const pending = admin ? `<h2>Invites waiting</h2>${invites.length ? `<table><thead><tr><th>Address</th><th>Role</th><th class="hide-s">By</th><th>Expires</th><th></th></tr></thead><tbody>${invites.map((v) =>
    `<tr><td><code>${esc(v.email)}</code></td><td>${esc(v.role)}</td><td class="hide-s">${esc(v.by ?? "")}</td><td class="when">${day(v.expires_at)}</td><td><form class="inline" method="post" action="/api/invite.revoke"><input type="hidden" name="invite_id" value="${esc(v.id)}"><input type="hidden" name="_back" value="/people"><button class="quiet" type="submit">Revoke</button></form></td></tr>`).join("")}</tbody></table>` : `<p class="lede">None.</p>`}` : "";
  const list = `<div class="head"><h1>People and agents</h1><span>${humans.length} people, ${agents.length} agents</span>${admin ? `<a class="button" href="/people?invite=1">Invite someone</a>` : ""}</div>
<p class="lede">Every agent answers to a named person, and everything anyone does here is on the record.</p>
<h2>People</h2>${table(humans, false)}<h2>Agents</h2>${table(agents, true)}${admin ? `<p><a href="/admin/agents">Manage agents</a></p>` : ""}${pending}`;

  let inspector: string | null = null; let key = "";
  if (inviting) {
    const root = ctx.identity.is_root === 1;
    inspector = `<a class="back" href="/people">‹ People</a><h1>Invite someone</h1>
<p class="lede">You get a single-use link to send yourself; Pimwell never emails people who haven't written to it. They can also just sign in with Google at ${esc(env.HUB_DOMAIN)} as the invited address.</p>
<form method="post" action="/api/invite.create"><input type="hidden" name="_back" value="/people">
<label style="display:block">Email <input name="email" type="email" required maxlength="254" style="display:block;width:100%" autofocus></label>
<label style="display:block">Name <input name="display_name" maxlength="100" style="display:block;width:100%" placeholder="How they appear here"></label>
<label>Role <select name="role">${option("member", "Member: files and changes work", true)}${option("reader", "Reader: sees everything, changes nothing", false)}${root ? option("admin", "Admin: manages people and settings", false) : ""}</select></label>
<p><button type="submit">Create invite link</button></p></form>`;
    key = "invite";
  } else if (person) {
    const canManage = admin && person.kind === "human" && person.id !== ctx.identity.id && !person.is_root && (ctx.identity.is_root === 1 || person.role !== "admin");
    const roles = ["member", "reader", ...(ctx.identity.is_root === 1 ? ["admin"] : [])];
    const sponsored = people.filter((p) => p.kind !== "human" && p.sponsor === person.display_name);
    const activity = activityR!.results as Activity[];
    const manage = canManage ? `<h2>Manage</h2>
<form method="post" action="/api/member.set_role"><input type="hidden" name="email" value="${esc(person.email)}"><input type="hidden" name="_back" value="/people/${esc(encodeURIComponent(person.email))}">
<label>Role <select name="role">${roles.map((r) => option(r, r, r === person.role)).join("")}</select></label> <button type="submit" class="quiet">Change role</button></form>
<details class="edit"><summary>Remove from ${esc(ctx.tenant.display_name)}</summary><p class="lede">Their history stays. Their access and assistant connections here end now, and their open work goes back to nobody.${sponsored.length ? ` ${sponsored.length} agent(s) answer to them; reassign or archive those on the Agents page.` : ""}</p>
<form method="post" action="/api/member.remove"><input type="hidden" name="email" value="${esc(person.email)}"><input type="hidden" name="_back" value="/people">
<label>Type their email to confirm <input name="confirm" required autocomplete="off"></label><button type="submit">Remove</button></form></details>` : "";
    inspector = `<a class="back" href="/people">‹ People</a>
<div class="head"><span>${person.kind === "human" ? "Person" : "Agent"}</span></div><h1>${esc(person.display_name)}</h1>
<dl class="meta"><dt>Address</dt><dd><code>${esc(person.email)}</code></dd><dt>Role</dt><dd>${esc(person.is_root ? "root" : person.role)}</dd>
${person.sponsor ? `<dt>Answers to</dt><dd>${esc(person.sponsor)}</dd>` : ""}<dt>Here since</dt><dd>${day(person.created_at)}</dd><dt>Last active</dt><dd>${ago(person.last_seen, ctx.now)}</dd>
<dt>Open work</dt><dd><a href="/docket?owner=${esc(encodeURIComponent(person.email))}">${person.open} item${person.open === 1 ? "" : "s"}</a></dd></dl>
${sponsored.length ? `<h2>Agents who answer to them</h2><ul>${sponsored.map((s) => `<li><a href="/people/${esc(encodeURIComponent(s.email))}">${esc(s.display_name)}</a></li>`).join("")}</ul>` : ""}
${manage}
<h2>Recent activity</h2>${activity.length ? `<ul class="timeline">${activity.map((a) => `<li><time>${ago(a.created_at, ctx.now)}</time><span>${esc(a.summary)}</span></li>`).join("")}</ul>` : `<p class="lede">Nothing yet.</p>`}`;
    key = `person:${person.id}:${person.role}`;
  }
  return htmlResponse(workbench(person ? person.display_name : "People and agents", { list, listKey: `people:${humans.length}:${agents.length}:${invites.length}`, inspector, inspectorKey: key },
    shellFor(ctx, env, "people")!), 200, extra);
}
