import type { Env } from "../env";
import { credentialUsable, rank, roleFor } from "../auth/context";
import { getSessionByToken, touchSession } from "../db/sessions";
import { getIdentityById } from "../db/identities";
import { getMembership } from "../db/memberships";
import { getTenantBySlug } from "../db/tenants";
import type { Identity, Role, Session, Tenant } from "../db/types";

export type GitGrant = {
  identity: Identity; session: Session; tenant: Tenant;
  project: { id: string; slug: string }; write: boolean; refPrefixes?: string[];
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
  const [session, tenant] = await Promise.all([getSessionByToken(env.HUB_DB, token, now), getTenantBySlug(env.HUB_DB, tenantSlug)]);
  if (!session || !tenant || tenant.state !== "active" || !["git", "agent_run"].includes(session.kind)) return null;
  const identity = await getIdentityById(env.HUB_DB, session.identity_id);
  if (!identity || !await credentialUsable(env.HUB_DB, identity, session, null, tenant, "introspect")) return null;
  let role = roleFor(identity, await getMembership(env.HUB_DB, identity.id, tenant.id));
  if (!role || rank(role) < rank("reader")) return null;
  if (identity.kind === "agent") {
    const sponsor = identity.operator_id ? await getIdentityById(env.HUB_DB, identity.operator_id) : null;
    if (!sponsor || sponsor.state !== "active") return null;
    const sponsorRole = roleFor(sponsor, await getMembership(env.HUB_DB, sponsor.id, tenant.id));
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
  const { identity, session, tenant, role } = caller;
  const project = await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FgitAccess.ts:47:25:authorizeGit:abead50e*/ SELECT id, slug FROM project WHERE tenant_id = ? AND slug = ? AND kind = 'repo'")
    .bind(tenant.id, repo).first<{ id: string; slug: string }>();
  if (!project) return null;
  if (session.kind === "git") await touchSession(env.HUB_DB, session, now);
  return { identity, session, tenant, project, write: rank(role) >= rank("member") };
}
