import type { Env } from "../env";
import { shellFor } from "./shell";
import { esc, htmlResponse, page, logout } from "../html";
import { buildContext, rank } from "../auth/context";
import { clearSessionCookie } from "../auth/cookie";
import { listAgentRunsForOperator, listSessions } from "../db/sessions";
import { listMembershipsForIdentity } from "../db/memberships";
import { listTenants } from "../db/tenants";
import { listAgentsForOperator } from "../db/agents";
import { listApiTokensForOperator } from "../db/apiTokens";
import { listConsent } from "../db/consent";
import { listLiveGrantsForIdentity } from "../db/oauthGrants";
import { notFoundPage } from "./pages";

const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const BACK = `<input type="hidden" name="_back" value="/me">`;

function button(verb: string, fields: Record<string, string>, label: string): string {
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<form class="inline" method="post" action="/api/${esc(verb)}">${hidden}${BACK}<button type="submit">${esc(label)}</button></form>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p>None.</p>";
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export async function mePage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex") return notFoundPage(extra);
  if (!ctx.identity || !ctx.session || ctx.identity.kind !== "human") {
    return htmlResponse(page("Sign in", `<h1>Sign in required</h1><p><a href="/login">Sign in</a></p>`), 401, extra);
  }
  const me = ctx.identity;
  const [sessions, memberships, agents, tokens, runs, consents, grants] = await Promise.all([
    listSessions(ctx.db, me.id, ctx.now),
    listMembershipsForIdentity(ctx.db, me.id),
    listAgentsForOperator(ctx.db, me.id),
    listApiTokensForOperator(ctx.db, me.id, ctx.now),
    listAgentRunsForOperator(ctx.db, me.id, ctx.now),
    listConsent(ctx.db, me.email),
    listLiveGrantsForIdentity(ctx.db, me.id, ctx.now),
  ]);
  const creatable = me.is_root === 1
    ? (await listTenants(ctx.db, "active")).map((t) => t.slug)
    : memberships.filter((m) => rank(m.membership.role) >= rank("member")).map((m) => m.tenant.slug);

  let body = `<h1>Your account</h1><p>${esc(me.display_name)} &lt;${esc(me.email)}&gt; · <a href="/">hub</a> · ${logout("/")}</p>`;

  body += `<h2>Sessions</h2>` + table(["Id", "Kind", "Started", "Last seen", ""], sessions.map((s) => [
    `${esc(s.id)}${s.id === ctx.session!.id ? " (this one)" : ""}`, esc(s.kind) + (s.kind === "git" && s.label ? ` (${esc(s.label)})` : ""), when(s.created_at), when(s.last_seen_at),
    button("session.revoke", { session_id: s.id }, "Revoke"),
  ])) + `<form method="post" action="/api/session.end"><button type="submit">Sign out</button></form>`;

  const gitTenants = me.is_root === 1 ? (await listTenants(ctx.db, "active")).map((t) => t.slug) : memberships.map((m) => m.tenant.slug);
  body += `<h2>Git credentials</h2><p>A password for <code>git clone https://&lt;tenant&gt;.${esc(env.HUB_DOMAIN)}/&lt;repo&gt;.git</code>, with your email as the username. It works only for git on that tenant, lasts 90 days, and is listed under Sessions as <code>git</code>.</p>`
    + (gitTenants.length === 0 ? "<p>You are not a member of any tenant.</p>" : gitTenants.map((slug) =>
      `<form method="post" action="/api/session.git"><input type="hidden" name="tenant" value="${esc(slug)}">`
      + `<label>Label <input name="label" required maxlength="80" placeholder="laptop"></label> `
      + `<button type="submit">New git credential for ${esc(slug)}</button></form>`).join(""));

  body += `<h2>Assistants</h2><p>Assistants you connected. Each acts as you in one tenant; its activity is listed by <code>event.list</code> with its session id.</p>`
    + (memberships.length ? `<p>Connect ChatGPT or Claude as yourself: ${memberships.map(({ tenant }) => `<a href="https://${esc(tenant.slug)}.${esc(env.HUB_DOMAIN)}/assistant/connect">${esc(tenant.display_name)}</a>`).join(" · ")}. Review the identity and consent in the setup guide.</p>` : `<p>To connect a human assistant, first sign in with an identity that has active organization access.</p>`)
    + table(["Assistant", "Sends codes to", "Tenant", "Scopes", "Connected", "Last used", "Session", ""], grants.map(({ grant, tenant_slug, last_seen_at }) => [
      `"${esc(grant.client_name)}"`, `<code>${esc(grant.redirect_host)}</code>`, esc(tenant_slug), esc(grant.scopes), when(grant.created_at), when(last_seen_at),
      `<code>${esc(grant.session_id)}</code>`, button("session.revoke", { session_id: grant.session_id }, "Revoke"),
    ]));

  body += `<h2>Agents you operate</h2>` + table(["Address", "Name", "Tenant", "Role", "Created", ""], agents.map((a) => [
    `<code>${esc(a.identity.email)}</code>`, esc(a.identity.display_name), esc(a.tenant.slug), esc(a.membership.role), when(a.identity.created_at),
    `<form class="inline" method="post" action="/api/token.create"><input type="hidden" name="agent_id" value="${esc(a.identity.id)}"><input name="name" placeholder="token name" required maxlength="80"><button type="submit">New token</button></form> `
      + button("agent.archive", { agent_id: a.identity.id }, "Archive"),
  ]));

  body += `<h2>New agent</h2>` + (creatable.length === 0 ? "<p>You cannot create agents in any tenant.</p>" : creatable.map((slug) =>
    `<form method="post" action="/api/agent.create"><input type="hidden" name="tenant" value="${esc(slug)}">${BACK}`
    + `<label>Slug <input name="slug" required maxlength="63" pattern="[a-z0-9-]+"></label> `
    + `<label>Name <input name="display_name" required maxlength="80"></label> `
    + `<button type="submit">Create agent in ${esc(slug)}</button></form>`).join(""));

  body += `<h2>Tokens</h2>` + table(["Name", "Agent", "Tenant", "Created", "Last used", "Expires", ""], tokens.map((t) => [
    esc(t.token.name), `<code>${esc(t.agent_email)}</code>`, esc(t.tenant_slug), when(t.token.created_at), when(t.token.last_used_at),
    when(t.token.expires_at), button("token.revoke", { token_id: t.token.id }, "Revoke"),
  ]));

  body += `<h2>Agent runs</h2>` + table(["Label", "Agent", "Tenant", "Started", "Expires", ""], runs.map((r) => [
    esc(r.session.label ?? ""), `<code>${esc(r.agent_email)}</code>`, esc(r.tenant_slug), when(r.session.created_at), when(r.session.expires_at),
    button("session.revoke", { session_id: r.session.id }, "Revoke"),
  ]));

  const active = consents.some((c) => c.revoked_at === null);
  body += `<h2>Mail consent</h2><p>The hub emails ${esc(me.email)} only while consent is active.</p>`
    + table(["Kind", "Granted", "Revoked"], consents.map((c) => [esc(c.kind), when(c.granted_at), c.revoked_at === null ? "" : when(c.revoked_at)]))
    + (active ? button("consent.revoke", {}, "Stop emails to this address") : `<p>To allow sign-in links by email, write to login@${esc(env.HUB_DOMAIN)} from this address.</p>`);

  return htmlResponse(page("Your account", body, shellFor(ctx, env, "account")), 200, extra);
}
