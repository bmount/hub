// People and agents in the workbench: everyone in the list, one person (or the invite form) in the inspector.
// Admins invite, change roles and remove people here (member.set_role, member.remove, invite.create, invite.revoke);
// everyone else sees who is here and what they are on. One D1 batch per page.
import { agentSrcAccess } from "../code/agentSrc";
import type { Env } from "../env";
import { listIdentityEmails } from "../db/identityEmails";
import { localTime, address, naturalName, plural, emptyState, esc, htmlResponse, inspectorSection, kitTable, toolbar, workbench } from "../html";
import { buildContext, rank, type Ctx } from "../auth/context";
import { readableMailEvents } from "../auth/mailAccess";
import { clearSessionCookie } from "../auth/cookie";
import { notFoundPage } from "./pages";
import { shellFor } from "./shell";
import { extraCheck, proofFresh } from "./extraCheck";
import { tenantAgentActivity } from "../db/agents";
import { guideStatus } from "../skills/receipts";
import { listAgentRunsForOperator, listSessions } from "../db/sessions";
import { listApiTokensForOperator } from "../db/apiTokens";

type Person = { id: string; display_name: string; email: string; kind: string; is_root: number; role: string; created_at: number; sponsor: string | null; operator_id: string | null; last_seen: number | null; open: number };
type Invite = { id: string; email: string; role: string; display_name: string | null; created_at: number; expires_at: number; by: string | null };
type Activity = { summary: string; created_at: number };

const ago = (ms: number | null, _now: number) => localTime(ms);
const day = localTime;
const option = (v: string, label: string, sel: boolean) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label)}</option>`;

export async function peoplePage(request: Request, env: Env, who: string | null = null): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role || !ctx.identity) return notFoundPage(extra);
  const admin = rank(ctx.role) >= rank("admin");
  const url = new URL(request.url);
  const inviting = admin && url.searchParams.get("invite") === "1";
  const canConnect = rank(ctx.role) >= rank("member");
  const connecting = canConnect && url.searchParams.get("connect") === "1";
  const fresh = proofFresh(ctx), sent = url.searchParams.get("check") === "sent";
  const pre = (k: string) => (url.searchParams.get(k) ?? "").slice(0, 254);
  const AGENT_WHY = "Confirm it’s you before connecting an agent.";
  const email = who ? decodeURIComponent(who).trim().toLowerCase() : null;
  const tid = ctx.tenant.id;
  const eventAccess = readableMailEvents(ctx);
  const stmts: D1PreparedStatement[] = [
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FpeoplePages.ts:41:5:peoplePage:d642a178*/ SELECT i.id, i.display_name, i.email, i.kind, i.is_root, m.role, m.created_at, op.display_name AS sponsor, i.operator_id,
        (SELECT MAX(e.created_at) FROM event e WHERE e.identity_id = i.id AND e.tenant_id = m.tenant_id) AS last_seen,
        (SELECT COUNT(*) FROM work_item w WHERE w.tenant_id = m.tenant_id AND w.owner_id = i.id AND w.state IN ('open', 'doing')) AS open
      FROM membership m JOIN identity i ON i.id = m.identity_id LEFT JOIN identity op ON op.id = i.operator_id
      WHERE m.tenant_id = ? AND m.state = 'active' AND i.state = 'active' AND i.is_synthetic = 0 ORDER BY i.kind = 'agent', i.display_name`).bind(tid),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FpeoplePages.ts:46:5:peoplePage:0d92031a*/ SELECT v.id, v.email, v.role, v.display_name, v.created_at, v.expires_at, b.display_name AS by FROM invite v LEFT JOIN identity b ON b.id = v.created_by
      WHERE v.tenant_id = ? AND v.accepted_at IS NULL AND v.revoked_at IS NULL AND v.expires_at > ? AND ? ORDER BY v.created_at DESC`).bind(tid, ctx.now, admin ? 1 : 0),
    ctx.db.prepare(`/*perf-site:src%2Fhttp%2FpeoplePages.ts:48:5:peoplePage:4e8d874c*/ SELECT e.summary, e.created_at FROM event e JOIN identity i ON i.id = e.identity_id WHERE e.tenant_id = ? AND i.email = ? AND ${eventAccess.sql} ORDER BY e.created_at DESC LIMIT 15`).bind(tid, email ?? "", ...eventAccess.bindings),
  ];
  const [peopleR, invitesR, activityR] = await ctx.db.batch(stmts);
  const people = (peopleR!.results as Person[]).sort((a,b)=>naturalName(a.display_name,b.display_name));
  const invites = invitesR!.results as Invite[];
  const person = email ? people.find((p) => p.email === email) ?? null : null;
  if (email && !person) return notFoundPage(extra);

  const sourceLink = (p: Person) => p.kind === "agent" && agentSrcAccess({ identity: ctx.identity!, role: ctx.role! }, p)
    ? ` <a href="/agent-src/${esc(encodeURIComponent(p.email.slice(p.email.indexOf(".") + 1, p.email.indexOf("@"))))}/code">agent-src/${esc(p.email.slice(p.email.indexOf(".") + 1, p.email.indexOf("@")))}</a>` : "";
  const humans = people.filter((p) => p.kind === "human"), agents = people.filter((p) => p.kind !== "human");
  const table = (rows: Person[], agent: boolean) => rows.length ? kitTable(agent ? "Agents" : "People",
    [{label:"Name"},...(agent ? [{label:"Source",className:"hide-s"}] : []),{label:"Address",className:"hide-s"},{label:"Role"},...(agent ? [{label:"Answers to",className:"hide-s"}] : []),{label:"Open"},{label:"Active"}],
    rows.map(p => { const href = `/people/${encodeURIComponent(p.email)}`; return {href,selected:person?.id === p.id,cells:[
      {html:`<a href="${esc(href)}">${esc(p.display_name)}</a>`},...(agent ? [{html:sourceLink(p) || "—",className:"hide-s"}] : []),{html:address(p.email),className:"hide-s"},{html:esc(p.is_root ? "root" : p.role)},
      ...(agent ? [{html:esc(p.sponsor ?? "nobody"),className:"hide-s"}] : []),{html:String(p.open)},{html:ago(p.last_seen,ctx.now)}]}; }))
    : emptyState(agent ? "No agents yet" : "No people yet", agent ? "Connect an agent to work alongside you." : "Invite a person to this organization.", {label:agent ? "Connect an agent" : "People",href:agent && canConnect ? "/people?connect=1" : "/people"});
  const pending = admin ? `<h2>Invites waiting</h2>${invites.length ? kitTable("Invites",[{label:"Address"},{label:"Role"},{label:"By",className:"hide-s"},{label:"Expires"},{label:"Action"}],invites.map(v=>({cells:[
    {html:address(v.email)},{html:esc(v.role)},{html:esc(v.by ?? ""),className:"hide-s"},{html:day(v.expires_at)},
    {html:`<form class="inline" method="post" action="/api/invite.revoke"><input type="hidden" name="invite_id" value="${esc(v.id)}"><input type="hidden" name="_back" value="/people"><button class="quiet" type="submit">Revoke</button></form>`}]}))) : '<p class="lede">None.</p>'}` : "";
  const list = `<div class="head"><h1>People and agents</h1><span>${plural(humans.length,"person","people")}, ${plural(agents.length,"agent")}</span></div>
${toolbar("People actions", `${canConnect ? '<a href="/people?connect=1">Connect an agent</a>' : ""}${admin ? '<a href="/people?invite=1">Invite a person</a><a href="/admin/agents">Manage agents</a>' : ""}`)}
<h2>People</h2>${table(humans,false)}<h2>Agents</h2>${table(agents,true)}${pending}`;

  let inspector: string | null = null; let key = "";
  if (connecting) {
    const back = `/people?connect=1${pre("name") ? `&name=${encodeURIComponent(pre("name"))}` : ""}`;
    inspector = `<a class="back" href="/people">‹ People</a><h1>Connect an agent</h1>
${fresh ? '<p class="lede">Paste the one-time, 24-hour link to your agent.</p>' : ""}
${fresh ? `<form method="post" action="/api/agent.connect">
<label style="display:block">Name <input name="display_name" required maxlength="80" style="display:block;width:100%" placeholder="Build box" value="${esc(pre("name"))}" autofocus></label>
<p><button type="submit">Make connect link</button></p></form>` : extraCheck(env, ctx, back, AGENT_WHY, sent)}
`;
    key = "connect";
  } else if (inviting) {
    const root = ctx.identity.is_root === 1;
    inspector = `<a class="back" href="/people">‹ People</a><h1>Invite someone</h1>
<p class="lede">You get a single-use link to send yourself; Pimwell never emails people who haven't written to it. They can also just sign in with Google at ${esc(env.HUB_DOMAIN)} as the invited address.</p>
<p>Check the complete address, including the domain. Format checks do not verify mailbox ownership or catch plausible typos.</p>
${fresh ? `<form method="post" action="/api/invite.create">
<label style="display:block">Email <input name="email" type="email" required maxlength="254" style="display:block;width:100%" value="${esc(pre("email"))}" autofocus></label>
<label style="display:block">Name <input name="display_name" maxlength="100" style="display:block;width:100%" placeholder="How they appear here" value="${esc(pre("name"))}"></label>
<label>Role <select name="role">${option("member", "Member: files and changes work", pre("role") !== "reader" && pre("role") !== "admin")}${option("reader", "Reader: sees everything, changes nothing", pre("role") === "reader")}${root ? option("admin", "Admin: manages people and settings", pre("role") === "admin") : ""}</select></label>
<p><button type="submit">Create invite link</button></p></form>` : extraCheck(env, ctx, `/people?invite=1${["email", "name", "role"].map((k) => (pre(k) ? `&${k}=${encodeURIComponent(pre(k))}` : "")).join("")}`, "Invites let someone into your organization, so we confirm it's really you first.", sent)}`;
    key = "invite";
  } else if (person) {
    const canManage = admin && person.kind === "human" && person.id !== ctx.identity.id && !person.is_root && (ctx.identity.is_root === 1 || person.role !== "admin");
    const roles = ["member", "reader", ...(ctx.identity.is_root === 1 ? ["admin"] : [])];
    const sponsored = people.filter((p) => p.kind !== "human" && p.sponsor === person.display_name);
    const activity = activityR!.results as Activity[];
    let sessionHtml = "";
    if (ctx.identity.kind === "human" && person.kind === "agent" && (admin || person.operator_id === ctx.identity.id)) {
      let tokens = 0, runs = 0;
      if (admin) {
        const counts = (await tenantAgentActivity(ctx.db, tid, ctx.now)).get(person.id);
        tokens = counts?.tokens ?? 0; runs = counts?.runs ?? 0;
      } else {
        const [ts,rs] = await Promise.all([listApiTokensForOperator(ctx.db,ctx.identity.id,ctx.now),listAgentRunsForOperator(ctx.db,ctx.identity.id,ctx.now)]);
        tokens = ts.filter(t=>t.token.identity_id === person.id).length;
        runs = rs.filter(r=>r.session.identity_id === person.id).length;
      }
      sessionHtml = inspectorSection("Sessions",[{label:"Active tokens",html:String(tokens)},{label:"Active runs",html:String(runs)}]);
    } else if (person.id === ctx.identity.id && ctx.identity.kind === "human") {
      const sessions = await listSessions(ctx.db,ctx.identity.id,ctx.now);
      sessionHtml = inspectorSection("Sessions",[{label:"Active",html:String(sessions.length)}],`<a href="https://${esc(env.HUB_DOMAIN)}/me/sessions">Manage sessions</a>`);
    }
    let guideHtml = "";
    if (person.kind === "agent" && ctx.identity.kind === "human" && (admin || person.operator_id === ctx.identity.id)) {
      const guide = await guideStatus(ctx.db, tid, person.id);
      guideHtml = `<h2>Guide</h2><p>${guide.caught_up ? "Caught up" : "Not caught up"} · current version <code>${esc(guide.version)}</code></p><p>Last fully read guide: ${guide.last_read_version ? `<code>${esc(guide.last_read_version)}</code>` : "none recorded"}</p><ul>${guide.skills.map(s => `<li>${esc(s.name)}: ${s.read ? `read ${day(s.read.read_at)}` : "not read at current version"}${s.last_read ? ` · last read <code>${esc(s.last_read.version)}</code> ${day(s.last_read.read_at)}` : ""}</li>`).join("")}</ul><p class="lede">Records delivery through skill_read, not proof of understanding or changes to local files. Operator standing directions are never changed.</p>`;
    }
    let emailHtml = "";
    if (admin && person.kind === "human") {
      const linked = (await listIdentityEmails(ctx.db, person.id)).results;
      const mayConfirm = ctx.identity.is_root === 1 || (!person.is_root && person.role !== "admin");
      const back = `/people/${encodeURIComponent(person.email)}`;
      const fields = `<input type="hidden" name="member" value="${esc(person.email)}"><input type="hidden" name="_back" value="${esc(back)}">`;
      emailHtml = `<h2>Confirmed email addresses</h2><p>These addresses identify this person across all organizations. Linking does not grant mail consent.</p><ul><li>${address(person.email)} (primary)</li>${linked.map(a => `<li>${address(a.email)}${mayConfirm ? `<form class="inline" method="post" action="/api/identity.email_remove">${fields}<input type="hidden" name="email" value="${esc(a.email)}"><button class="quiet" type="submit">Remove</button></form>` : ""}</li>`).join("")}</ul>`
        + (mayConfirm ? fresh ? `<form method="post" action="/api/identity.email_add">${fields}<label>Additional email <input name="email" type="email" required maxlength="254"></label><p>Confirm only an address you know this person controls.</p><button type="submit">Confirm address</button></form>` : extraCheck(env, ctx, back, "Confirm it’s you before linking an address.", sent) : "");
    }
    const manage = canManage ? `<h2>Manage</h2>
<form method="post" action="/api/member.set_role"><input type="hidden" name="email" value="${esc(person.email)}"><input type="hidden" name="_back" value="/people/${esc(encodeURIComponent(person.email))}">
<label>Role <select name="role">${roles.map((r) => option(r, r, r === person.role)).join("")}</select></label> <button type="submit" class="quiet">Change role</button></form>
<details class="edit"><summary>Remove from ${esc(ctx.tenant.display_name)}</summary><p class="lede">Their history stays. Their access and assistant connections here end now, and their open work goes back to nobody.${sponsored.length ? ` ${plural(sponsored.length,"agent")} ${sponsored.length === 1 ? "answers" : "answer"} to them; reassign or archive those on the Agents page.` : ""}</p>
<form method="post" action="/api/member.remove"><input type="hidden" name="email" value="${esc(person.email)}"><input type="hidden" name="_back" value="/people">
<label>Type their email to confirm <input name="confirm" required autocomplete="off"></label><button type="submit">Remove</button></form></details>` : "";
    inspector = `<a class="back" href="/people">‹ People</a>
<div class="head"><span>${person.kind === "human" ? "Person" : "Agent"}</span></div><h1>${esc(person.display_name)}</h1>${sourceLink(person)}
${inspectorSection("Identity", [{label:"Address",html:address(person.email)},{label:"Role",html:esc(person.is_root ? "root" : person.role)},...(person.sponsor ? [{label:"Answers to",html:esc(person.sponsor)}] : []),{label:"Here since",html:day(person.created_at)},{label:"Last active",html:ago(person.last_seen,ctx.now)},{label:"Open work",html:`<a href="/docket?owner=${esc(encodeURIComponent(person.email))}">${plural(person.open,"item")}</a>`}])}
${person.kind === "agent" && canConnect && (admin || person.operator_id === ctx.identity.id) ? `<h2>Connect</h2><p class="lede">A new one-time link, valid 24 hours, gives the agent a fresh token. Its earlier tokens keep working until they expire or are revoked.</p>
${fresh ? `<form method="post" action="/api/agent.connect"><input type="hidden" name="agent_id" value="${esc(person.id)}"><button type="submit" class="quiet">Make connect link</button></form>` : extraCheck(env, ctx, `/people/${encodeURIComponent(person.email)}`, AGENT_WHY, sent)}` : ""}
${sponsored.length ? `<h2>Agents who answer to them</h2><ul>${sponsored.map((s) => `<li><a href="/people/${esc(encodeURIComponent(s.email))}">${esc(s.display_name)}</a></li>`).join("")}</ul>` : ""}
${person.id === ctx.identity.id || person.operator_id === ctx.identity.id ? '<p><a href="https://' + esc(env.HUB_DOMAIN) + '/me">Account and sessions</a></p>' : ""}
${emailHtml}
${sessionHtml}
${guideHtml}
${manage}
<h2>Recent activity</h2>${activity.length ? `<ul class="timeline">${activity.map((a) => `<li><time>${ago(a.created_at, ctx.now)}</time><span>${esc(a.summary)}</span></li>`).join("")}</ul>` : `<p class="lede">Nothing yet.</p>`}`;
    key = `person:${person.id}:${person.role}`;
  }
  return htmlResponse(workbench(person ? person.display_name : "People and agents", { list, stackOnPhone:true, listKey: `people:${humans.length}:${agents.length}:${invites.length}`, inspector, inspectorKey: key },
    shellFor(ctx, env, "people")!), 200, extra);
}
