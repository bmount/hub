import { sameOrigin } from "./login";
import type { Env } from "../env";
import { shellFor } from "./shell";
import { orgHomePage } from "./orgPages";
import { localTime, esc, organizationCard, htmlResponse, inspectorSection, kitTable, page, toolbar, workbench } from "../html";
import { classifyHost } from "../tenant";
import { findInviteByToken, inviteIsOpen } from "../db/invites";
import { getTenantById, listTenants } from "../db/tenants";
import { listSessions } from "../db/sessions";
import { clearSessionCookie } from "../auth/cookie";
import { buildContext, rank } from "../auth/context";
import { listMembershipsForIdentity } from "../db/memberships";
import { listNamespaces } from "../db/namespaces";
import { listProjects } from "../db/projects";
import { projectControls } from "./projectControls";
import type { State } from "../db/types";
import { LANDING_HTML } from "../assets";
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
  const next = tenant ? `?next=${encodeURIComponent(tenant.slug)}` : "";
  const configured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const body = `<h1>Verify your invited address</h1>
<p>Join ${target} with the address <strong>${esc(invite.email)}</strong>.</p>
<p>Google sign-in uses the account you choose and replaces any current sign-in in this browser across Pimwell organizations. Choose the invited address, even if your accounts have the same display name.</p>
<p>This link is an invitation, not proof that you control this address. Existing sign-ins and old invite-derived proofs cannot accept it. Sign in with Google using the exact invited address; a verified matching account accepts open invitations.</p>
${configured ? `<p><a class="button" href="/login/google${esc(next)}">Verify with Google and sign in</a></p>` : `<p>Independent address verification is unavailable: Google sign-in is not configured. Nothing has been granted. Ask the inviter to wait until verification is available.</p>`}
<p>Without a matching verified Google account, this invitation stays unaccepted. Email-only onboarding for new invitations is not available yet.</p>`;
  return htmlResponse(page("Invite", body));
}

export async function acceptInvitePage(request: Request, env: Env): Promise<Response> {
  if (classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind !== "apex") return notFoundPage();
  if (!sameOrigin(request)) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
  // Retain the old POST URL for bookmarked/previously rendered forms, but never
  // claim/grant/prove/sign in from a bearer invite or a legacy session. Only the
  // independent verified exact-address Google admission path can accept invites.
  return invitePage(request, env);
}

export async function sessionsPage(request: Request, env: Env): Promise<Response> {
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind !== "apex") return notFoundPage(extra);
  if (!ctx.identity || !ctx.session) return htmlResponse(page("Sign in", `<h1>Sign in required</h1>`), 401, extra);
  const rows = await listSessions(env.HUB_DB, ctx.identity.id, ctx.now);
  const selectedId = new URL(request.url).searchParams.get("session");
  const selected = rows.find(s=>s.id === selectedId);
  if (selectedId && !selected) return notFoundPage(extra);
  const list = `<h1>Your sessions</h1>
${toolbar("Session actions",'<a href="/me">Account</a>')}
${kitTable("Sessions",[{label:"Session"},{label:"Kind"},{label:"Started"},{label:"Last seen"}],rows.map(s=>({href:`/me/sessions?session=${encodeURIComponent(s.id)}`,selected:s.id === selectedId,cells:[{html:`<a href="/me/sessions?session=${esc(encodeURIComponent(s.id))}">${esc(s.label ?? s.kind)}${s.id === ctx.session!.id ? " (this one)" : ""}</a>`},{html:esc(s.kind)},{html:localTime(s.created_at)},{html:localTime(s.last_seen_at)}]}))) }`;
  const inspector = selected ? `<a class="back" href="/me/sessions">‹ Sessions</a><h1>${esc(selected.label ?? selected.kind)}</h1>
${inspectorSection("Session",[{label:"Kind",html:esc(selected.kind)},{label:"Started",html:localTime(selected.created_at)},{label:"Last seen",html:localTime(selected.last_seen_at)}])}
<form method="post" action="/api/session.revoke"><input type="hidden" name="session_id" value="${esc(selected.id)}"><input type="hidden" name="_back" value="/me/sessions"><button type="submit" class="quiet destructive">Revoke</button></form>` : null;
  return htmlResponse(workbench("Sessions",{list,listKey:"sessions",inspector,inspectorKey:selected ? `session:${selected.id}:${selected.last_seen_at}` : "",stackOnPhone:true},shellFor(ctx,env,"hub","sessions")!),200,extra);
}

function listSection(title: string, items: string[]): string {
  return `<h2>${esc(title)}</h2>` + (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p>None.</p>`);
}

async function tenantListing(env: Env, tenant_id: string, state: State, admin = false): Promise<string> {
  const namespaces = await listNamespaces(env.HUB_DB, tenant_id, state);
  const all = new Map([...namespaces, ...(await listNamespaces(env.HUB_DB, tenant_id, state === "active" ? "archived" : "active"))].map((n) => [n.id, n]));
  const projects = await listProjects(env.HUB_DB, tenant_id, state);
  const rows = projects.map(p => {
    const namespace = p.namespace_id ? all.get(p.namespace_id)?.slug ?? null : null;
    const path = namespace ? `${namespace}/${p.slug}` : p.slug;
    return `<code>${esc(path)}</code>${admin ? projectControls({ slug: p.slug, namespace }, state === "archived") : ""}`;
  });
  return listSection("Namespaces", namespaces.map((n) => esc(n.slug))) + listSection("Projects", rows);
}

/** How to bring an agent in: steps on the home page, with a direct link to each organization's connect form. */
function setupCard(env: Env, orgs: Array<{ slug: string; name: string }>): string {
  const connect = (o: { slug: string; name: string }) => `<a href="https://${esc(o.slug)}.${esc(env.HUB_DOMAIN)}/people?connect=1" data-reload>${orgs.length > 1 ? esc(o.name) : "Connect an agent"}</a>`;
  const where = orgs.length === 0 ? "In your organization, open People and agents → Connect an agent"
    : orgs.length === 1 ? `Make a connect link: ${connect(orgs[0]!)}` : `Make a connect link in ${orgs.map(connect).join(", ")}`;
  return `<section class="landing-setup"><h2>Set up with your agent</h2>
<p>For Claude Code, Codex or any agent in a terminal or on a server:</p>
<ol>
<li>${where}. Name the agent; you get a link that works once, for 24 hours.</li>
<li>Paste the link to your agent and say: <b>"set up pimwell.com with this link"</b>.</li>
<li>The agent claims the link, connects with its own key, and follows <a href="/setup" data-reload>${esc(env.HUB_DOMAIN)}/setup</a>: it reports its AI usage and wires your apps' errors and deploys in.</li>
</ol>
<p class="lede">The agent answers to you and can do what you can, up to a member's rights. For Claude or ChatGPT in a browser or on your phone, add a custom connector instead, with <code>https://&lt;org&gt;.${esc(env.HUB_DOMAIN)}/mcp</code>.</p></section>`;
}

export async function homePage(request: Request, env: Env): Promise<Response> {
  if (classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN).kind === "tenant") return orgHomePage(request, env);
  const ctx = await buildContext(request, env);
  const extra: Record<string, string> = ctx.staleCookie ? { "set-cookie": clearSessionCookie(env.HUB_DOMAIN) } : {};
  if (ctx.host.kind === "apex") {
    const createForm = `<section><h2>New organization</h2><form data-reload method="post" action="/api/tenant.create"><label>Organization slug <input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="63" required></label><label>Display name <input name="display_name" maxlength="80" required></label><button type="submit" class="primary">Create organization</button></form></section>`;
    if (!ctx.identity) return htmlResponse(LANDING_HTML.replace("</body>", `${createForm}</body>`), 200, extra);
    const allMemberships = await listMembershipsForIdentity(env.HUB_DB, ctx.identity.id, true);
    const memberships = allMemberships.filter((m) => m.tenant.state === "active" && m.membership.state === "active");
    const card = (slug: string, name: string, role: string) => organizationCard({ slug, name, role }, env.HUB_DOMAIN);
    let body = `<div class="landing"><header class="landing-hero"><h1>Hello, ${esc(ctx.identity.display_name)}</h1>
<p class="lede">What would you like to move forward? Ask here or open your team's organization.</p>
${intentBox({ placeholder: "What do you want to do? Say it or type it" })}</header>`;
    body += `<section aria-labelledby="your-orgs"><div class="landing-heading"><h2 id="your-orgs">All organizations</h2></div>` + (memberships.length ? `<div class="wb-org-grid">${memberships.map((m) => card(m.tenant.slug, m.tenant.display_name, m.membership.role)).join("")}</div>` : `<p class="lede">None yet. Create an organization or accept an invitation.</p>`);
    if (ctx.identity.kind === "human") body += `<details class="landing-create"><summary role="button">New organization</summary>${createForm}</details>`;
    body += `</section>`;
    if (memberships.length) body += `<section aria-label="Organization chat"><h2>Chat with your team</h2><p class="chips">${memberships.map((m) => `<a class="chip" href="https://${esc(m.tenant.slug)}.${esc(env.HUB_DOMAIN)}/c" data-reload>${esc(m.tenant.display_name)} chat</a>`).join(" ")}</p></section>`;
    body += setupCard(env, memberships.filter((m) => m.membership.role !== "reader" || ctx.identity!.is_root === 1).map((m) => ({ slug: m.tenant.slug, name: m.tenant.display_name })));
    body += `<div class="landing-secondary">`;
    if (ctx.identity.kind === "human") {
      body += `<details><summary>Manage your organizations</summary>` + allMemberships.filter(m => m.membership.role === "admin" || ctx.identity!.is_root === 1).map(m => {
        const slug = esc(m.tenant.slug), archived = m.tenant.state === "archived";
        return `<section><h3>${esc(m.tenant.display_name)} (${slug})</h3><form data-reload method="post" action="/api/tenant.${archived ? "unarchive" : "archive"}"><input type="hidden" name="slug" value="${slug}"><button class="quiet${archived ? "" : " destructive"}">${archived ? "Unarchive" : "Archive"} organization</button></form>${archived ? `<form data-reload method="post" action="/api/tenant.delete"><input type="hidden" name="slug" value="${slug}"><label>Type ${slug} to delete permanently <input name="confirm" required autocomplete="off"></label><button class="quiet destructive">Delete permanently</button><p>This cannot be undone. All organization data and repositories will be removed.</p></form>` : ""}</section>`;
      }).join("") + `</details>`;
    }
    if (ctx.identity.is_root === 1) {
      const mine = new Set(memberships.map((m) => m.tenant.id));
      const others = (await listTenants(env.HUB_DB, "active")).filter((t) => !mine.has(t.id));
      if (others.length) body += `<h2>Other organizations</h2><div class="wb-org-grid">${others.map((t) => card(t.slug, t.display_name, "root")).join("")}</div>`;
      body += `<h2>Hub administration</h2><p><a href="/admin/orgs">Organizations</a> · <a href="/admin/models">Models and keys</a></p>`;
    }
    body += `</div></div>`;
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
  const body = `<p class="crumbs"><a href="/">${esc(ctx.tenant.display_name)}</a> /</p><h1>Archive</h1><p class="lede">Finished work, kept. Nothing here was thrown away.</p>` + (await tenantListing(env, ctx.tenant.id, "archived", rank(ctx.role) >= rank("admin") && ctx.identity?.kind === "human"));
  return htmlResponse(page("Archive", body, shellFor(ctx, env, "home", "archive")), 200, extra);
}
