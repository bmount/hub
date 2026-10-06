import { randomToken, sha256Hex, ulid } from "../ids";
import type { AuthLink, LinkPurpose } from "./types";

export const AUTH_LINK_TTL_MS = 15 * 60 * 1000;

export async function createAuthLink(db: D1Database, identity_id: string, purpose: LinkPurpose, now: number): Promise<{ link: AuthLink; token: string }> {
  const token = randomToken("pml_");
  const link: AuthLink = {
    id: ulid(now), identity_id, token_hash: await sha256Hex(token), purpose,
    created_at: now, expires_at: now + AUTH_LINK_TTL_MS, used_at: null,
  };
  await db.prepare(
    "INSERT INTO auth_link (id, identity_id, token_hash, purpose, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
  ).bind(link.id, link.identity_id, link.token_hash, link.purpose, link.created_at, link.expires_at).run();
  return { link, token };
}

export async function findAuthLinkByToken(db: D1Database, token: string): Promise<AuthLink | null> {
  return db.prepare("SELECT * FROM auth_link WHERE token_hash = ?").bind(await sha256Hex(token)).first<AuthLink>();
}

export function authLinkIsOpen(link: AuthLink, now: number): boolean {
  return link.used_at === null && link.expires_at > now;
}

// Atomic single-use claim: exactly one concurrent caller sees true.
export async function claimAuthLink(db: D1Database, id: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE auth_link SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, id, now).run();
  return r.meta.changes === 1;
}
