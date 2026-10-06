import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import type { Identity } from "../db/types";

/** The operator is an active human who is root or holds an active membership (any role) in the tenant. */
export async function operatorActiveIn(db: D1Database, operator_id: string | null, tenant_id: string): Promise<boolean> {
  if (!operator_id) return false;
  const op = await getIdentityById(db, operator_id);
  if (!op || op.kind !== "human" || op.state !== "active") return false;
  if (op.is_root === 1) return true;
  const m = await getMembership(db, op.id, tenant_id);
  return m !== null && m.state === "active";
}

/** An agent credential is usable while the agent is active, its parent token (for runs) is unrevoked, and its operator is live. */
export async function agentCredentialOk(db: D1Database, agent: Identity, tenant_id: string, parent_token_id: string | null): Promise<boolean> {
  if (agent.kind !== "agent" || agent.state !== "active") return false;
  if (parent_token_id !== null) {
    const t = await db.prepare("SELECT identity_id, tenant_id, revoked_at FROM api_token WHERE id = ?")
      .bind(parent_token_id).first<{ identity_id: string; tenant_id: string; revoked_at: number | null }>();
    if (!t || t.revoked_at !== null || t.identity_id !== agent.id || t.tenant_id !== tenant_id) return false;
  }
  const own = await getMembership(db, agent.id, tenant_id);
  if (!own || own.state !== "active") return false;
  return operatorActiveIn(db, agent.operator_id, tenant_id);
}
