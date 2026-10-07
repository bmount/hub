import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug } from "../tenant";
import { RESERVED_AGENT_NAMES } from "../reserved";
import type { Agent, Identity, Membership, Role, State, Tenant } from "./types";

export const RESERVED_AGENT_SLUGS: ReadonlySet<string> = RESERVED_AGENT_NAMES;

export function normalizeAgentSlug(s: string): string {
  const slug = s.trim().toLowerCase();
  if (!isValidSlug(slug) || RESERVED_AGENT_SLUGS.has(slug)) throw badRequest("invalid agent slug");
  return slug;
}

export function agentAddress(slug: string, tenantSlug: string, hubDomain: string): string {
  return `${slug}@${tenantSlug}.${hubDomain.toLowerCase()}`;
}

/** True for any address under a tenant subdomain of the hub: those are reserved for agents (spec 6.5). */
export function isAgentDomainAddress(email: string, hubDomain: string): boolean {
  const e = email.trim().toLowerCase();
  const domain = e.slice(e.lastIndexOf("@") + 1).replace(/\.$/, "");
  return domain.endsWith("." + hubDomain.toLowerCase());
}

const AGENT_SELECT = `SELECT i.id AS i_id, i.display_name AS i_display_name, i.is_root, i.email, i.operator_id, i.state AS i_state, i.created_at AS i_created_at,
       m.id AS m_id, m.role, m.state AS m_state, m.created_at AS m_created_at,
       t.id AS t_id, t.slug AS t_slug, t.display_name AS t_display_name, t.state AS t_state, t.created_at AS t_created_at
  FROM identity i JOIN membership m ON m.identity_id = i.id JOIN tenant t ON t.id = m.tenant_id
 WHERE i.kind = 'agent'`;

type Row = Record<string, string | number | null>;

function toAgent(x: Row): Agent {
  const identity: Identity = {
    id: x.i_id as string, kind: "agent", display_name: x.i_display_name as string, is_root: x.is_root as number, email: x.email as string,
    operator_id: x.operator_id as string | null, state: x.i_state as State, created_at: x.i_created_at as number,
  };
  const membership: Membership = {
    id: x.m_id as string, identity_id: identity.id, tenant_id: x.t_id as string, role: x.role as Role, state: x.m_state as State, created_at: x.m_created_at as number,
  };
  const tenant: Tenant = {
    id: x.t_id as string, slug: x.t_slug as string, display_name: x.t_display_name as string, state: x.t_state as State, created_at: x.t_created_at as number,
  };
  return { identity, membership, tenant, slug: identity.email.split("@")[0]! };
}

export async function createAgent(
  db: D1Database,
  input: { tenant: Tenant; slug: string; display_name: string; operator_id: string; role: "member" | "reader"; hubDomain: string },
  now: number,
): Promise<Agent> {
  const slug = normalizeAgentSlug(input.slug);
  const display_name = input.display_name.trim();
  if (!display_name) throw badRequest("display_name required");
  const email = agentAddress(slug, input.tenant.slug, input.hubDomain);
  const identity: Identity = { id: ulid(now), kind: "agent", display_name, is_root: 0, email, operator_id: input.operator_id, state: "active", created_at: now };
  const membership: Membership = { id: ulid(now), identity_id: identity.id, tenant_id: input.tenant.id, role: input.role, state: "active", created_at: now };
  let made: D1Result[];
  try {
    made = await db.batch([
      // Projects and agents share one name space per organization (mailboxes spec, amendment 2026-10-07 b); the check
      // is inside the insert, so a project created at the same moment cannot also win the name.
      db.prepare(`INSERT INTO identity (id, kind, display_name, is_root, email, operator_id, state, created_at) SELECT ?, 'agent', ?, 0, ?, ?, 'active', ?
        WHERE NOT EXISTS (SELECT 1 FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel')`)
        .bind(identity.id, display_name, email, input.operator_id, now, input.tenant.id, slug),
      db.prepare("INSERT INTO membership (id, identity_id, tenant_id, role, state, created_at) SELECT ?, ?, ?, ?, 'active', ? WHERE EXISTS (SELECT 1 FROM identity WHERE id = ?)")
        .bind(membership.id, identity.id, input.tenant.id, input.role, now, identity.id),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("agent slug taken in this tenant");
    throw e;
  }
  if (made[0]!.meta.changes !== 1) throw conflict(`"${slug}" is the name of a project in this organization; choose another agent name`);
  return { identity, membership, tenant: input.tenant, slug };
}

export async function getAgentById(db: D1Database, id: string): Promise<Agent | null> {
  const row = await db.prepare(`${AGENT_SELECT} AND i.id = ?`).bind(id).first<Row>();
  return row ? toAgent(row) : null;
}

export async function getAgentBySlug(db: D1Database, tenant: Tenant, slug: string, hubDomain: string): Promise<Agent | null> {
  const row = await db.prepare(`${AGENT_SELECT} AND i.email = ?`).bind(agentAddress(slug.trim().toLowerCase(), tenant.slug, hubDomain)).first<Row>();
  return row ? toAgent(row) : null;
}

export async function listAgentsForTenant(db: D1Database, tenant_id: string, state: State): Promise<Agent[]> {
  const r = await db.prepare(`${AGENT_SELECT} AND t.id = ? AND i.state = ? ORDER BY i.email`).bind(tenant_id, state).all<Row>();
  return r.results.map(toAgent);
}

export async function listAgentsForOperator(db: D1Database, operator_id: string): Promise<Agent[]> {
  const r = await db.prepare(`${AGENT_SELECT} AND i.operator_id = ? AND i.state = 'active' AND t.state = 'active' ORDER BY t.slug, i.email`)
    .bind(operator_id).all<Row>();
  return r.results.map(toAgent);
}

/** Archive the agent and revoke every token and session it holds, in one batch (spec 6.5 cascade). */
export async function archiveAgent(db: D1Database, agent_id: string, now: number): Promise<{ archived: boolean; tokens: number; sessions: number }> {
  const r = await db.batch([
    db.prepare("UPDATE identity SET state = 'archived' WHERE id = ? AND kind = 'agent' AND state = 'active'").bind(agent_id),
    db.prepare("UPDATE api_token SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM identity WHERE id = ? AND kind = 'agent')").bind(now, agent_id, agent_id),
    db.prepare("UPDATE session SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM identity WHERE id = ? AND kind = 'agent')").bind(now, agent_id, agent_id),
  ]);
  return { archived: r[0]!.meta.changes === 1, tokens: r[1]!.meta.changes, sessions: r[2]!.meta.changes };
}

export async function tenantAgentActivity(db: D1Database, tenant_id: string, now: number): Promise<Map<string, { tokens: number; runs: number }>> {
  const [tokens, runs] = await db.batch<{ identity_id: string; n: number }>([
    db.prepare("SELECT identity_id, COUNT(*) AS n FROM api_token WHERE tenant_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY identity_id").bind(tenant_id, now),
    db.prepare("SELECT identity_id, COUNT(*) AS n FROM session WHERE tenant_id = ? AND kind = 'agent_run' AND revoked_at IS NULL AND expires_at > ? GROUP BY identity_id").bind(tenant_id, now),
  ]);
  const out = new Map<string, { tokens: number; runs: number }>();
  const slot = (id: string) => out.get(id) ?? out.set(id, { tokens: 0, runs: 0 }).get(id)!;
  for (const r of tokens!.results) slot(r.identity_id).tokens = r.n;
  for (const r of runs!.results) slot(r.identity_id).runs = r.n;
  return out;
}
