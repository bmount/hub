import { randomToken, sha256Hex, ulid } from "../ids";
import type { ApiToken } from "./types";

export const API_TOKEN_PREFIX = "pmw_";

export async function createApiToken(
  db: D1Database,
  input: { identity_id: string; tenant_id: string; name: string; created_by: string; expires_at: number | null },
  now: number,
): Promise<{ token: ApiToken; plaintext: string }> {
  const plaintext = randomToken(API_TOKEN_PREFIX);
  const token: ApiToken = {
    id: ulid(now), identity_id: input.identity_id, tenant_id: input.tenant_id, name: input.name, token_hash: await sha256Hex(plaintext),
    scopes: "", created_by: input.created_by, created_at: now, expires_at: input.expires_at, last_used_at: null, revoked_at: null,
  };
  await db.prepare(
    `INSERT INTO api_token (id, identity_id, tenant_id, name, token_hash, scopes, created_by, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, NULL, NULL)`,
  ).bind(token.id, token.identity_id, token.tenant_id, token.name, token.token_hash, token.created_by, now, token.expires_at).run();
  return { token, plaintext };
}

export async function getApiTokenByToken(db: D1Database, plaintext: string, now: number): Promise<ApiToken | null> {
  if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null;
  return db.prepare("SELECT * FROM api_token WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
    .bind(await sha256Hex(plaintext), now).first<ApiToken>();
}

export function getApiTokenById(db: D1Database, id: string): Promise<ApiToken | null> {
  return db.prepare("SELECT * FROM api_token WHERE id = ?").bind(id).first<ApiToken>();
}

const hide = (t: ApiToken): ApiToken => ({ ...t, token_hash: "" });

const LIVE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

export async function listApiTokensForIdentity(db: D1Database, identity_id: string, now: number): Promise<ApiToken[]> {
  const r = await db.prepare(`SELECT * FROM api_token WHERE identity_id = ? AND ${LIVE} ORDER BY created_at DESC`).bind(identity_id, now).all<ApiToken>();
  return r.results.map(hide);
}

export async function listApiTokensForTenant(db: D1Database, tenant_id: string, now: number): Promise<ApiToken[]> {
  const r = await db.prepare(`SELECT * FROM api_token WHERE tenant_id = ? AND ${LIVE} ORDER BY created_at DESC`).bind(tenant_id, now).all<ApiToken>();
  return r.results.map(hide);
}

export async function listApiTokensForOperator(db: D1Database, operator_id: string, now: number): Promise<Array<{ token: ApiToken; agent_email: string; tenant_slug: string }>> {
  const r = await db.prepare(
    `SELECT a.*, i.email AS agent_email, t.slug AS tenant_slug
       FROM api_token a JOIN identity i ON i.id = a.identity_id JOIN tenant t ON t.id = a.tenant_id
      WHERE i.operator_id = ? AND i.state = 'active' AND t.state = 'active'
        AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ?)
      ORDER BY a.created_at DESC`,
  ).bind(operator_id, now).all<ApiToken & { agent_email: string; tenant_slug: string }>();
  return r.results.map(({ agent_email, tenant_slug, ...token }) => ({ token: hide(token), agent_email, tenant_slug }));
}

/** Revoke the token and every session it started, in one batch (spec 6.5). */
export async function revokeApiToken(db: D1Database, id: string, now: number): Promise<{ revoked: boolean; sessions: number }> {
  const r = await db.batch([
    db.prepare("UPDATE api_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id),
    db.prepare("UPDATE session SET revoked_at = ? WHERE parent_token_id = ? AND revoked_at IS NULL").bind(now, id),
  ]);
  return { revoked: r[0]!.meta.changes === 1, sessions: r[1]!.meta.changes };
}

export async function markApiTokenUsed(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE api_token SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}
