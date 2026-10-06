import type { Env } from "../env";
import { classifyHost, type HostKind } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import { getSessionByToken, touchSession } from "../db/sessions";
import { readSessionToken } from "./cookie";
import type { Identity, Membership, Role, Session, Tenant } from "../db/types";

export type Ctx = {
  env: Env;
  db: D1Database;
  now: number;
  ip: string;
  host: HostKind;
  tenant: Tenant | null;
  identity: Identity | null;
  session: Session | null;
  role: Role | null;
  authKind: "cookie" | "bearer" | null;
  staleCookie: boolean;
};

const RANK: Record<Role, number> = { root: 4, admin: 3, member: 2, reader: 1 };

export function rank(role: Role | null): number {
  return role ? RANK[role] : 0;
}

export function roleFor(identity: Identity | null, membership: Membership | null): Role | null {
  if (!identity || identity.state !== "active") return null;
  if (identity.is_root === 1) return "root";
  if (membership && membership.state === "active") return membership.role;
  return null;
}

export async function buildContext(request: Request, env: Env, now: number = Date.now()): Promise<Ctx> {
  const db = env.HUB_DB;
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);

  let tenant: Tenant | null = null;
  if (host.kind === "tenant") {
    const t = await getTenantBySlug(db, host.slug);
    tenant = t && t.state === "active" ? t : null;
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const cookieToken = readSessionToken(request);

  let session: Session | null = null;
  let authKind: Ctx["authKind"] = null;
  let staleCookie = false;
  if (bearer && bearer.startsWith("pms_")) {
    session = await getSessionByToken(db, bearer, now);
    if (session) authKind = "bearer";
  } else if (cookieToken) {
    session = await getSessionByToken(db, cookieToken, now);
    if (session) authKind = "cookie";
    else staleCookie = true;
  }

  let identity: Identity | null = null;
  if (session) {
    session = await touchSession(db, session, now);
    identity = await getIdentityById(db, session.identity_id);
    if (!identity || identity.state !== "active") {
      if (authKind === "cookie") staleCookie = true;
      identity = null;
      session = null;
      authKind = null;
    }
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

  let role: Role | null = null;
  if (identity && tenant) {
    const membership = await getMembership(db, identity.id, tenant.id);
    role = roleFor(identity, membership);
  } else if (identity && identity.is_root === 1 && host.kind === "apex") {
    role = "root";
  }

  return { env, db, now, ip, host, tenant, identity, session, role, authKind, staleCookie };
}
