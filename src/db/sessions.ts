import { randomToken, sha256Hex, ulid } from "../ids";
import type { Session } from "./types";

export const SESSION_ROLLING_MS = 180 * 24 * 3600 * 1000;
export const SESSION_MAX_MS = 365 * 24 * 3600 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 3600 * 1000;

export async function createBrowserSession(db: D1Database, identity_id: string, now: number): Promise<{ session: Session; token: string }> {
  const token = randomToken("pms_");
  const session: Session = {
    id: ulid(now), identity_id, tenant_id: null, kind: "browser", label: null, token_hash: await sha256Hex(token),
    created_at: now, last_seen_at: now, expires_at: now + SESSION_ROLLING_MS, last_proof_at: now, revoked_at: null, parent_token_id: null,
  };
  await db.prepare(
    `INSERT INTO session (id, identity_id, tenant_id, kind, label, token_hash, created_at, last_seen_at, expires_at, last_proof_at, revoked_at, parent_token_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(session.id, session.identity_id, session.tenant_id, session.kind, session.label, session.token_hash,
    session.created_at, session.last_seen_at, session.expires_at, session.last_proof_at).run();
  return { session, token };
}

export async function getSessionByToken(db: D1Database, token: string, now: number): Promise<Session | null> {
  return db.prepare("SELECT * FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(await sha256Hex(token), now).first<Session>();
}

export async function touchSession(db: D1Database, session: Session, now: number): Promise<Session> {
  if (now - session.last_seen_at < SESSION_TOUCH_INTERVAL_MS) return session;
  // Only browser sessions roll; an agent run keeps the expiry it was started with.
  const expires_at = session.kind === "browser" ? Math.min(now + SESSION_ROLLING_MS, session.created_at + SESSION_MAX_MS) : session.expires_at;
  await db.prepare("UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id = ?").bind(now, expires_at, session.id).run();
  return { ...session, last_seen_at: now, expires_at };
}

export async function revokeSession(db: D1Database, id: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
  return r.meta.changes === 1;
}

export async function listSessions(db: D1Database, identity_id: string, now: number): Promise<Session[]> {
  const r = await db.prepare(
    "SELECT * FROM session WHERE identity_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
  ).bind(identity_id, now).all<Session>();
  return r.results.map((x) => ({ ...x, token_hash: "" }));
}

export async function setLastProof(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE session SET last_proof_at = ? WHERE id = ?").bind(now, id).run();
}

export const AGENT_SESSION_DEFAULT_TTL_S = 24 * 3600;
export const AGENT_SESSION_MAX_TTL_S = 7 * 24 * 3600;

export async function createAgentSession(
  db: D1Database,
  input: { identity_id: string; tenant_id: string; label: string; parent_token_id: string; ttl_s: number },
  now: number,
): Promise<{ session: Session; token: string }> {
  const token = randomToken("pms_");
  const session: Session = {
    id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, kind: "agent_run", label: input.label,
    token_hash: await sha256Hex(token), created_at: now, last_seen_at: now, expires_at: now + input.ttl_s * 1000,
    last_proof_at: now, revoked_at: null, parent_token_id: input.parent_token_id,
  };
  await db.prepare(
    `INSERT INTO session (id, identity_id, tenant_id, kind, label, token_hash, created_at, last_seen_at, expires_at, last_proof_at, revoked_at, parent_token_id)
     VALUES (?, ?, ?, 'agent_run', ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(session.id, session.identity_id, session.tenant_id, session.label, session.token_hash,
    now, now, session.expires_at, now, session.parent_token_id).run();
  return { session, token };
}

export function getSessionById(db: D1Database, id: string): Promise<Session | null> {
  return db.prepare("SELECT * FROM session WHERE id = ?").bind(id).first<Session>();
}

export async function listAgentRunsForOperator(db: D1Database, operator_id: string, now: number): Promise<Array<{ session: Session; agent_email: string; tenant_slug: string }>> {
  const r = await db.prepare(
    `SELECT s.*, i.email AS agent_email, t.slug AS tenant_slug
       FROM session s JOIN identity i ON i.id = s.identity_id JOIN tenant t ON t.id = s.tenant_id
      WHERE i.operator_id = ? AND s.kind = 'agent_run' AND s.revoked_at IS NULL AND s.expires_at > ?
      ORDER BY s.created_at DESC`,
  ).bind(operator_id, now).all<Session & { agent_email: string; tenant_slug: string }>();
  return r.results.map(({ agent_email, tenant_slug, ...session }) => ({ session: { ...session, token_hash: "" }, agent_email, tenant_slug }));
}
