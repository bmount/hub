import { span } from "../perf";
import type { Env } from "../env";
import { classifyHost, type HostKind } from "../tenant";
import { getTenantBySlug } from "../db/tenants";
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import { getSessionByToken, touchSession } from "../db/sessions";
import { readSessionToken } from "./cookie";
import { sha256Hex } from "../ids";
import { noteCtx } from "../log";
import { API_TOKEN_PREFIX } from "../db/apiTokens";
import { agentCredentialOk, type AgentCredentialState } from "./agent";
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
  /** Resolved by the project MCP route, never supplied by a client. */
  mcpProject?: { parts?: string; id: string; slug: string; kind: string; display_name: string; path: string };
  /**
   * Set only by the in-context Playground: the scopes the person chose. The request then obeys the same MCP exposure
   * rules as an assistant connection holding exactly these scopes; it can only narrow the person's own authority.
   */
  playground?: { scopes: string[] };
  /**
   * Set only on /agent/mcp: a headless agent connected with its own long-lived token (src/auth/connect.ts). It obeys
   * the same exposure rules as an assistant connection with these scopes. `sealed` is its run session's token, opened
   * only to read code as the agent.
   */
  agentMcp?: { token_id: string; scopes: string[]; sealed: { ciphertext: string; iv: string } };
  /** An agent's own run token, held for this request only so the hub can read code as it (src/code/ardi.ts). Never logged. */
  bearerToken?: string;
  /** The workbench rail's numbers, read in the same batch as the sign-in lookup (no extra round trip). Page views only. */
  rail?: RailData;
  /** Authorized project navigation, loaded in the sign-in batch for page requests. */
  explorer?: ExplorerData;
  pageUrl?: string;
};

export type ExplorerData = {
  path: string; display_name: string; kind: string; parts?: string; inProject: boolean;
  choices: Array<{ path: string; display_name: string }>;
  sites?: Array<{ name: string }>;
  repositories?: Array<{ name: string; is_default: number }>;
  channels: Array<{ slug: string; display_name: string; count: number }>;
  open: number; reviews: number; deploys: number; wiki: number; research: number; files: number; contacts: number; mail: number;
};

export type RailData = {
  projects: Array<{ slug: string; display_name: string; open: number }>;
  open: number; mine: number; held: number; needs: number;
};

export type OAuthCtx = { grant_id: string; client_id: string; client_name: string; scopes: string[] };

export const RANK: Record<Role, number> = { root: 4, admin: 3, member: 2, reader: 1 };

export function rank(role: Role | null): number {
  return role ? RANK[role] : 0;
}

/** The scopes of a connection that obeys MCP exposure rules (assistant, Playground, agent MCP), or null for any other caller. */
export function connectionScopes(ctx: Ctx): string[] | null {
  if (ctx.authKind === "oauth") return ctx.oauth?.scopes ?? [];
  if (ctx.playground) return ctx.playground.scopes;
  if (ctx.agentMcp) return ctx.agentMcp.scopes;
  return null;
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
export const credentialUsable: typeof credentialUsableImpl = (...args) => span("auth.credentialUsable", () => credentialUsableImpl(...args));
async function credentialUsableImpl(
  db: D1Database, identity: Identity, session: Session | null, apiToken: ApiToken | null, tenant: Tenant | null, via: "http" | "mcp" | "introspect" = "http", live?: AgentCredentialState,
): Promise<boolean> {
  if (identity.state !== "active") return false;
  // System-minted fixture credentials can never acquire authority in a real organization.
  if (identity.id === "perf-synthetic-member" && (tenant?.id !== "perf-synthetic-tenant" || session?.tenant_id !== "perf-synthetic-tenant" || apiToken !== null)) return false;
  if (via === "mcp" || (session !== null && session.kind === "oauth")) {
    return via === "mcp" && identity.kind === "human" && apiToken === null && session !== null && session.kind === "oauth"
      && tenant !== null && session.tenant_id === tenant.id;
  }
  // Git credentials (integration spec 4) count only for internal introspection, for their human, on their own tenant.
  if (session !== null && session.kind === "git") {
    return via === "introspect" && identity.kind === "human" && apiToken === null && tenant !== null && session.tenant_id === tenant.id;
  }
  // Repository-create sessions: minted and spent by the hub itself, only through introspection, on their own tenant.
  if (session !== null && session.kind === "repo_create") {
    return via === "introspect" && apiToken === null && tenant !== null && session.tenant_id === tenant.id;
  }
  if (via === "introspect" && (session === null || session.kind !== "agent_run")) return false;
  if (identity.kind === "human") return apiToken === null && session !== null && session.kind === "browser";
  if (session && session.parent_token_id === null) return false;
  if (session && session.kind !== "agent_run") return false;
  const pinned = session ? session.tenant_id : apiToken ? apiToken.tenant_id : null;
  if (!tenant || pinned !== tenant.id) return false;
  return agentCredentialOk(db, identity, tenant.id, session ? session.parent_token_id : null, live);
}

export const buildContext: typeof buildContextImpl = (...args) => span("auth.buildContext", () => buildContextImpl(...args));
async function buildContextImpl(request: Request, env: Env, now: number = Date.now(), waitUntil?: (p: Promise<unknown>) => void, opts: { longLivedToken?: boolean } = {}): Promise<Ctx> {
  const db = env.HUB_DB;
  const host = classifyHost(request.headers.get("host") ?? new URL(request.url).host, env.HUB_DOMAIN);

  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const cookieToken = readSessionToken(request);

  // One round trip for the common case (performance budget, overnight plan 2 N4): with a session token in hand, the
  // tenant, session, identity and membership rows come back in a single batch. Every check below still runs on them.
  const sessionToken = bearer && bearer.startsWith("pms_") ? bearer : !bearer && cookieToken ? cookieToken : null;
  // Page views also read rail counts. Chat transport is an API even though socket
  // reauthentication uses a GET-shaped request; never load UI aggregates there.
  const pageRequest = !/^\/(api|mcp|agent|p|chat)\b/.test(new URL(request.url).pathname);
  const pageBearer = bearer?.startsWith("pms_") && pageRequest;
  const wantRail = pageRequest && host.kind === "tenant" && request.method === "GET" && ((cookieToken !== null && !bearer) || !!pageBearer);
  const apiTokenText = opts.longLivedToken && bearer?.startsWith(API_TOKEN_PREFIX) ? bearer : null;
  const presented = sessionToken ?? apiTokenText;
  const pre = presented ? await prefetch(db, host.kind === "tenant" ? host.slug : null, await sha256Hex(presented), now, wantRail, request, !!bearer, !!apiTokenText) : null;

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
    if (opts.longLivedToken === true) apiToken = pre?.apiToken ?? null;
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
  else if (apiToken) identity = pre?.identity ?? null;
  if (identity && !(await credentialUsable(db, identity, session, apiToken, tenant, "http", pre?.agentState))) identity = null;
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
  ctx.pageUrl = request.url;
  if (pre?.rail && role && tenant) ctx.rail = pre.rail;
  if (pre?.explorer && role && tenant) ctx.explorer = pre.explorer;
  if (authKind === "bearer" && bearer && session?.kind === "agent_run") ctx.bearerToken = bearer;
  noteCtx(request, ctx);
  return ctx;
}

type Prefetched = { tenant: Tenant | null; session: Session | null; apiToken: ApiToken | null; identity: Identity | null; membership: Membership | null; agentState?: AgentCredentialState; rail: RailData | null; explorer: ExplorerData | null };

/** Request-local session/API-token and agent evidence; shared with service-only introspection. Never an auth cache. */
export async function prefetch(db: D1Database, slug: string | null, tokenHash: string, now: number, wantRail = false, request?: Request, wantAgentState = false, api = false): Promise<Prefetched> {
  const credential = api
    ? "SELECT * FROM api_token WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
    : "SELECT * FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?";
  const live = `SELECT identity_id FROM (${credential})`;
  const operator = `SELECT operator_id FROM identity WHERE id = (${live}) AND kind = 'agent'`;
  const rows = await db.batch([
    db.prepare("/*perf-site:src%2Fauth%2Fcontext.ts:214:5:prefetch:d9bfee79*/ SELECT * FROM tenant WHERE slug = ?").bind(slug),
    (api
      ? db.prepare("/*perf-site:src%2Fauth%2Fcontext.ts:216:9:prefetch:8c1fbc7f*/ SELECT * FROM api_token WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      : db.prepare("/*perf-site:src%2Fauth%2Fcontext.ts:217:9:prefetch:f39885ba*/ SELECT * FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    ).bind(tokenHash, now),
    db.prepare(`/*perf-site:src%2Fauth%2Fcontext.ts:219:5:prefetch:0e329609*/ SELECT * FROM identity WHERE id = (${live})`).bind(tokenHash, now),
    db.prepare(`/*perf-site:src%2Fauth%2Fcontext.ts:220:5:prefetch:8dcf294c*/ SELECT * FROM membership WHERE identity_id = (${live}) AND tenant_id = (SELECT id FROM tenant WHERE slug = ?)`).bind(tokenHash, now, slug),
    ...(wantAgentState ? [
      db.prepare("/*perf-site:src%2Fauth%2Fcontext.ts:222:7:prefetch:c6452254*/ SELECT identity_id, tenant_id, revoked_at FROM api_token WHERE id = (SELECT parent_token_id FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?)").bind(tokenHash, now),
      db.prepare(`/*perf-site:src%2Fauth%2Fcontext.ts:223:7:prefetch:e2bf791f*/ SELECT * FROM identity WHERE id = (${operator})`).bind(tokenHash, now),
      db.prepare(`/*perf-site:src%2Fauth%2Fcontext.ts:224:7:prefetch:8d0c0d76*/ SELECT * FROM membership WHERE identity_id = (${operator}) AND tenant_id = (SELECT id FROM tenant WHERE slug = ?)`).bind(tokenHash, now, slug),
    ] : []),
    ...(wantRail ? [railStatement(db, slug, live, tokenHash, now), explorerStatement(db, slug, live, tokenHash, now, request!)] : []),
  ]);
  const [t, s, i, m] = rows;
  const [parent, op, om] = wantAgentState ? rows.slice(4, 7) : [];
  const [rc, ec] = wantRail ? rows.slice(wantAgentState ? 7 : 4) : [];
  const one = <T>(r: D1Result<unknown> | undefined): T | null => ((r?.results[0] as T | undefined) ?? null);
  const counts = one<Omit<RailData, "projects"> & { projects: string }>(rc);
  const rail: RailData | null = wantRail && counts ? { ...counts, projects: JSON.parse(counts.projects) } : null;
  const row = one<Omit<ExplorerData, "choices" | "channels" | "inProject" | "sites" | "repositories"> & { choices: string; channels: string; sites: string; repositories: string; inProject: number }>(ec);
  const explorer = row ? { ...row, choices: JSON.parse(row.choices), repositories: JSON.parse(row.repositories), sites: JSON.parse(row.sites), channels: JSON.parse(row.channels), inProject: !!row.inProject } : null;
  return { tenant: one<Tenant>(t), session: api ? null : one<Session>(s), apiToken: api ? one<ApiToken>(s) : null, identity: one<Identity>(i), membership: one<Membership>(m), ...(wantAgentState ? { agentState: { parent: one<AgentCredentialState["parent"]>(parent), own: one<Membership>(m), operator: one<Identity>(op), operatorMembership: one<Membership>(om) } } : {}), rail, explorer };
}

/** Preferences select only tenant-authorized projects; they never grant access. */
function explorerStatement(db: D1Database, slug: string | null, live: string, tokenHash: string, now: number, request: Request): D1PreparedStatement {
  let path = "", requested = "", remembered = "";
  try { const url = new URL(request.url); path = decodeURIComponent(url.pathname.split("/")[1] ?? ""); requested = url.searchParams.get("project") ?? url.searchParams.get("work")?.split("#")[0] ?? ""; } catch { /* invalid URL component */ }
  try { remembered = decodeURIComponent(/(?:^|;\s*)pmw_project=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? ""); } catch { /* invalid preference */ }
  return db.prepare(`/*perf-site:src%2Fauth%2Fcontext.ts:244:10:explorerStatement:14a0c8b4*/ WITH target AS MATERIALIZED (SELECT id FROM tenant WHERE slug = ?),
    actor AS MATERIALIZED (${live}),
    choices AS MATERIALIZED (
      SELECT p.*, p.slug AS path FROM project p
      WHERE p.tenant_id = (SELECT id FROM target) AND p.kind NOT IN ('channel', 'agent-src') AND p.namespace_id IS NULL
    ), selected AS MATERIALIZED (
      SELECT *, path = ? AS inProject FROM choices
      ORDER BY CASE WHEN path = ? THEN 0 WHEN path = ? THEN 1 WHEN (SELECT identity_id FROM actor) || ':' || path = ? THEN 2 ELSE 3 END,
        state <> 'active', display_name, path LIMIT 1
    ), channels AS MATERIALIZED (
      SELECT c.slug, c.display_name, (SELECT COUNT(*) FROM msg_index m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.state = 'live' AND m.rev = (SELECT MAX(h.rev) FROM msg_index h WHERE h.tenant_id = m.tenant_id AND h.conversation_id = m.conversation_id AND h.msg_id = m.msg_id)) AS count
      FROM project c JOIN channel ch ON ch.project_id = c.id AND ch.tenant_id = c.tenant_id
      JOIN meta ON meta.key = 'project_channel:v1:' || c.tenant_id || ':' || c.id
      WHERE c.tenant_id = (SELECT id FROM target) AND c.state = 'active' AND meta.value = (SELECT id FROM selected)
        AND ((SELECT kind FROM identity WHERE id = (SELECT identity_id FROM actor)) = 'human'
          OR EXISTS (SELECT 1 FROM conversation_member cm WHERE cm.tenant_id = c.tenant_id AND cm.conversation_id = c.id AND cm.identity_id = (SELECT identity_id FROM actor) AND cm.removed_at IS NULL))
      ORDER BY c.slug
    ) SELECT p.path, p.display_name, p.kind, p.parts, p.inProject,
      (SELECT json_group_array(json_object('name', s.name)) FROM site s WHERE s.tenant_id = p.tenant_id AND s.project_id = p.id) AS sites,
      (SELECT json_group_array(json_object('name', r.name, 'is_default', r.is_default)) FROM repository r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id) AS repositories,
      (SELECT json_group_array(json_object('path', path, 'display_name', display_name)) FROM (SELECT path, display_name FROM choices WHERE state = 'active' OR path = p.path ORDER BY display_name, path)) AS choices,
      (SELECT json_group_array(json_object('slug', slug, 'display_name', display_name, 'count', count)) FROM channels) AS channels,
      (SELECT COUNT(*) FROM work_item w WHERE w.tenant_id = p.tenant_id AND w.project_id = p.id AND w.state IN ('open','doing')) AS open,
      (SELECT COUNT(*) FROM review r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id AND r.status IN ('open','approved','changes')) AS reviews,
      (SELECT COUNT(*) FROM app_deploy r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id) AS deploys,
      (SELECT COUNT(*) FROM wiki_revision r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id AND r.deleted = 0 AND r.revision = (SELECT MAX(h.revision) FROM wiki_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.slug = r.slug)) AS wiki,
      (SELECT COUNT(*) FROM wiki_revision r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id AND r.deleted = 0 AND r.research IS NOT NULL AND r.revision = (SELECT MAX(h.revision) FROM wiki_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.slug = r.slug)) AS research,
      (SELECT COUNT(*) FROM file_revision r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id AND r.deleted = 0 AND r.revision = (SELECT MAX(h.revision) FROM file_revision h WHERE h.tenant_id = r.tenant_id AND h.project_id = r.project_id AND h.path = r.path)) AS files,
      (SELECT COUNT(*) FROM contact_entity r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id) AS contacts,
      (SELECT COUNT(*) FROM inbound_mail r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id AND r.recipient_id IS NULL AND r.verdict = 'admitted') AS mail
    FROM selected p`).bind(slug, tokenHash, now, path, path, requested, remembered);
}

/** One request-local aggregate serves both project badges and uncapped work totals. */
function railStatement(db: D1Database, slug: string | null, live: string, tokenHash: string, now: number): D1PreparedStatement {
  // No cross-request cache: writes, identity changes and access revocation need no
  // invalidation hooks. The sign-in checks still gate attaching this data to ctx.
  return db.prepare(`/*perf-site:src%2Fauth%2Fcontext.ts:281:10:railStatement:df17ef5a*/ WITH target AS MATERIALIZED (SELECT id FROM tenant WHERE slug = ?),
      actor AS MATERIALIZED (${live}),
      work_counts AS MATERIALIZED (
        SELECT p.id AS project_id, COUNT(*) AS open,
          SUM(w.owner_id = (SELECT identity_id FROM actor)) AS mine
        FROM project p JOIN work_item w ON w.project_id = p.id AND w.tenant_id = p.tenant_id
        WHERE p.tenant_id = (SELECT id FROM target) AND w.state IN ('open', 'doing')
        GROUP BY p.id
      ),
      project_rows AS (
        SELECT p.slug, p.display_name, COALESCE(c.open, 0) AS open
        FROM project p LEFT JOIN work_counts c ON c.project_id = p.id
        WHERE p.tenant_id = (SELECT id FROM target) AND p.kind NOT IN ('channel', 'agent-src') AND p.state = 'active'
        ORDER BY p.display_name, p.slug LIMIT 60
      )
      SELECT (SELECT json_group_array(json_object('slug', slug, 'display_name', display_name, 'open', open)) FROM project_rows) AS projects,
        COALESCE((SELECT SUM(open) FROM work_counts), 0) AS open,
        COALESCE((SELECT SUM(mine) FROM work_counts), 0) AS mine,
        (SELECT COUNT(*) FROM inbound_mail WHERE tenant_id = (SELECT id FROM target) AND verdict = 'quarantined' AND released_at IS NULL) AS held,
        (SELECT COUNT(*) FROM attention WHERE tenant_id = (SELECT id FROM target) AND identity_id = (SELECT identity_id FROM actor) AND done_at IS NULL) AS needs`)
    .bind(slug, tokenHash, now);
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
