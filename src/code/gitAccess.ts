import { resolveRepository } from "./repositories";
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

/** Who is calling, from a git session or agent run token, with an agent capped at its operator's role. Live checks every time. */
export async function gitCaller(env: Env, authorization: string | null, tenantSlug: string, now = Date.now()): Promise<GitCaller | null> {
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
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:29:5:gitCaller:f39885ba*/ SELECT * FROM session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?").bind(hash, now),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:30:5:gitCaller:d9bfee79*/ SELECT * FROM tenant WHERE slug = ?").bind(tenantSlug),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:31:5:gitCaller:637081ed*/ SELECT i.* FROM identity i JOIN session s ON s.identity_id = i.id WHERE s.token_hash = ?").bind(hash),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:32:5:gitCaller:6db83284*/ SELECT m.* FROM membership m JOIN session s ON s.identity_id = m.identity_id JOIN tenant t ON t.id = m.tenant_id WHERE s.token_hash = ? AND t.slug = ?").bind(hash, tenantSlug),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:33:5:gitCaller:37a7b1f3*/ SELECT op.* FROM identity op JOIN identity i ON i.operator_id = op.id JOIN session s ON s.identity_id = i.id WHERE s.token_hash = ?").bind(hash),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:34:5:gitCaller:fbfe80b0*/ SELECT m.* FROM membership m JOIN identity i ON i.operator_id = m.identity_id JOIN session s ON s.identity_id = i.id JOIN tenant t ON t.id = m.tenant_id WHERE s.token_hash = ? AND t.slug = ?").bind(hash, tenantSlug),
    db.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:35:5:gitCaller:98dff320*/ SELECT p.identity_id, p.tenant_id, p.revoked_at FROM api_token p JOIN session s ON s.parent_token_id = p.id WHERE s.token_hash = ?").bind(hash),
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
  return { identity, session, tenant, role };
}

/** Check live credentials even if a storage token was cached for an earlier request. */
export async function authorizeGit(env: Env, authorization: string | null, tenantSlug: string, repo: string, now = Date.now()): Promise<GitGrant | null> {
  const caller = await gitCaller(env, authorization, tenantSlug, now);
  if (!caller) return null;
  return authorizeGitRepository(env, caller, repo, now);
}

/** Resolve repository access using a caller already authorized in this request. */
export async function authorizeGitRepository(env: Env, caller: GitCaller, repo: string, now = Date.now()): Promise<GitGrant | null> {
  const { identity, session, tenant, role } = caller;
  const [projectSlug, repoName, extra] = repo.split("/");
  if (extra !== undefined) return null;
  const project = await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:72:25:authorizeGitRepository:0211670a*/ SELECT id, slug FROM project WHERE tenant_id = ? AND slug = ? AND kind IN ('repo', 'workspace') AND state = 'active'")
    .bind(tenant.id, projectSlug).first<{ id: string; slug: string }>();
  if (!project) return null;
  let repository;
  try { repository = await resolveRepository(env.HUB_DB, tenant.id, project.id, repoName); }
  catch { if (repoName) return null; }
  if (session.kind === "git") await touchSession(env.HUB_DB, session, now);
  return { identity, session, tenant, project, repository, write: rank(role) >= rank("member") };
}
