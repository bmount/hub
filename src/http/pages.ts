import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { acceptInvite, findInviteByToken, inviteIsOpen, setInviteAcceptedSession } from "../db/invites";
import { getTenantById } from "../db/tenants";
import { createBrowserSession } from "../db/sessions";
import { sessionCookie } from "../auth/cookie";
import { buildContext } from "../auth/context";
import { recordEvent } from "../db/events";
import { listSessions } from "../db/sessions";

export function neutralInvitePage(): string {
  return page("Invite", `<h1>This invite link is not valid</h1><p>It may have expired, been used already, or been revoked. Ask the person who invited you for a new link.</p>`);
}

export function notFoundPage(): Response {
  return htmlResponse(page("Not found", `<h1>Not found</h1>`), 404);
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
  const url = new URL(request.url);
  if (request.headers.get("origin") !== `${url.protocol}//${url.host}`) return htmlResponse(page("Forbidden", `<h1>Forbidden</h1>`), 403);
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
  if (ctx.host.kind !== "apex") return notFoundPage();
  if (!ctx.identity || !ctx.session) return htmlResponse(page("Sign in", `<h1>Sign in required</h1>`), 401);
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
  return htmlResponse(page("Sessions", body));
}
