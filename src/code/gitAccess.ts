import { repositoryName, type Repository } from "./repositories";
import type { Env } from "../env";
import { credentialUsable, rank, roleFor } from "../auth/context";
import { touchSession } from "../db/sessions";
import { sha256Hex } from "../ids";
import type { AgentCredentialState } from "../auth/agent";
import type { Identity, Membership, Role, Session, Tenant } from "../db/types";

export type GitGrant = {
  identity: Identity; session: Session; tenant: Tenant;
  project: { id: string; slug: string }; repository?: { name: string; storage_name: string; is_default: number }; write: boolean; refPrefixes?: string[];
};

export type GitCaller = { identity: Identity; session: Session; tenant: Tenant; role: Role };

type RepositoryRow = { id: string; slug: string; tenant_id: string } & { [K in keyof Repository]: Repository[K] | null };

/** Who is calling, from a git session or agent run token, with an agent capped at its operator's role. Live checks every time. */
export async function gitCaller(env: Env, authorization: string | null, tenantSlug: string, now = Date.now()): Promise<GitCaller | null> {
  return (await gitSnapshot(env, authorization, tenantSlug, now))?.caller ?? null;
}
async function gitSnapshot(env: Env, authorization: string | null, tenantSlug: string, now: number, repository?: D1PreparedStatement): Promise<{ caller: GitCaller; repository?: RepositoryRow } | null> {
  if (!authorization || authorization.length > 512 || !/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization)) return null;
  let decoded: string;
  try { decoded = atob(authorization.slice(6)); } catch { return null; }
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  const token = decoded.slice(separator + 1);
  if (!token.startsWith("pms_") || token.length > 128) return null;
  const hash = await sha256Hex(token), db = env.HUB_DB;
  // All credential, membership and operator rows are fresh in one snapshot/trip.
  // Subqueries remain pinned to the presented session and requested tenant.
  const rows = await db.batch([
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:34:5:gitSnapshot:f39885ba*/ SELECT * FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?").bind(hash, now),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:35:5:gitSnapshot:d9bfee79*/ SELECT * FROM tenant WHERE slug = ?").bind(tenantSlug),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:36:5:gitSnapshot:637081ed*/ SELECT i.* FROM identity i JOIN session s ON s.identity_id = i.id WHERE s.token_hash = ?").bind(hash),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:37:5:gitSnapshot:6db83284*/ SELECT m.* FROM membership m JOIN session s ON s.identity_id = m.identity_id JOIN tenant t ON t.id = m.tenant_id WHERE s.token_hash = ? AND t.slug = ?").bind(hash, tenantSlug),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:38:5:gitSnapshot:37a7b1f3*/ SELECT op.* FROM identity op JOIN identity i ON i.operator_id = op.id JOIN session s ON s.identity_id = i.id WHERE s.token_hash = ?").bind(hash),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:39:5:gitSnapshot:fbfe80b0*/ SELECT m.* FROM membership m JOIN identity i ON i.operator_id = m.identity_id JOIN session s ON s.identity_id = i.id JOIN tenant t ON t.id = m.tenant_id WHERE s.token_hash = ? AND t.slug = ?").bind(hash, tenantSlug),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:40:5:gitSnapshot:98dff320*/ SELECT p.identity_id, p.tenant_id, p.revoked_at FROM api_token p JOIN session s ON s.parent_token_id = p.id WHERE s.token_hash = ?").bind(hash),
    ...(repository ? [repository] : []),
  ]);
  const session = rows[0]!.results[0] as Session | undefined, tenant = rows[1]!.results[0] as Tenant | undefined;
  if (!session || !tenant || tenant.state !== "active" || !["git", "agent_run"].includes(session.kind)) return null;
  const identity = rows[2]!.results[0] as Identity | undefined;
  const live: AgentCredentialState = {
    own: rows[3]!.results[0] as Membership ?? null,
    operator: rows[4]!.results[0] as Identity ?? null,
    operatorMembership: rows[5]!.results[0] as Membership ?? null,
    parent: rows[6]!.results[0] as AgentCredentialState["parent"] ?? null,
  };
  if (!identity || !await credentialUsable(env.HUB_DB, identity, session, null, tenant, "introspect", live)) return null;
  let role = roleFor(identity, live.own);
  if (!role || rank(role) < rank("reader")) return null;
  if (identity.kind === "agent") {
    const sponsor = live.operator;
    if (!sponsor || sponsor.state !== "active") return null;
    const sponsorRole = roleFor(sponsor, live.operatorMembership);
    if (!sponsorRole || rank(sponsorRole) < rank("reader")) return null;
    if (rank(sponsorRole) < rank(role)) role = sponsorRole;
    if (rank(role) > rank("member")) role = "member";
  }
  return { caller: { identity, session, tenant, role }, repository: rows[7]?.results[0] as RepositoryRow | undefined };
}

/** Check live credentials and repository mapping together, even for cached storage tokens. */
export async function authorizeGit(env: Env, authorization: string | null, tenantSlug: string, repo: string, now = Date.now()): Promise<GitGrant | null> {
  const query = repositoryQuery(env.HUB_DB, tenantSlug, repo);
  if (!query) return null;
  const snapshot = await gitSnapshot(env, authorization, tenantSlug, now, query);
  return snapshot ? repositoryGrant(env, snapshot.caller, repo, snapshot.repository, now) : null;
}

/** Resolve repository access using a caller already authorized in this request. */
export async function authorizeGitRepository(env: Env, caller: GitCaller, repo: string, now = Date.now()): Promise<GitGrant | null> {
  const query = repositoryQuery(env.HUB_DB, caller.tenant.slug, repo);
  return query ? repositoryGrant(env, caller, repo, await query.first<RepositoryRow>() ?? undefined, now) : null;
}
function repositoryQuery(db: D1Database, tenantSlug: string, repo: string): D1PreparedStatement | null {
  const [projectSlug, repoName, extra] = repo.split("/");
  if (extra !== undefined) return null;
  try { if (repoName) repositoryName(repoName); } catch { return null; }
  return db.prepare(`/*perf-site:src%2Fcode%2FgitAccess.ts:83:10:repositoryQuery:33ba07de*/ SELECT p.id, p.slug, p.tenant_id, r.name, r.storage_name, r.is_default FROM project p
    LEFT JOIN repository r ON r.tenant_id = p.tenant_id AND r.project_id = p.id AND ${repoName ? "r.name = ?" : "r.is_default = 1"}
    WHERE p.tenant_id = (SELECT id FROM tenant WHERE slug = ?) AND p.slug = ? AND p.kind NOT IN ('channel','agent-src') AND EXISTS (SELECT 1 FROM json_each(p.parts) WHERE value = 'repo') AND p.state = 'active'`)
    .bind(...(repoName ? [repoName] : []), tenantSlug, projectSlug);
}
async function repositoryGrant(env: Env, caller: GitCaller, repo: string, row: RepositoryRow | undefined, now: number): Promise<GitGrant | null> {
  const { identity, session, tenant, role } = caller;
  if (!row || row.tenant_id !== tenant.id || (repo.split("/")[1] && !row.name)) return null;
  const project = { id: row.id, slug: row.slug };
  const repository = row.name && row.storage_name !== null && row.is_default !== null
    ? { name: row.name, storage_name: row.storage_name, is_default: row.is_default } : undefined;
  if (session.kind === "git") await touchSession(env.HUB_DB, session, now);
  return { identity, session, tenant, project, repository, write: rank(role) >= rank("member") };
}
