// Who may sign in with Google, and what they get when they do (identity spec, Google amendment).
//
// A verified Google identity is admitted when any of these hold:
//   - an active human identity already has that email (Google is then just another proof of it);
//   - an open invite is addressed to that email (the verified address accepts it, root invites included);
//   - an active sign-in rule matches the email, or matches the Workspace domain in the token's `hd` claim.
// Rules then apply their grants. Everyone else is turned away and nothing is written.

import { isHubAddress } from "../db/agents";
import { acceptInvite, inviteIsOpen } from "../db/invites";
import { createIdentity, getIdentityByEmail } from "../db/identities";
import { addMembership, getMembership } from "../db/memberships";
import { RANK } from "./context";
import type { Identity, Invite, Role } from "../db/types";
import type { GoogleClaims } from "./googleToken";

export type Admission =
  | { ok: true; identity: Identity; created: boolean; invitesAccepted: number; grantsApplied: number }
  | { ok: false; reason: "unverified" | "not_listed" | "unavailable" | "other_google_account" };

type Rule = { id: string; kind: "email" | "domain"; value: string };
type Grant = { rule_id: string; tenant_id: string | null; role: Role };

async function matchingRules(db: D1Database, c: GoogleClaims): Promise<Rule[]> {
  const domain = c.email.split("@")[1] ?? "";
  // A domain rule needs Google's hosted-domain claim: it proves the account is managed by that
  // Workspace, which a consumer account that merely uses the address cannot claim.
  const hd = c.hd && c.hd === domain ? c.hd : null;
  const r = await db.prepare(
    "SELECT id, kind, value FROM signin_rule WHERE revoked_at IS NULL AND ((kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?))",
  ).bind(c.email, hd ?? "\u0000").all<Rule>();
  return r.results;
}

/** Add or raise one membership. Never lowers a role and never revives a membership someone removed. */
async function grantMembership(db: D1Database, identity_id: string, tenant_id: string, role: Role, now: number): Promise<boolean> {
  const m = await getMembership(db, identity_id, tenant_id);
  if (!m) { await addMembership(db, { identity_id, tenant_id, role }, now); return true; }
  if (m.state !== "active" || RANK[m.role] >= RANK[role]) return false;
  await db.prepare("UPDATE membership SET role = ? WHERE id = ?").bind(role, m.id).run();
  return true;
}

async function applyGrants(db: D1Database, identity: Identity, rules: Rule[], now: number): Promise<number> {
  if (!rules.length || identity.is_root === 1) return 0;
  const grants = await db.prepare(
    `SELECT rule_id, tenant_id, role FROM signin_grant WHERE rule_id IN (${rules.map(() => "?").join(",")})`,
  ).bind(...rules.map((r) => r.id)).all<Grant>();
  let n = 0;
  for (const g of grants.results) {
    const tenants = g.tenant_id
      ? [g.tenant_id]
      : (await db.prepare("SELECT id FROM tenant WHERE state = 'active'").all<{ id: string }>()).results.map((t) => t.id);
    for (const t of tenants) {
      const live = await db.prepare("SELECT 1 FROM tenant WHERE id = ? AND state = 'active'").bind(t).first();
      if (live && await grantMembership(db, identity.id, t, g.role, now)) n++;
    }
  }
  return n;
}

/**
 * Standing grants for a newly created tenant: every email rule whose grant covers all tenants gives
 * its already-known identity a membership right away, rather than at that person's next sign-in.
 */
export async function applyStandingGrants(db: D1Database, tenant_id: string, now: number): Promise<number> {
  const rows = await db.prepare(
    `SELECT i.id AS identity_id, g.role AS role FROM signin_grant g
       JOIN signin_rule r ON r.id = g.rule_id AND r.revoked_at IS NULL AND r.kind = 'email'
       JOIN identity i ON i.email = r.value AND i.kind = 'human' AND i.state = 'active' AND i.is_root = 0
     WHERE g.tenant_id IS NULL`,
  ).all<{ identity_id: string; role: Role }>();
  let n = 0;
  for (const r of rows.results) if (await grantMembership(db, r.identity_id, tenant_id, r.role, now)) n++;
  return n;
}

export async function admitGoogle(db: D1Database, c: GoogleClaims, now: number, hubDomain: string): Promise<Admission> {
  // Hub addresses belong to organizations, projects and agents, never to a person (owner, 2026-10-07).
  if (isHubAddress(c.email, hubDomain)) return { ok: false, reason: "unavailable" };
  if (!c.email_verified) return { ok: false, reason: "unverified" };

  const bound = await db.prepare("SELECT identity_id FROM google_account WHERE sub = ?").bind(c.sub).first<{ identity_id: string }>();
  let identity = await getIdentityByEmail(db, c.email);
  if (identity && (identity.kind !== "human" || identity.state !== "active")) return { ok: false, reason: "unavailable" };
  if (bound && identity && bound.identity_id !== identity.id) return { ok: false, reason: "other_google_account" };
  if (identity) {
    const other = await db.prepare("SELECT sub FROM google_account WHERE identity_id = ?").bind(identity.id).first<{ sub: string }>();
    if (other && other.sub !== c.sub) return { ok: false, reason: "other_google_account" };
  }

  const rules = await matchingRules(db, c);
  const invites = (await db.prepare("SELECT * FROM invite WHERE email = ?").bind(c.email).all<Invite>()).results
    .filter((i) => inviteIsOpen(i, now));
  if (!identity && !invites.length && !rules.length) return { ok: false, reason: "not_listed" };

  let created = false;
  let invitesAccepted = 0;
  // Root invites first, so the identity is created as root rather than raised to it afterwards.
  invites.sort((a, b) => (a.role === "root" ? -1 : 0) - (b.role === "root" ? -1 : 0));
  for (const inv of invites) {
    const r = await acceptInvite(db, inv, now);
    if (!r) continue;
    invitesAccepted++;
    identity = r.identity;
    created ||= r.created;
  }
  if (!identity) {
    identity = await createIdentity(db, {
      kind: "human", email: c.email, display_name: (c.name ?? "").trim() || c.email.split("@")[0]!, is_root: 0, operator_id: null,
    }, now);
    created = true;
  }
  const grantsApplied = await applyGrants(db, identity, rules, now);
  await db.prepare(
    "INSERT INTO google_account (sub, identity_id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET last_seen_at = excluded.last_seen_at, email = excluded.email",
  ).bind(c.sub, identity.id, c.email, now, now).run();
  return { ok: true, identity, created, invitesAccepted, grantsApplied };
}
