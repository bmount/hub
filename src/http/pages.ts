import type { Env } from "../env";
import { esc, htmlResponse, page } from "../html";
import { classifyHost } from "../tenant";
import { acceptInvite, findInviteByToken, inviteIsOpen, setInviteAcceptedSession } from "../db/invites";
import { getTenantById } from "../db/tenants";
import { createBrowserSession } from "../db/sessions";
import { sessionCookie } from "../auth/cookie";
import { recordEvent } from "../db/events";

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
  const { session, token: sessionToken } = await createBrowserSession(env.HUB_DB, accepted.identity.id, now);
  await setInviteAcceptedSession(env.HUB_DB, invite.id, session.id);
  await recordEvent(env.HUB_DB, {
    tenant_id: invite.tenant_id, identity_id: accepted.identity.id, session_id: session.id, kind: "invite.accept", target_kind: "invite", target_id: invite.id,
    summary: `${accepted.identity.email} accepted invite as ${invite.role}`,
  }, now);
  let location = `https://${env.HUB_DOMAIN}/`;
  if (invite.tenant_id) {
    const tenant = await getTenantById(env.HUB_DB, invite.tenant_id);
    location = `https://${tenant!.slug}.${env.HUB_DOMAIN}/`;
  }
  return new Response(null, { status: 303, headers: { location, "set-cookie": sessionCookie(sessionToken, env.HUB_DOMAIN), "cache-control": "no-store" } });
}
