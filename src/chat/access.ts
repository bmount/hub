import { rank, type Ctx } from "../auth/context";
import { notFound, unauthorized } from "../errors";
import { getAgentBySlug } from "../db/agents";
import { agentConversationIds, getChannelBySlug, isAgentMember, listChannels, type ChannelRow } from "../db/chat";
import type { Agent, Identity, Role, Session, Tenant } from "../db/types";

/** Who is looking: a request's caller, or the principal Ardi asserts on /internal/backlinks. */
export type Viewer = { tenant: Tenant; identity: Identity; role: Role | null; session: Session | null };

export function viewerOf(ctx: Ctx): Viewer {
  if (!ctx.tenant || !ctx.identity) throw unauthorized();
  return { tenant: ctx.tenant, identity: ctx.identity, role: ctx.role, session: ctx.session };
}

/** Messaging spec 4.1, 4.7: every human with a role reads every channel; an agent only the channels it was added to. */
export async function canRead(db: D1Database, v: Viewer, ch: ChannelRow): Promise<boolean> {
  if (ch.tenant_id !== v.tenant.id || rank(v.role) < rank("reader")) return false;
  if (v.identity.kind === "human") return true;
  return isAgentMember(db, ch.tenant_id, ch.project_id, v.identity.id);
}

/** The channel by name if the caller may read it; otherwise 404, the same as a channel that does not exist. */
export async function readableChannel(ctx: Ctx, slug: string): Promise<ChannelRow> {
  const v = viewerOf(ctx);
  const ch = await getChannelBySlug(ctx.db, v.tenant.id, slug.replace(/^#/, ""));
  if (!ch || !(await canRead(ctx.db, v, ch))) throw notFound("no such channel");
  return ch;
}

export async function readableChannels(db: D1Database, v: Viewer, state: "active" | "archived" = "active"): Promise<ChannelRow[]> {
  if (rank(v.role) < rank("reader")) return [];
  const all = await listChannels(db, v.tenant.id, state);
  if (v.identity.kind === "human") return all;
  const mine = await agentConversationIds(db, v.tenant.id, v.identity.id);
  return all.filter((c) => mine.has(c.project_id));
}

/** An active agent of the caller's tenant, by slug with or without `@`; `includeArchived` also finds archived ones. */
export async function agentInTenant(ctx: Ctx, name: string, includeArchived = false): Promise<Agent> {
  const agent = await getAgentBySlug(ctx.db, ctx.tenant!, name.trim().replace(/^@/, ""), ctx.env.HUB_DOMAIN);
  if (!agent || agent.tenant.id !== ctx.tenant!.id) throw notFound("no such agent");
  if (!includeArchived && (agent.identity.state !== "active" || agent.membership.state !== "active")) throw notFound("no such agent");
  return agent;
}
