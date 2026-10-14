import { sha256Hex } from "../ids";
import type { Env } from "../env";
import { badRequest, conflict, notFound, HubError } from "../errors";
import { ArtifactsRest, artifactNamespace } from "./artifactsRest";
import { repoOwnership } from "./artifactPush";

export type Repository = { name: string; storage_name: string; is_default: number };
export function repositoryName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw badRequest("repository names use lowercase letters, digits and hyphens (1–63 characters)");
  return name;
}
export async function resolveRepository(db: D1Database, tenant: string, project: string, name?: string | null): Promise<Repository> {
  const row = await db.prepare(`SELECT name, storage_name, is_default FROM repository WHERE tenant_id = ? AND project_id = ? AND ${name ? "name = ?" : "is_default = 1"}`)
    .bind(tenant, project, ...(name ? [repositoryName(name)] : [])).first<Repository>();
  if (!row) throw notFound("no such repository");
  return row;
}
export async function createRepository(env: Env, tenant: {id: string; slug: string}, project: {id: string; slug: string}, name: string, now: number): Promise<Repository> {
  repositoryName(name);
  const live = await env.HUB_DB.prepare("SELECT 1 FROM project WHERE tenant_id = ? AND id = ? AND state = 'active' AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'project_delete:v1:' || project.tenant_id || ':' || project.id)").bind(tenant.id, project.id).first();
  if (!live) throw conflict("project is archived or being deleted");
  if (env.GIT_BACKEND !== "artifacts") throw new HubError(503, "unavailable", "multiple repositories require Artifacts");
  const existing = await env.HUB_DB.prepare("SELECT name, storage_name, is_default FROM repository WHERE tenant_id = ? AND project_id = ? AND name = ?").bind(tenant.id, project.id, name).first<Repository>();
  if (existing) return existing;
  // Internal ids keep names disjoint from both old project names and staging repos.
  const storage = `repo-${(await sha256Hex(`${project.id}/${name}`)).slice(0, 48)}`, api = new ArtifactsRest(env), ns = artifactNamespace(tenant.slug);
  const ownership = repoOwnership(tenant.id, project.id);
  try {
    const info = await api.info(ns, storage);
    if (info.description !== ownership) throw new HubError(409, "conflict", "repository storage name is already owned");
  } catch (error) {
    if (!(error instanceof HubError) || error.status !== 404) throw error;
    await api.create(ns, storage, ownership);
  }
  await env.HUB_DB.prepare("INSERT OR IGNORE INTO repository (tenant_id, project_id, name, storage_name, is_default, created_at) SELECT ?, ?, ?, ?, NOT EXISTS(SELECT 1 FROM repository WHERE project_id = ? AND is_default = 1), ?").bind(tenant.id, project.id, name, storage, project.id, now).run();
  return resolveRepository(env.HUB_DB, tenant.id, project.id, name);
}
