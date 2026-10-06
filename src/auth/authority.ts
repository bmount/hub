import { getMembership } from "../db/memberships";
import { getTenantBySlug } from "../db/tenants";
import { badRequest, notFound, unauthorized } from "../errors";
import { rank, roleFor, type Ctx } from "./context";
import type { Agent, Identity, Role, Session, Tenant } from "../db/types";

export function requireHuman(ctx: Ctx): { identity: Identity; session: Session } {
  if (!ctx.identity || !ctx.session) throw unauthorized();
  return { identity: ctx.identity, session: ctx.session };
}

/** The caller's role in a tenant named by a target, not by the host. */
export async function roleIn(ctx: Ctx, tenant_id: string): Promise<Role | null> {
  if (!ctx.identity) return null;
  if (ctx.tenant && ctx.tenant.id === tenant_id) return ctx.role;
  return roleFor(ctx.identity, await getMembership(ctx.db, ctx.identity.id, tenant_id));
}

/** Tenant from a slug parameter, else the host. Unknown, archived, or roleless: 404 like any hidden tenant (spec 5). */
export async function targetTenant(ctx: Ctx, slug: string | null): Promise<{ tenant: Tenant; role: Role }> {
  const s = slug?.trim().toLowerCase() || ctx.tenant?.slug || null;
  if (!s) throw badRequest("tenant is required");
  const tenant = ctx.tenant && ctx.tenant.slug === s ? ctx.tenant : await getTenantBySlug(ctx.db, s);
  if (!tenant || tenant.state !== "active") throw notFound("no such tenant");
  const role = await roleIn(ctx, tenant.id);
  if (role === null) throw notFound("no such tenant");
  return { tenant, role };
}

/** Operator (still at least a member there), that tenant's admin, or root. Anyone else: 404, as if the agent did not exist. */
export async function manageableAgent(ctx: Ctx, agent: Agent | null): Promise<Agent> {
  if (!agent || agent.tenant.state !== "active" || !ctx.identity) throw notFound("no such agent");
  const role = await roleIn(ctx, agent.tenant.id);
  if (rank(role) >= rank("admin")) return agent;
  if (agent.identity.operator_id === ctx.identity.id && rank(role) >= rank("member")) return agent;
  throw notFound("no such agent");
}
