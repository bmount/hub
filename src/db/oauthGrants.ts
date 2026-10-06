import { randomToken, sha256Hex, ulid } from "../ids";
import type { Identity, Membership, OAuthGrant, Role, Session, State, Tenant } from "./types";

export const GRANT_TTL_MS = 90 * 24 * 3600 * 1000;

export type NewGrant = {
  identity_id: string; tenant_id: string; client_id: string; client_name: string; client_kind: "dcr" | "cimd";
  redirect_host: string; resource: string; scopes: string[]; approved_by_session_id: string; last_proof_at: number;
};

export type LiveGrant = { grant: OAuthGrant; session: Session; identity: Identity; tenant: Tenant; membership: Membership | null };

type Row = Record<string, string | number | null>;

const GRANT_COLUMNS = [
  "id", "identity_id", "tenant_id", "session_id", "client_id", "client_name", "client_kind", "redirect_host", "resource", "scopes",
  "library_grant_id", "refresh_hash", "prev_refresh_hash", "code_hash", "refreshed_at", "approved_by_session_id", "created_at", "expires_at", "revoked_at", "revoked_by", "revoke_reason",
] as const;

function pickGrant(row: Row): OAuthGrant {
  const g: Record<string, string | number | null> = {};
  for (const k of GRANT_COLUMNS) g[k] = row[k] ?? null;
  return g as unknown as OAuthGrant;
}

/**
 * Write the grant and its `oauth` session in one batch (MCP spec 5.3). Earlier grants for the same client
 * and resource are replaced separately, by `replaceEarlierGrants`, once the library has accepted the new one.
 */
export async function createGrant(db: D1Database, input: NewGrant, now: number): Promise<{ grant: OAuthGrant; session: Session }> {
  const expires_at = now + GRANT_TTL_MS;
  // The session is the grant's unit of audit and revocation, never a bearer credential: its token is discarded.
  const session: Session = {
    id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, kind: "oauth", label: input.client_name,
    token_hash: await sha256Hex(randomToken("pmo_")), created_at: now, last_seen_at: now, expires_at,
    last_proof_at: input.last_proof_at, revoked_at: null, parent_token_id: null,
  };
  const grant: OAuthGrant = {
    id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, session_id: session.id, client_id: input.client_id,
    client_name: input.client_name, client_kind: input.client_kind, redirect_host: input.redirect_host, resource: input.resource,
    scopes: input.scopes.join(" "), library_grant_id: null, refresh_hash: null, prev_refresh_hash: null, code_hash: null, refreshed_at: null,
    approved_by_session_id: input.approved_by_session_id, created_at: now, expires_at, revoked_at: null, revoked_by: null, revoke_reason: null,
  };
  await db.batch([
    db.prepare(
      `INSERT INTO session (id, identity_id, tenant_id, kind, label, token_hash, created_at, last_seen_at, expires_at, last_proof_at, revoked_at, parent_token_id)
       VALUES (?, ?, ?, 'oauth', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(session.id, session.identity_id, session.tenant_id, session.label, session.token_hash, now, now, expires_at, session.last_proof_at),
    db.prepare(
      `INSERT INTO oauth_grant (id, identity_id, tenant_id, session_id, client_id, client_name, client_kind, redirect_host, resource, scopes,
         library_grant_id, refresh_hash, refreshed_at, approved_by_session_id, created_at, expires_at, revoked_at, revoked_by, revoke_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)`,
    ).bind(grant.id, grant.identity_id, grant.tenant_id, grant.session_id, grant.client_id, grant.client_name, grant.client_kind,
      grant.redirect_host, grant.resource, grant.scopes, grant.approved_by_session_id, now, expires_at),
  ]);
  return { grant, session };
}

/** Revoke the identity's earlier live grants (smaller id, so concurrent approvals cannot revoke each other) for the same client and resource as `replaced`. Returns the grants it replaced. */
export async function replaceEarlierGrants(db: D1Database, grant: OAuthGrant, now: number): Promise<OAuthGrant[]> {
  const same = "identity_id = ? AND client_id = ? AND resource = ? AND revoked_at IS NULL AND id < ?";
  const binds = [grant.identity_id, grant.client_id, grant.resource, grant.id];
  const old = (await db.prepare(`SELECT * FROM oauth_grant WHERE ${same}`).bind(...binds).all<OAuthGrant>()).results;
  if (old.length === 0) return [];
  await db.batch([
    db.prepare(`UPDATE session SET revoked_at = ? WHERE revoked_at IS NULL AND id IN (SELECT session_id FROM oauth_grant WHERE ${same})`).bind(now, ...binds),
    db.prepare(`UPDATE oauth_grant SET revoked_at = ?, revoked_by = ?, revoke_reason = 'replaced' WHERE ${same}`).bind(now, grant.identity_id, ...binds),
  ]);
  return old;
}

export function getGrantById(db: D1Database, id: string): Promise<OAuthGrant | null> {
  return db.prepare("SELECT * FROM oauth_grant WHERE id = ?").bind(id).first<OAuthGrant>();
}

export function getGrantByLibraryId(db: D1Database, library_grant_id: string): Promise<OAuthGrant | null> {
  return db.prepare("SELECT * FROM oauth_grant WHERE library_grant_id = ?").bind(library_grant_id).first<OAuthGrant>();
}

export function getGrantBySessionId(db: D1Database, session_id: string): Promise<OAuthGrant | null> {
  return db.prepare("SELECT * FROM oauth_grant WHERE session_id = ?").bind(session_id).first<OAuthGrant>();
}

export async function setLibraryGrantId(db: D1Database, id: string, library_grant_id: string, code_hash: string | null = null): Promise<void> {
  await db.prepare("UPDATE oauth_grant SET library_grant_id = ?, code_hash = ? WHERE id = ?").bind(library_grant_id, code_hash, id).run();
}

/**
 * The per-request check (MCP spec 5.3), one query: grant and session unrevoked and unexpired, identity an
 * active human, tenant active, and membership active unless the identity is root.
 */
export async function liveGrant(db: D1Database, grant_id: string, now: number): Promise<LiveGrant | null> {
  const row = await db.prepare(
    `SELECT g.*,
            s.label AS s_label, s.token_hash AS s_token_hash, s.created_at AS s_created_at, s.last_seen_at AS s_last_seen_at,
            s.expires_at AS s_expires_at, s.last_proof_at AS s_last_proof_at,
            i.display_name AS i_display_name, i.is_root AS i_is_root, i.email AS i_email, i.operator_id AS i_operator_id, i.created_at AS i_created_at,
            t.slug AS t_slug, t.display_name AS t_display_name, t.created_at AS t_created_at,
            m.id AS m_id, m.role AS m_role, m.state AS m_state, m.created_at AS m_created_at
       FROM oauth_grant g
       JOIN session s ON s.id = g.session_id
       JOIN identity i ON i.id = g.identity_id
       JOIN tenant t ON t.id = g.tenant_id
       LEFT JOIN membership m ON m.identity_id = g.identity_id AND m.tenant_id = g.tenant_id
      WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ?
        AND s.kind = 'oauth' AND s.revoked_at IS NULL AND s.expires_at > ?
        AND i.kind = 'human' AND i.state = 'active' AND t.state = 'active'
        AND (i.is_root = 1 OR m.state = 'active')`,
  ).bind(grant_id, now, now).first<Row>();
  if (!row) return null;
  const grant = pickGrant(row);
  const session: Session = {
    id: grant.session_id, identity_id: grant.identity_id, tenant_id: grant.tenant_id, kind: "oauth", label: row.s_label as string | null,
    token_hash: row.s_token_hash as string, created_at: row.s_created_at as number, last_seen_at: row.s_last_seen_at as number,
    expires_at: row.s_expires_at as number, last_proof_at: row.s_last_proof_at as number, revoked_at: null, parent_token_id: null,
  };
  const identity: Identity = {
    id: grant.identity_id, kind: "human", display_name: row.i_display_name as string, is_root: row.i_is_root as number, email: row.i_email as string,
    operator_id: row.i_operator_id as string | null, state: "active", created_at: row.i_created_at as number,
  };
  const tenant: Tenant = { id: grant.tenant_id, slug: row.t_slug as string, display_name: row.t_display_name as string, state: "active", created_at: row.t_created_at as number };
  const membership: Membership | null = row.m_id === null ? null : {
    id: row.m_id as string, identity_id: grant.identity_id, tenant_id: grant.tenant_id, role: row.m_role as Role, state: row.m_state as State, created_at: row.m_created_at as number,
  };
  return { grant, session, identity, tenant, membership };
}

/**
 * Compare-and-set the hash of the one refresh token that is currently valid for the grant. The hash it
 * replaces is kept as `prev_refresh_hash`: only that retired token coming back proves reuse.
 */
export async function rotateRefreshHash(db: D1Database, id: string, expected: string | null, next: string, now: number): Promise<boolean> {
  const stmt = expected === null
    ? db.prepare("UPDATE oauth_grant SET prev_refresh_hash = refresh_hash, refresh_hash = ?, refreshed_at = ? WHERE id = ? AND revoked_at IS NULL AND refresh_hash IS NULL").bind(next, now, id)
    : db.prepare("UPDATE oauth_grant SET prev_refresh_hash = refresh_hash, refresh_hash = ?, refreshed_at = ? WHERE id = ? AND revoked_at IS NULL AND refresh_hash = ?").bind(next, now, id, expected);
  return (await stmt.run()).meta.changes === 1;
}

/** Revoke one grant and its session in one batch (MCP spec 10.2). True if this call revoked it. */
export async function revokeGrantRows(db: D1Database, id: string, by: string | null, reason: string, now: number): Promise<boolean> {
  const [g] = await db.batch([
    db.prepare("UPDATE oauth_grant SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL").bind(now, by, reason, id),
    db.prepare("UPDATE session SET revoked_at = ? WHERE revoked_at IS NULL AND id = (SELECT session_id FROM oauth_grant WHERE id = ?)").bind(now, id),
  ]);
  return g!.meta.changes === 1;
}

/**
 * Cascade (MCP spec 10.3): revoke every live grant of an identity, of a tenant, or of one membership
 * (both ids). Returns the grants that were live, so callers can drop their library grants.
 */
export async function revokeGrantsFor(
  db: D1Database, scope: { identity_id?: string; tenant_id?: string }, by: string | null, reason: string, now: number,
): Promise<OAuthGrant[]> {
  const where = ["revoked_at IS NULL"];
  const binds: string[] = [];
  if (scope.identity_id) { where.push("identity_id = ?"); binds.push(scope.identity_id); }
  if (scope.tenant_id) { where.push("tenant_id = ?"); binds.push(scope.tenant_id); }
  if (binds.length === 0) throw new Error("revokeGrantsFor needs an identity or a tenant");
  const live = (await db.prepare(`SELECT * FROM oauth_grant WHERE ${where.join(" AND ")}`).bind(...binds).all<OAuthGrant>()).results;
  if (live.length === 0) return [];
  const ids = live.map((g) => g.id);
  const marks = ids.map(() => "?").join(", ");
  await db.batch([
    db.prepare(`UPDATE oauth_grant SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE revoked_at IS NULL AND id IN (${marks})`).bind(now, by, reason, ...ids),
    db.prepare(`UPDATE session SET revoked_at = ? WHERE revoked_at IS NULL AND id IN (SELECT session_id FROM oauth_grant WHERE id IN (${marks}))`).bind(now, ...ids),
  ]);
  return live;
}

export async function listLiveGrantsForIdentity(db: D1Database, identity_id: string, now: number): Promise<Array<{ grant: OAuthGrant; tenant_slug: string; last_seen_at: number }>> {
  const r = await db.prepare(
    `SELECT g.*, t.slug AS tenant_slug, s.last_seen_at AS last_seen_at
       FROM oauth_grant g JOIN tenant t ON t.id = g.tenant_id JOIN session s ON s.id = g.session_id
      WHERE g.identity_id = ? AND g.revoked_at IS NULL AND g.expires_at > ?
      ORDER BY g.created_at DESC`,
  ).bind(identity_id, now).all<Row>();
  return r.results.map((row) => ({ grant: pickGrant(row), tenant_slug: row.tenant_slug as string, last_seen_at: row.last_seen_at as number }));
}
