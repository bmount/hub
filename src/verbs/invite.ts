import { esc } from "../html";
import { defineVerb } from "./table";
import { optString, reqEnum, reqString } from "./params";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { isAgentDomainAddress } from "../db/agents";
import { getIdentityByEmail } from "../db/identities";
import { getMembership } from "../db/memberships";
import { createInvite, inviteIsOpen, listInvites, revokeInvite } from "../db/invites";
import { recordEvent } from "../db/events";
import type { Invite } from "../db/types";

function status(i: Invite, now: number): "open" | "accepted" | "revoked" | "expired" {
  if (i.accepted_at !== null) return "accepted";
  if (i.revoked_at !== null) return "revoked";
  if (i.expires_at <= now) return "expired";
  return "open";
}

export const inviteCreate = defineVerb({
  name: "invite.create", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60,
  renderForm: (r) => {
    const x = r as { invite_url: string; expires_at: number; email?: string };
    return `<h1>Invite ready</h1><p class="lede">Send this link yourself. It works once, until ${new Date(x.expires_at).toISOString().slice(0, 10)}, and is not shown again.</p>
<p><input readonly value="${esc(x.invite_url)}" style="width:100%" onfocus="this.select()" aria-label="Invite link"></p>
<p>Or they can simply sign in with Google at pimwell.com using the invited address; the invite is accepted on the way in.</p>
<p><a href="/people">Back to people</a></p>`;
  },
  summary: "Create a single-use invite link for an email. The link is returned once and never emailed.",
  parse: (i) => ({
    email: reqString(i, "email", { max: 254 }),
    role: reqEnum(i, "role", ["admin", "member", "reader"] as const),
    display_name: optString(i, "display_name", { max: 80 }),
  }),
  run: async (ctx, p) => {
    if (isAgentDomainAddress(p.email, ctx.env.HUB_DOMAIN)) throw badRequest("addresses under tenant domains are reserved for agents");
    if (p.role === "admin" && ctx.identity!.is_root !== 1) throw forbidden("only a root may invite admins");
    const existing = await getIdentityByEmail(ctx.db, p.email);
    if (existing) {
      const m = await getMembership(ctx.db, existing.id, ctx.tenant!.id);
      if (m && m.state === "active") throw conflict("already a member of this tenant");
    }
    const { invite, token } = await createInvite(ctx.db, { tenant_id: ctx.tenant!.id, email: p.email, role: p.role, display_name: p.display_name, created_by: ctx.identity!.id }, ctx.now);
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "invite.create", target_kind: "invite", target_id: invite.id, summary: `Invited ${invite.email} as ${invite.role}` }, ctx.now);
    return { invite_id: invite.id, invite_url: `https://${ctx.env.HUB_DOMAIN}/invite/${token}`, expires_at: invite.expires_at };
  },
});

export const inviteRevoke = defineVerb({
  name: "invite.revoke", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, summary: "Revoke an open invite.",
  parse: (i) => ({ invite_id: reqString(i, "invite_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const invite = await ctx.db.prepare("SELECT * FROM invite WHERE id = ? AND tenant_id = ?").bind(p.invite_id, ctx.tenant!.id).first<Invite>();
    if (!invite) throw notFound("no such invite");
    if (!inviteIsOpen(invite, ctx.now)) throw conflict(`invite is ${status(invite, ctx.now)}`);
    if (!(await revokeInvite(ctx.db, ctx.tenant!.id, invite.id, ctx.now))) throw conflict("invite is no longer open");
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session!.id, kind: "invite.revoke", target_kind: "invite", target_id: invite.id, summary: `Revoked invite for ${invite.email}` }, ctx.now);
    return { ok: true };
  },
});

export const inviteList = defineVerb({
  name: "invite.list", kind: "query", scope: "tenant", minRole: "admin", freshProofMinutes: null, summary: "List invites for this tenant.",
  parse: () => ({}),
  run: async (ctx) => ({
    invites: (await listInvites(ctx.db, ctx.tenant!.id)).map((i) => ({
      id: i.id, email: i.email, role: i.role, display_name: i.display_name, created_at: i.created_at, expires_at: i.expires_at, status: status(i, ctx.now),
    })),
  }),
});
