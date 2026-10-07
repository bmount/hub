import type { Env } from "../env";
import { classifyHost, type HostKind } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import { getSessionByToken, touchSession } from "../db/sessions";
import { readSessionToken } from "./cookie";
import { sha256Hex } from "../ids";
import { noteCtx } from "../log";
import { API_TOKEN_PREFIX, getApiTokenByToken } from "../db/apiTokens";
import { agentCredentialOk } from "./agent";
import type { LiveGrant } from "../db/oauthGrants";
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
  authKind: "cookie" | "bearer" | "token" | "oauth" | null;
  staleCookie: boolean;
  /** Set only on /mcp requests: the assistant connection this request runs under. */
  oauth?: OAuthCtx;
  /**
   * Set only by the in-context Playground: the scopes the person chose. The request then obeys the same MCP exposure
   * rules as an assistant connection holding exactly these scopes; it can only narrow the person's own authority.
   */
  playground?: { scopes: string[] };
};

export type OAuthCtx = { grant_id: string; client_id: string; client_name: string; scopes: string[] };

export const RANK: Record<Role, number> = { root: 4, admin: 3, member: 2, reader: 1 };

export function rank(role: Role | null): number {
  return role ? RANK[role] : 0;
}

export function roleFor(identity: Identity | null, membership: Membership | null): Role | null {
  if (!identity || identity.state !== "active") return null;
  if (identity.is_root === 1) return "root";
  if (membership && membership.state === "active") return membership.role;
  return null;
}

/**
 * Humans: browser sessions only, except on /mcp (`via: "mcp"`), where only an `oauth` session pinned to this
 * tenant counts (MCP spec 5.3). Agents: pinned to one tenant and alive only while agent, parent token, and
 * operator are (spec 6.5, 10); agents never use /mcp in v1.
 * Git sessions: only with via "introspect" (the Ardi service binding), pinned to their tenant.
 * Introspection accepts only `git` and `agent_run` sessions; browser and oauth sessions never introspect.
 */
export async function credentialUsable(
  db: D1Database, identity: Identity, session: Session | null, apiToken: ApiToken | null, tenant: Tenant | null, via: "http" | "mcp" | "introspect" = "http",
): Promise<boolean> {
  if (identity.state !== "active") return false;
  if (via === "mcp" || (session !== null && session.kind === "oauth")) {
    return via === "mcp" && identity.kind === "human" && apiToken === null && session !== null && session.kind === "oauth"
      && tenant !== null && session.tenant_id === tenant.id;
  }
  // Git credentials (integration spec 4) count only for internal introspection, for their human, on their own tenant.
  if (session !== null && session.kind === "git") {
    return via === "introspect" && identity.kind === "human" && apiToken === null && tenant !== null && session.tenant_id === tenant.id;
  }
  if (via === "introspect" && (session === null || session.kind !== "agent_run")) return false;
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

  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const cookieToken = readSessionToken(request);

  // One round trip for the common case (performance budget, overnight plan 2 N4): with a session token in hand, the
  // tenant, session, identity and membership rows come back in a single batch. Every check below still runs on them.
  const sessionToken = bearer && bearer.startsWith("pms_") ? bearer : !bearer && cookieToken ? cookieToken : null;
  const pre = sessionToken ? await prefetch(db, host.kind === "tenant" ? host.slug : null, await sha256Hex(sessionToken), now) : null;

  let tenant: Tenant | null = null;
  if (host.kind === "tenant") {
    const t = pre ? pre.tenant : await getTenantBySlug(db, host.slug);
    tenant = t && t.state === "active" ? t : null;
  }

  let session: Session | null = null;
  let apiToken: ApiToken | null = null;
  let authKind: Ctx["authKind"] = null;
  let staleCookie = false;
  if (bearer && bearer.startsWith("pms_")) {
    session = pre ? pre.session : await getSessionByToken(db, bearer, now);
    if (session) authKind = "bearer";
  } else if (bearer && bearer.startsWith(API_TOKEN_PREFIX)) {
    // pmw_ tokens authenticate on the API only (spec 6.5); every other caller sees anonymous.
    if (opts.longLivedToken === true) apiToken = await getApiTokenByToken(db, bearer, now);
    if (apiToken) authKind = "token";
  } else if (cookieToken) {
    session = pre ? pre.session : await getSessionByToken(db, cookieToken, now);
    // Agents authenticate by bearer only (spec 6.5); a run token in a cookie is stale.
    if (session && session.kind !== "browser") session = null;
    if (session) authKind = "cookie";
    else staleCookie = true;
  }

  let identity: Identity | null = null;
  if (session) identity = pre && pre.identity?.id === session.identity_id ? pre.identity : await getIdentityById(db, session.identity_id);
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
    const membership = pre && pre.tenant?.id === tenant.id && (pre.membership === null || pre.membership.identity_id === identity.id)
      ? pre.membership : await getMembership(db, identity.id, tenant.id);
    role = roleFor(identity, membership);
  } else if (identity && identity.is_root === 1 && host.kind === "apex") {
    role = "root";
  }

  const ctx: Ctx = { env, db, now, ip, waitUntil, host, tenant, identity, session, apiToken, role, authKind, staleCookie };
  noteCtx(request, ctx);
  return ctx;
}

type Prefetched = { tenant: Tenant | null; session: Session | null; identity: Identity | null; membership: Membership | null };

/** The rows buildContext needs for a session token, in one batch. Same predicates as the single-row getters. */
async function prefetch(db: D1Database, slug: string | null, tokenHash: string, now: number): Promise<Prefetched> {
  const live = "SELECT identity_id FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?";
  const [t, s, i, m] = await db.batch([
    db.prepare("SELECT * FROM tenant WHERE slug = ?").bind(slug),
    db.prepare("SELECT * FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?").bind(tokenHash, now),
    db.prepare(`SELECT * FROM identity WHERE id = (${live})`).bind(tokenHash, now),
    db.prepare(`SELECT * FROM membership WHERE identity_id = (${live}) AND tenant_id = (SELECT id FROM tenant WHERE slug = ?)`).bind(tokenHash, now, slug),
  ]);
  const one = <T>(r: D1Result<unknown> | undefined): T | null => ((r?.results[0] as T | undefined) ?? null);
  return { tenant: one<Tenant>(t), session: one<Session>(s), identity: one<Identity>(i), membership: one<Membership>(m) };
}

/** The context for one /mcp request, built from a grant that passed the per-request check (MCP spec 5.3, 8.5). */
export function oauthContext(
  env: Env, live: LiveGrant, scopes: string[], opts: { now: number; ip: string; waitUntil?: (p: Promise<unknown>) => void },
): Ctx {
  return {
    env, db: env.HUB_DB, now: opts.now, ip: opts.ip, waitUntil: opts.waitUntil,
    host: { kind: "tenant", slug: live.tenant.slug }, tenant: live.tenant, identity: live.identity, session: live.session, apiToken: null,
    role: roleFor(live.identity, live.membership), authKind: "oauth", staleCookie: false,
    oauth: { grant_id: live.grant.id, client_id: live.grant.client_id, client_name: live.grant.client_name, scopes },
  };
}
