import { defineVerb } from "./table";
import { listMembershipsForIdentity } from "../db/memberships";

export const whoami = defineVerb({
  name: "whoami",
  kind: "query",
  scope: "public",
  minRole: "public",
  freshProofMinutes: null,
  summary: "Describe the caller: identity, session, role on this tenant, and memberships.",
  parse: () => ({}),
  run: async (ctx) => {
    if (!ctx.identity || !ctx.session) return { identity: null };
    const memberships = await listMembershipsForIdentity(ctx.db, ctx.identity.id);
    return {
      identity: { id: ctx.identity.id, email: ctx.identity.email, display_name: ctx.identity.display_name, is_root: ctx.identity.is_root === 1, kind: ctx.identity.kind },
      session: { id: ctx.session.id, kind: ctx.session.kind, created_at: ctx.session.created_at, last_proof_at: ctx.session.last_proof_at },
      tenant: ctx.tenant && ctx.role !== null ? { id: ctx.tenant.id, slug: ctx.tenant.slug, role: ctx.role } : null,
      memberships: memberships.map((m) => ({ slug: m.tenant.slug, display_name: m.tenant.display_name, role: m.membership.role })),
    };
  },
});
