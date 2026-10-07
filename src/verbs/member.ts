// People management for admins (owner, 2026-10-07): change a person's role, or remove them from the organization.
// Same rules as invites: admins manage members and readers; only a root grants or takes away admin. Removal archives
// the membership, which ends their role here and every assistant connection they made to this organization at once
// (roleFor and liveGrant both require an active membership). Helpers are managed on their own page.
import { defineVerb } from "./table";
import { reqEnum, reqString } from "./params";
import { badRequest, forbidden, notFound } from "../errors";
import { recordEvent } from "../db/events";
import type { Ctx } from "../auth/context";

type Target = { identity_id: string; email: string; display_name: string; kind: string; is_root: number; role: string; state: string };

async function target(ctx: Ctx, email: string): Promise<Target> {
  const t = await ctx.db.prepare(
    `SELECT i.id AS identity_id, i.email, i.display_name, i.kind, i.is_root, m.role, m.state FROM identity i JOIN membership m ON m.identity_id = i.id
     WHERE m.tenant_id = ? AND i.email = ?`,
  ).bind(ctx.tenant!.id, email.trim().toLowerCase()).first<Target>();
  if (!t || t.state !== "active") throw notFound("no such member here");
  if (t.kind !== "human") throw badRequest("helpers are managed on the Helpers page");
  if (t.identity_id === ctx.identity!.id) throw badRequest("ask another admin to change your own membership");
  return t;
}

/** Admins manage members and readers; only a root touches admin. */
function mayManage(ctx: Ctx, from: string, to: string | null): void {
  const root = ctx.identity!.is_root === 1;
  if (!root && (from === "admin" || to === "admin")) throw forbidden("only a root may grant or take away admin");
}

export const memberSetRole = defineVerb({
  name: "member.set_role", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, humanOnly: true,
  summary: "Change a person's role in this organization: admin, member, or reader.",
  parse: (i) => ({ email: reqString(i, "email", { max: 254 }), role: reqEnum(i, "role", ["admin", "member", "reader"] as const) }),
  run: async (ctx, p) => {
    const t = await target(ctx, p.email);
    if (t.role === p.role) return { email: t.email, role: p.role, changed: false };
    mayManage(ctx, t.role, p.role);
    await ctx.db.prepare("UPDATE membership SET role = ? WHERE identity_id = ? AND tenant_id = ?").bind(p.role, t.identity_id, ctx.tenant!.id).run();
    await recordEvent(ctx.db, {
      tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "member.set_role",
      target_kind: "identity", target_id: t.identity_id, summary: `Changed ${t.display_name} <${t.email}> from ${t.role} to ${p.role}`,
    }, ctx.now);
    return { email: t.email, role: p.role, changed: true };
  },
});

export const memberRemove = defineVerb({
  name: "member.remove", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, humanOnly: true,
  summary: "Remove a person from this organization. Their history stays; their access and assistant connections here end. Type their email in confirm.",
  parse: (i) => ({ email: reqString(i, "email", { max: 254 }), confirm: reqString(i, "confirm", { max: 254 }) }),
  run: async (ctx, p) => {
    if (p.confirm.trim().toLowerCase() !== p.email.trim().toLowerCase()) throw badRequest("type their email to confirm");
    const t = await target(ctx, p.email);
    mayManage(ctx, t.role, null);
    await ctx.db.batch([
      ctx.db.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(t.identity_id, ctx.tenant!.id),
      ctx.db.prepare("UPDATE work_item SET owner_id = NULL, lease_until = NULL WHERE tenant_id = ? AND owner_id = ? AND state IN ('open', 'doing')").bind(ctx.tenant!.id, t.identity_id),
    ]);
    await recordEvent(ctx.db, {
      tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "member.remove",
      target_kind: "identity", target_id: t.identity_id, summary: `Removed ${t.display_name} <${t.email}> (was ${t.role}); their open work is unassigned`,
    }, ctx.now);
    return { email: t.email, removed: true };
  },
});
