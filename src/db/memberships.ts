import { ulid } from "../ids";
import type { Identity, Membership, Role, Tenant } from "./types";

export async function addMembership(
  db: D1Database,
  input: { identity_id: string; tenant_id: string; role: Role },
  now: number,
): Promise<Membership> {
  const row: Membership = { id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, role: input.role, state: "active", created_at: now };
  await db.prepare(
    "INSERT OR IGNORE INTO membership (id, identity_id, tenant_id, role, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.identity_id, row.tenant_id, row.role, row.state, row.created_at).run();
  return (await getMembership(db, input.identity_id, input.tenant_id))!;
}

export function getMembership(db: D1Database, identity_id: string, tenant_id: string): Promise<Membership | null> {
  return db.prepare("SELECT * FROM membership WHERE identity_id = ? AND tenant_id = ?").bind(identity_id, tenant_id).first<Membership>();
}

export async function listMembershipsForIdentity(db: D1Database, identity_id: string): Promise<Array<{ membership: Membership; tenant: Tenant }>> {
  const r = await db.prepare(
    `SELECT m.id AS m_id, m.identity_id, m.tenant_id, m.role, m.state AS m_state, m.created_at AS m_created_at,
            t.id AS t_id, t.slug, t.display_name, t.state AS t_state, t.created_at AS t_created_at
       FROM membership m JOIN tenant t ON t.id = m.tenant_id
      WHERE m.identity_id = ? AND m.state = 'active' AND t.state = 'active'
      ORDER BY t.slug`,
  ).bind(identity_id).all<Record<string, string | number>>();
  return r.results.map((x) => ({
    membership: { id: x.m_id as string, identity_id: x.identity_id as string, tenant_id: x.tenant_id as string, role: x.role as Role, state: x.m_state as "active", created_at: x.m_created_at as number },
    tenant: { id: x.t_id as string, slug: x.slug as string, display_name: x.display_name as string, state: x.t_state as "active", created_at: x.t_created_at as number },
  }));
}

export async function listMembers(db: D1Database, tenant_id: string): Promise<Array<{ membership: Membership; identity: Identity }>> {
  const r = await db.prepare(
    `SELECT m.id AS m_id, m.identity_id, m.tenant_id, m.role, m.state AS m_state, m.created_at AS m_created_at,
            i.id AS i_id, i.kind, i.display_name, i.is_root, i.email, i.operator_id, i.state AS i_state, i.created_at AS i_created_at
       FROM membership m JOIN identity i ON i.id = m.identity_id
      WHERE m.tenant_id = ? AND m.state = 'active'
      ORDER BY i.display_name`,
  ).bind(tenant_id).all<Record<string, string | number | null>>();
  return r.results.map((x) => ({
    membership: { id: x.m_id as string, identity_id: x.identity_id as string, tenant_id: x.tenant_id as string, role: x.role as Role, state: x.m_state as "active", created_at: x.m_created_at as number },
    identity: {
      id: x.i_id as string, kind: x.kind as "human" | "agent", display_name: x.display_name as string, is_root: x.is_root as number, email: x.email as string,
      operator_id: x.operator_id as string | null, state: x.i_state as "active", created_at: x.i_created_at as number,
    },
  }));
}
