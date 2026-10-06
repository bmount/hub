import { defineVerb } from "./table";
import { listMembershipsForIdentity } from "../db/memberships";

export const whoami = defineVerb({
  name: "whoami",
  kind: "query",
  scope: "public",
  minRole: "public",
  freshProofMinutes: null,
  longLivedToken: true,
  summary: "Describe the caller: identity, session or long-lived token, role on this tenant, and memberships.",
  mcp: { scope: "read", destructive: false, title: "Who am I", input: { type: "object", properties: {}, additionalProperties: false } },
  parse: () => ({}),
  run: async (ctx) => {
    if (!ctx.identity) return { identity: null };
    const all = await listMembershipsForIdentity(ctx.db, ctx.identity.id);
    // An assistant connection is bound to one tenant; it does not learn the human's other tenants.
    const memberships = ctx.oauth ? all.filter((m) => m.tenant.id === ctx.tenant?.id) : all;
    const s = ctx.session;
    return {
      identity: {
        id: ctx.identity.id, email: ctx.identity.email, display_name: ctx.identity.display_name, is_root: ctx.identity.is_root === 1,
        kind: ctx.identity.kind, operator_id: ctx.identity.operator_id,
      },
      session: s ? { id: s.id, kind: s.kind, label: s.label, created_at: s.created_at, expires_at: s.expires_at, last_proof_at: s.last_proof_at } : null,
      token: ctx.apiToken ? { id: ctx.apiToken.id, name: ctx.apiToken.name } : null,
      tenant: ctx.tenant && ctx.role !== null ? { id: ctx.tenant.id, slug: ctx.tenant.slug, role: ctx.role } : null,
      memberships: memberships.map((m) => ({ slug: m.tenant.slug, display_name: m.tenant.display_name, role: m.membership.role })),
      ...(ctx.oauth ? { connection: { client: ctx.oauth.client_name, scopes: ctx.oauth.scopes } } : {}),
    };
  },
});
