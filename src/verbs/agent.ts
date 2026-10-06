import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, conflict, forbidden } from "../errors";
import { archiveAgent, createAgent, getAgentById } from "../db/agents";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { getMembership } from "../db/memberships";
import { recordEvent } from "../db/events";
import { rank, roleFor } from "../auth/context";
import { manageableAgent, requireHuman, targetTenant } from "../auth/authority";
import type { Agent } from "../db/types";

export function agentView(a: Agent) {
  return {
    id: a.identity.id, slug: a.slug, address: a.identity.email, display_name: a.identity.display_name, tenant: a.tenant.slug,
    role: a.membership.role, operator_id: a.identity.operator_id, state: a.identity.state, created_at: a.identity.created_at,
  };
}

function agentRole(i: Record<string, unknown>): "member" | "reader" {
  const v = optString(i, "role", { max: 10 }) ?? "member";
  if (v !== "member" && v !== "reader") throw badRequest("role must be one of member, reader");
  return v;
}

export const agentCreate = defineVerb({
  name: "agent.create", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Create an agent in a tenant with the reserved address <slug>@<tenant>. You operate it unless an admin names another member.",
  parse: (i) => ({
    tenant: optString(i, "tenant", { max: 63 }),
    slug: reqString(i, "slug", { max: 63 }),
    display_name: reqString(i, "display_name", { max: 80 }),
    operator: optString(i, "operator", { max: 254 }),
    role: agentRole(i),
  }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const { tenant, role } = await targetTenant(ctx, p.tenant);
    if (rank(role) < rank("member")) throw forbidden("readers may not create agents");
    let operator = identity;
    if (p.operator && normalizeEmail(p.operator) !== identity.email) {
      if (rank(role) < rank("admin")) throw forbidden("only an admin may name another operator");
      const other = await getIdentityByEmail(ctx.db, p.operator);
      const m = other ? await getMembership(ctx.db, other.id, tenant.id) : null;
      if (!other || other.kind !== "human" || rank(roleFor(other, m)) < rank("member")) throw badRequest("operator must be a human member or admin of this tenant");
      operator = other;
    }
    const agent = await createAgent(ctx.db, { tenant, slug: p.slug, display_name: p.display_name, operator_id: operator.id, role: p.role, hubDomain: ctx.env.HUB_DOMAIN }, ctx.now);
    await recordEvent(ctx.db, {
      tenant_id: tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.create", target_kind: "identity", target_id: agent.identity.id,
      summary: `Created agent ${agent.identity.email} operated by ${operator.email}`,
    }, ctx.now);
    return { agent: agentView(agent) };
  },
});

export const agentArchive = defineVerb({
  name: "agent.archive", kind: "command", scope: "public", minRole: "public", freshProofMinutes: 60, humanOnly: true,
  summary: "Archive an agent you operate (admins: any agent in the tenant). Revokes all its tokens and sessions.",
  parse: (i) => ({ agent_id: reqString(i, "agent_id", { max: 26 }) }),
  run: async (ctx, p) => {
    const { identity, session } = requireHuman(ctx);
    const agent = await manageableAgent(ctx, await getAgentById(ctx.db, p.agent_id));
    if (agent.identity.state !== "active") throw conflict("agent already archived");
    const r = await archiveAgent(ctx.db, agent.identity.id, ctx.now);
    if (!r.archived) throw conflict("agent already archived");
    await recordEvent(ctx.db, {
      tenant_id: agent.tenant.id, identity_id: identity.id, session_id: session.id, kind: "agent.archive", target_kind: "identity", target_id: agent.identity.id,
      summary: `Archived agent ${agent.identity.email}; revoked ${r.tokens} token(s) and ${r.sessions} session(s)`,
    }, ctx.now);
    return { ok: true, tokens_revoked: r.tokens, sessions_revoked: r.sessions };
  },
});
