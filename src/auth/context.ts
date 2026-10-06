import type { Env } from "../env";
import { classifyHost, type HostKind } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import { getSessionByToken, touchSession } from "../db/sessions";
import { readSessionToken } from "./cookie";
import { API_TOKEN_PREFIX, getApiTokenByToken } from "../db/apiTokens";
import { agentCredentialOk } from "./agent";
import type { ApiToken, Identity, Membership, Role, Session, Tenant } from "../db/types";

export type Ctx = {
  env: Env;
  db: D1Database;
  now: number;
  ip: string;
  waitUntil?: (p: Promise<unknown>) => void;
  host: HostKind;
  tenant: Tenant | null;
  identity: Identity | null;
  session: Session | null;
  apiToken: ApiToken | null;
  role: Role | null;
  authKind: "cookie" | "bearer" | "token" | null;
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

/** Humans: browser sessions only. Agents: pinned to one tenant and alive only while agent, parent token, and operator are (spec 6.5, 10). */
export async function credentialUsable(db: D1Database, identity: Identity, session: Session | null, apiToken: ApiToken | null, tenant: Tenant | null): Promise<boolean> {
  if (identity.state !== "active") return false;
  if (identity.kind === "human") return apiToken === null && session !== null && session.kind === "browser";
  if (session && session.parent_token_id === null) return false;
  if (session && session.kind !== "agent_run") return false;
  const pinned = session ? session.tenant_id : apiToken ? apiToken.tenant_id : null;
  if (!tenant || pinned !== tenant.id) return false;
  return agentCredentialOk(db, identity, tenant.id, session ? session.parent_token_id : null);
}

export async function buildContext(request: Request, env: Env, now: number = Date.now(), waitUntil?: (p: Promise<unknown>) => void, opts: { longLivedToken?: boolean } = {}): Promise<Ctx> {
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
  let apiToken: ApiToken | null = null;
  let authKind: Ctx["authKind"] = null;
  let staleCookie = false;
  if (bearer && bearer.startsWith("pms_")) {
    session = await getSessionByToken(db, bearer, now);
    if (session) authKind = "bearer";
  } else if (bearer && bearer.startsWith(API_TOKEN_PREFIX)) {
    // pmw_ tokens authenticate on the API only (spec 6.5); every other caller sees anonymous.
    if (opts.longLivedToken === true) apiToken = await getApiTokenByToken(db, bearer, now);
    if (apiToken) authKind = "token";
  } else if (cookieToken) {
    session = await getSessionByToken(db, cookieToken, now);
    // Agents authenticate by bearer only (spec 6.5); a run token in a cookie is stale.
    if (session && session.kind !== "browser") session = null;
    if (session) authKind = "cookie";
    else staleCookie = true;
  }

  let identity: Identity | null = null;
  if (session) identity = await getIdentityById(db, session.identity_id);
  else if (apiToken) identity = await getIdentityById(db, apiToken.identity_id);
  if (identity && !(await credentialUsable(db, identity, session, apiToken, tenant))) identity = null;
  if (!identity && authKind !== null) {
    if (authKind === "cookie") staleCookie = true;
    session = null;
    apiToken = null;
    authKind = null;
  }
  if (session) session = await touchSession(db, session, now);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

  let role: Role | null = null;
  if (identity && tenant) {
    const membership = await getMembership(db, identity.id, tenant.id);
    role = roleFor(identity, membership);
  } else if (identity && identity.is_root === 1 && host.kind === "apex") {
    role = "root";
  }

  return { env, db, now, ip, waitUntil, host, tenant, identity, session, apiToken, role, authKind, staleCookie };
}
