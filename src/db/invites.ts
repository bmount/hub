import { randomToken, sha256Hex, ulid } from "../ids";
import { badRequest, HubError } from "../errors";
import { createIdentity, getIdentityByEmail, normalizeEmail } from "./identities";
import { addMembership, getMembership } from "./memberships";
import type { Identity, Invite, Role } from "./types";

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const ROLES: Role[] = ["root", "admin", "member", "reader"];

export async function createInvite(
  db: D1Database,
  input: { tenant_id: string | null; email: string; role: Role; display_name: string | null; created_by: string | null },
  now: number,
): Promise<{ invite: Invite; token: string }> {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw badRequest("invalid email");
  if (email.startsWith("@")) throw badRequest("invalid email");
  const display_name = input.display_name === null ? null : input.display_name.trim();
  if (display_name === "") throw badRequest("display_name must not be empty");
  if (!ROLES.includes(input.role)) throw badRequest("invalid role");
  if (input.role === "root" && input.tenant_id !== null) throw badRequest("root invites have no tenant");
  if (input.role !== "root" && input.tenant_id === null) throw badRequest("tenant required");
  const token = randomToken("pmi_");
  const invite: Invite = {
    id: ulid(now), tenant_id: input.tenant_id, email, role: input.role, display_name,
    token_hash: await sha256Hex(token), created_by: input.created_by, created_at: now, expires_at: now + INVITE_TTL_MS,
    accepted_at: null, accepted_session_id: null, revoked_at: null,
  };
  await db.prepare(
    "INSERT INTO invite (id, tenant_id, email, role, display_name, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(invite.id, invite.tenant_id, invite.email, invite.role, invite.display_name, invite.token_hash, invite.created_by, invite.created_at, invite.expires_at).run();
  return { invite, token };
}

export async function findInviteByToken(db: D1Database, token: string): Promise<Invite | null> {
  return db.prepare("SELECT * FROM invite WHERE token_hash = ?").bind(await sha256Hex(token)).first<Invite>();
}

export function inviteIsOpen(invite: Invite, now: number): boolean {
  return invite.accepted_at === null && invite.revoked_at === null && invite.expires_at > now;
}

export async function acceptInvite(db: D1Database, invite: Invite, now: number): Promise<{ identity: Identity; created: boolean; membershipAdded: boolean } | null> {
  if (!inviteIsOpen(invite, now)) return null;
  const pre = await getIdentityByEmail(db, invite.email);
  if (pre && (pre.state !== "active" || pre.kind !== "human")) return null;
  const claim = await db.prepare(
    "UPDATE invite SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
  ).bind(now, invite.id, now).run();
  if (claim.meta.changes !== 1) return null;

  let identity = pre;
  let created = false;
  if (!identity) {
    try {
      identity = await createIdentity(db, {
        kind: "human", email: invite.email, display_name: invite.display_name ?? invite.email.split("@")[0]!,
        is_root: invite.role === "root" ? 1 : 0, operator_id: null,
      }, now);
      created = true;
    } catch (e) {
      if (!(e instanceof HubError) || e.status !== 409) throw e;
      identity = await getIdentityByEmail(db, invite.email);
      if (!identity) throw e;
      if (identity.state !== "active") return null;
      if (invite.role === "root" && identity.is_root !== 1) {
        await db.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(identity.id).run();
        identity = { ...identity, is_root: 1 };
      }
    }
  } else if (invite.role === "root" && identity.is_root !== 1) {
    await db.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(identity.id).run();
    identity = { ...identity, is_root: 1 };
  }
  let membershipAdded = invite.role === "root";
  if (invite.role !== "root" && invite.tenant_id !== null) {
    const existing = await getMembership(db, identity.id, invite.tenant_id);
    const active = existing !== null && existing.state === "active";
    membershipAdded = !active;
    if (!active) await addMembership(db, { identity_id: identity.id, tenant_id: invite.tenant_id, role: invite.role }, now);
  }
  return { identity, created, membershipAdded };
}

export async function setInviteAcceptedSession(db: D1Database, invite_id: string, session_id: string): Promise<void> {
  await db.prepare("UPDATE invite SET accepted_session_id = ? WHERE id = ?").bind(session_id, invite_id).run();
}

export async function revokeInvite(db: D1Database, tenant_id: string, id: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE invite SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL AND accepted_at IS NULL").bind(now, id, tenant_id).run();
  return r.meta.changes === 1;
}

export async function listInvites(db: D1Database, tenant_id: string): Promise<Invite[]> {
  const r = await db.prepare("SELECT * FROM invite WHERE tenant_id = ? ORDER BY created_at DESC").bind(tenant_id).all<Invite>();
  return r.results;
}
