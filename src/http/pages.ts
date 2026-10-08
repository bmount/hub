import { sameOrigin } from "./login";
import type { Env } from "../env";
import { shellFor } from "./shell";
import { orgHomePage } from "./orgPages";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { acceptInvite, findInviteByToken, inviteIsOpen, setInviteAcceptedSession } from "../db/invites";
import { recordProof } from "../db/proofs";
import { getTenantById, listTenants } from "../db/tenants";
import { createBrowserSession, listSessions } from "../db/sessions";
import { clearSessionCookie, sessionCookie } from "../auth/cookie";
import { buildContext, rank } from "../auth/context";
import { recordEvent } from "../db/events";
import { listMembershipsForIdentity } from "../db/memberships";
import { listNamespaces } from "../db/namespaces";
import { listProjects } from "../db/projects";
import type { State } from "../db/types";
import intro from "../../site/index.html";
import { intentBox } from "../intent/page";

export function neutralInvitePage(): string {
  return page("Invite", `<h1>This invite link is not valid</h1><p>It may have expired, been used already, or been revoked. Ask the person who invited you for a new link.</p>`);
}

export function notFoundPage(headers?: HeadersInit): Response {
  return htmlResponse(page("Not found", `<h1>Not found</h1>`), 404, headers);
}

function tokenFromPath(request: Request): string | null {
  const m = new URL(request.url).pathname.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  return m ? m[1]! : null;
}

export async function invitePage(request: Request, env: Env): Promise<Response> {
  if (classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind !== "apex") return notFoundPage();
  const token = tokenFromPath(request);
  const now = Date.now();
  const invite = token ? await findInviteByToken(env.HUB_DB, token) : null;
  if (!invite || !inviteIsOpen(invite, now)) return htmlResponse(neutralInvitePage());
  const tenant = invite.tenant_id ? await getTenantById(env.HUB_DB, invite.tenant_id) : null;
  if (invite.tenant_id && (!tenant || tenant.state !== "active")) return htmlResponse(neutralInvitePage());
  const target = tenant ? `<strong>${esc(tenant.display_name)}</strong> as ${esc(invite.role)}` : `the hub as <strong>root</strong>`;
  const body = `<h1>You're invited</h1>
<p>Join ${target} with the address <strong>${esc(invite.email)}</strong>.</p>
<form method="post" action="/invite/${esc(token!)}"><button type="submit">Accept and sign in</button></form>`;
  return htmlResponse(page("Invite", body));
}

export async function acceptInvitePage(request: Request, env: Env): Promise<Response> {
  if (classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind !== "apex") return notFoundPage();
  if (!sameOrigin(request)) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  const token = tokenFromPath(request);
  const now = Date.now();
  const invite = token ? await findInviteByToken(env.HUB_DB, token) : null;
  if (!invite) return htmlResponse(neutralInvitePage());
  if (invite.tenant_id) {
    const tenant = await getTenantById(env.HUB_DB, invite.tenant_id);
    if (!tenant || tenant.state !== "active") return htmlResponse(neutralInvitePage());
  }
  const accepted = await acceptInvite(env.HUB_DB, invite, now);
  if (!accepted) return htmlResponse(neutralInvitePage());
  await recordProof(env.HUB_DB, { identity_id: accepted.identity.id, kind: "email", subject: accepted.identity.email }, now);
  let tenantRow: Awaited<ReturnType<typeof getTenantById>> = null;
  if (invite.tenant_id) tenantRow = await getTenantById(env.HUB_DB, invite.tenant_id);
  const location = tenantRow ? `https://${tenantRow.slug}.${env.HUB_DOMAIN}/` : `https://${env.HUB_DOMAIN}/`;

  if (!accepted.created) {
    // Never mint a session for a pre-existing identity.
    const ctx = await buildContext(request, env, now);
    const sameIdentity = ctx.identity !== null && ctx.identity.id === accepted.identity.id;
    const sid = sameIdentity ? ctx.session?.id ?? null : null;
    if (sid) await setInviteAcceptedSession(env.HUB_DB, invite.id, sid);
    await recordEvent(env.HUB_DB, {
      tenant_id: invite.tenant_id, identity_id: accepted.identity.id, session_id: sid, kind: "invite.accept", target_kind: "invite", target_id: invite.id,
      summary: `${accepted.identity.email} accepted invite as ${invite.role}`,
    }, now);
    if (sameIdentity) return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
    const where = tenantRow ? esc(tenantRow.display_name) : "the hub";
    if (!accepted.membershipAdded) {
      return htmlResponse(page("Already a member", `<h1>Already a member</h1><p>Your account <strong>${esc(accepted.identity.email)}</strong> already has access to <strong>${where}</strong>. Sign in with your existing session to continue.</p>`));
    }
    return htmlResponse(page("Added", `<h1>You have been added</h1><p>Your account <strong>${esc(accepted.identity.email)}</strong> now has access to <strong>${where}</strong>. Sign in with your existing session to continue.</p>`));
  }

  const { session, token: sessionToken } = await createBrowserSession(env.HUB_DB, accepted.identity.id, now);
  await setInviteAcceptedSession(env.HUB_DB, invite.id, session.id);
  await recordEvent(env.HUB_DB, {
    tenant_id: invite.tenant_id, identity_id: accepted.identity.id, session_id: session.id, kind: "invite.accept", target_kind: "invite", target_id: invite.id,
    summary: `${accepted.identity.email} accepted invite as ${invite.role}`,
  }, now);
  return new Response(null, { status: 303, headers: { location, "set-cookie": sessionCookie(sessionToken, env.HUB_DOMAIN), "cache-control": "no-store" } });
}

export async function sessionsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex") return notFoundPage(extra);
  if (!ctx.identity || !ctx.session) return htmlResponse(page("Sign in", `<h1>Sign in required</h1>`), 401, extra);
  const rows = await listSessions(env.HUB_DB, ctx.identity.id, ctx.now);
  const tr = rows.map((s) => `<tr>
<td>${esc(s.id)}${s.id === ctx.session!.id ? " (this one)" : ""}</td>
<td>${esc(s.kind)}</td>
<td>${new Date(s.created_at).toISOString()}</td>
<td>${new Date(s.last_seen_at).toISOString()}</td>
<td><form class="inline" method="post" action="/api/session.revoke"><input type="hidden" name="session_id" value="${esc(s.id)}"><button type="submit">Revoke</button></form></td>
</tr>`).join("");
  const body = `<h1>Your sessions</h1>
<p>${esc(ctx.identity.display_name)} &lt;${esc(ctx.identity.email)}&gt;</p>
<table><thead><tr><th>Id</th><th>Kind</th><th>Started</th><th>Last seen</th><th></th></tr></thead><tbody>${tr}</tbody></table>
<form method="post" action="/api/session.end"><button type="submit">Sign out</button></form>`;
  return htmlResponse(page("Sessions", body, shellFor(ctx, env, "hub", "sessions")), 200, extra);
}

function listSection(title: string, items: string[]): string {
  return `<h2>${esc(title)}</h2>` + (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p>None.</p>`);
}

async function tenantListing(env: Env, tenant_id: string, state: State): Promise<string> {
  const namespaces = await listNamespaces(env.HUB_DB, tenant_id, state);
  const all = new Map([...namespaces, ...(await listNamespaces(env.HUB_DB, tenant_id, state === "active" ? "archived" : "active"))].map((n) => [n.id, n]));
  const projects = await listProjects(env.HUB_DB, tenant_id, state);
  const paths = projects.map((p) => (p.namespace_id ? `${all.get(p.namespace_id)?.slug ?? "?"}/${p.slug}` : p.slug)).sort();
  return listSection("Namespaces", namespaces.map((n) => esc(n.slug))) + listSection("Projects", paths.map((p) => `<code>${esc(p)}</code>`));
}

/** How to bring an agent in: steps on the home page, with a direct link to each organization's connect form. */
function setupCard(env: Env, orgs: Array<{ slug: string; name: string }>): string {
  const connect = (o: { slug: string; name: string }) => `<a href="https://${esc(o.slug)}.${esc(env.HUB_DOMAIN)}/people?connect=1" data-reload>${orgs.length > 1 ? esc(o.name) : "Connect an agent"}</a>`;
  const where = orgs.length === 0 ? "In your organization, open People and agents → Connect an agent"
    : orgs.length === 1 ? `Make a connect link: ${connect(orgs[0]!)}` : `Make a connect link in ${orgs.map(connect).join(", ")}`;
  return `<div class="card"><h3>Set up with your agent</h3>
<p>For Claude Code, Codex or any agent in a terminal or on a server:</p>
<ol>
<li>${where}. Name the agent; you get a link that works once, for 24 hours.</li>
<li>Paste the link to your agent and say: <b>"set up pimwell.com with this link"</b>.</li>
<li>The agent claims the link, connects with its own key, and follows <a href="/setup" data-reload>${esc(env.HUB_DOMAIN)}/setup</a>: it reports its AI usage and wires your apps' errors and deploys in.</li>
</ol>
<p class="lede">The agent answers to you and can do what you can, up to a member's rights. For Claude or ChatGPT in a browser or on your phone, add a custom connector instead, with <code>https://&lt;org&gt;.${esc(env.HUB_DOMAIN)}/mcp</code>.</p></div>`;
}

export async function homePage(request: Request, env: Env): Promise<Response> {
  if (classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind === "tenant") return orgHomePage(request, env);
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind === "apex") {
    if (!ctx.identity) return htmlResponse(intro, 200, extra);
    const memberships = (await listMembershipsForIdentity(env.HUB_DB, ctx.identity.id)).filter((m) => m.tenant.state === "active" && m.membership.state === "active");
    const card = (slug: string, name: string, note: string) => `<a class="card big" href="https://${esc(slug)}.${esc(env.HUB_DOMAIN)}/" data-reload><h3>${esc(name)}</h3><p>${esc(note)}</p><p><code>${esc(slug)}.${esc(env.HUB_DOMAIN)}</code></p></a>`;
    let body = `<h1>Hello, ${esc(ctx.identity.display_name)}</h1>
${intentBox({ placeholder: "What do you want to do? Say it or type it" })}
<p class="lede">AI can do a lot. Ask here, pick an organization below, or ask from Claude or ChatGPT over MCP.</p>
${setupCard(env, memberships.filter((m) => m.membership.role !== "reader" || ctx.identity!.is_root === 1).map((m) => ({ slug: m.tenant.slug, name: m.tenant.display_name })))}`;
    body += `<h2>Your organizations</h2>` + (memberships.length ? `<div class="grid">${memberships.map((m) => card(m.tenant.slug, m.tenant.display_name, `You are ${m.membership.role}`)).join("")}</div>` : `<p class="lede">None yet. Ask whoever invited you to add you to an organization.</p>`);
    if (ctx.identity.is_root === 1) {
      const mine = new Set(memberships.map((m) => m.tenant.id));
      const others = (await listTenants(env.HUB_DB, "active")).filter((t) => !mine.has(t.id));
      if (others.length) body += `<h2>Other organizations</h2><div class="grid">${others.map((t) => card(t.slug, t.display_name, "You see this as root")).join("")}</div>`;
      body += `<h2>Hub administration</h2><p><a href="/admin/orgs">Organizations</a> · <a href="/admin/models">Models and keys</a></p>`;
    }
    return htmlResponse(page("Pimwell", body, shellFor(ctx, env, "home", "apex")), 200, extra);
  }
  if (!ctx.tenant || !ctx.role) return notFoundPage(extra);
  const agentsLink = rank(ctx.role) >= rank("admin") ? ` · <a href="/admin/agents">agents</a>` : "";
  const body = `<h1>${esc(ctx.tenant.display_name)}</h1><p>You are ${esc(ctx.role)} · <a href="/c">channels</a> · <a href="/inbox">inbox</a> · <a href="/archive">archive</a>${agentsLink} · <a href="https://${esc(env.HUB_DOMAIN)}/">hub</a></p>` + (await tenantListing(env, ctx.tenant.id, "active"));
  return htmlResponse(page(ctx.tenant.display_name, body), 200, extra);
}

export async function archivePage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "tenant" || !ctx.tenant || !ctx.role) return notFoundPage(extra);
  const body = `<p class="crumbs"><a href="/">${esc(ctx.tenant.display_name)}</a> /</p><h1>Archive</h1><p class="lede">Finished work, kept. Nothing here was thrown away.</p>` + (await tenantListing(env, ctx.tenant.id, "archived"));
  return htmlResponse(page("Archive", body, shellFor(ctx, env, "home", "archive")), 200, extra);
}
