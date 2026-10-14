// Agents' own source repositories (docs/ops/agent-src.md): https://<org>.pimwell.com/agent-src/<agent>.git. An agent
// keeps its directions and runtime there as a backup that its operator can inspect. It is not team work: the hidden
// project behind it (kind 'agent-src') appears in no project list, Docket, search or status, and /<name>.git can't
// reach it. The agent and its operator read and push; organization admins read; everyone else gets not found.
import type { Env } from "../env";
import { HubError } from "../errors";
import { ulid } from "../ids";
import { rank } from "../auth/context";
import { touchSession } from "../db/sessions";
import { ArtifactsRest, artifactNamespace } from "./artifactsRest";
import { repoOwnership } from "./artifactPush";
import { gitCaller, type GitGrant } from "./gitAccess";
import type { Identity, Tenant } from "../db/types";

export const AGENT_SRC = "agent-src";

/** The storage name: by id, so a renamed agent keeps its history and a reused name never inherits another's. */
export const agentSrcSlug = (agentId: string) => `${AGENT_SRC}.${agentId.toLowerCase()}`;

/** An active agent in this organization whose address is <org>.<name>@…, as everywhere else in Pimwell. */
export async function agentByName(db: D1Database, tenant: Tenant, name: string): Promise<Identity | null> {
  // A reserved alias never falls through to a reused canonical name, even if its target is archived.
  const alias = await db.prepare("/*perf-site:src%2Fcode%2FagentSrc.ts:23:23:agentByName:e5789e5d*/ SELECT identity_id FROM agent_source_alias WHERE tenant_id = ? AND alias = ?")
    .bind(tenant.id, name.toLowerCase()).first<{ identity_id: string }>();
  if (alias) return db.prepare(`/*perf-site:src%2Fcode%2FagentSrc.ts:25:21:agentByName:d8fdc034*/ SELECT i.* FROM identity i JOIN membership m ON m.identity_id = i.id
    WHERE m.tenant_id = ? AND m.state = 'active' AND i.id = ? AND i.kind = 'agent' AND i.state = 'active'`)
    .bind(tenant.id, alias.identity_id).first<Identity>();
  return db.prepare(`/*perf-site:src%2Fcode%2FagentSrc.ts:28:10:agentByName:b88b1bad*/ SELECT i.* FROM identity i JOIN membership m ON m.identity_id = i.id AND m.tenant_id = ? AND m.state = 'active'
    WHERE i.kind = 'agent' AND i.state = 'active' AND substr(i.email, instr(i.email, '.') + 1, instr(i.email, '@') - instr(i.email, '.') - 1) = ?`)
    .bind(tenant.id, name.toLowerCase()).first<Identity>();
}

export type AgentSrcAccess = { write: boolean } | null;

/** The agent and its operator may read and push; organization admins may read. */
export function agentSrcAccess(caller: { identity: Pick<Identity, "id">; role: string }, agent: Pick<Identity, "id" | "operator_id">): AgentSrcAccess {
  if (caller.identity.id === agent.id || caller.identity.id === agent.operator_id) return { write: true };
  if (rank(caller.role as never) >= rank("admin")) return { write: false };
  return null;
}

/**
 * A grant for /agent-src/<name>.git, creating the repository the first time the agent or its operator reaches for
 * it. "unauthenticated" asks git for credentials; "not_found" hides that the agent or repository exists.
 */
export async function agentSrcGrant(env: Env, authorization: string | null, tenantSlug: string, name: string, now = Date.now()): Promise<GitGrant | "unauthenticated" | "not_found"> {
  const caller = await gitCaller(env, authorization, tenantSlug, now);
  if (!caller) return "unauthenticated";
  const agent = await agentByName(env.HUB_DB, caller.tenant, name);
  const access = agent ? agentSrcAccess(caller, agent) : null;
  if (!agent || !access) return "not_found";
  const slug = agentSrcSlug(agent.id);
  let project = await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FagentSrc.ts:53:23:agentSrcGrant:abead50e*/ SELECT id, slug FROM project WHERE tenant_id = ? AND slug = ? AND kind = ?").bind(caller.tenant.id, slug, AGENT_SRC).first<{ id: string; slug: string }>();
  if (!project) {
    if (!access.write) return "not_found";
    project = await createAgentSrc(env, caller.tenant, agent, slug, now);
  }
  if (caller.session.kind === "git") await touchSession(env.HUB_DB, caller.session, now);
  return { identity: caller.identity, session: caller.session, tenant: caller.tenant, project, write: access.write };
}

async function createAgentSrc(env: Env, tenant: Tenant, agent: Identity, slug: string, now: number): Promise<{ id: string; slug: string }> {
  if (env.GIT_BACKEND !== "artifacts") throw new HubError(503, "unavailable", "agent source repositories need Artifacts storage");
  const id = ulid(now);
  await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FagentSrc.ts:65:9:createAgentSrc:2cbef356*/ INSERT INTO project (id, tenant_id, namespace_id, slug, kind, display_name, state, created_at) VALUES (?, ?, NULL, ?, ?, ?, 'active', ?) ON CONFLICT DO NOTHING")
    .bind(id, tenant.id, slug, AGENT_SRC, `${agent.display_name} (agent source)`, now).run();
  // Two first pushes at once: whoever inserted first owns the row; the other uses it.
  const project = (await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FagentSrc.ts:68:26:createAgentSrc:abead50e*/ SELECT id, slug FROM project WHERE tenant_id = ? AND slug = ? AND kind = ?").bind(tenant.id, slug, AGENT_SRC).first<{ id: string; slug: string }>())!;
  const api = new ArtifactsRest(env), namespace = artifactNamespace(tenant.slug), ownership = repoOwnership(tenant.id, project.id);
  try {
    const info = await api.info(namespace, slug);
    if (info.description !== ownership) throw new HubError(409, "conflict", "agent source storage name is already owned");
  } catch (error) {
    if (!(error instanceof HubError) || error.status !== 404) throw error;
    await api.create(namespace, slug, ownership);
  }
  await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FagentSrc.ts:77:9:createAgentSrc:7ea63596*/ INSERT OR IGNORE INTO git_repository (tenant_id, project_id, imported_at) VALUES (?, ?, ?)").bind(tenant.id, project.id, now).run();
  return project;
}
