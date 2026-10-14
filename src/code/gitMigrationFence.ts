import type { Env } from "../env";

type MigrationRepo = { tenant_id: string; project_id: string; legacy_write_fenced_at: number | null };

export async function migrationRepo(env: Env, tenant: string, repo: string): Promise<MigrationRepo | null> {
  return await env.HUB_DB.prepare(`/*perf-site:src%2Fcode%2FgitMigrationFence.ts:6:16:migrationRepo:ea58ecfd*/ SELECT g.tenant_id, g.project_id, g.legacy_write_fenced_at FROM git_repository g JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id JOIN tenant t ON t.id = g.tenant_id WHERE t.slug = ? AND p.slug = ?`)
    .bind(tenant, repo).first<MigrationRepo>();
}

export async function startLegacyForward(env: Env, repo: MigrationRepo, name: string, path: string, now = Date.now()): Promise<string> {
  const id = crypto.randomUUID();
  await env.HUB_DB.prepare(`/*perf-site:src%2Fcode%2FgitMigrationFence.ts:12:9:startLegacyForward:8368b5d7*/ INSERT INTO git_legacy_forward (id, tenant_id, project_id, repo, path, state, created_at) VALUES (?, ?, ?, ?, ?, 'forwarding', ?)`).bind(id, repo.tenant_id, repo.project_id, name, path, now).run();
  return id;
}

export async function finishLegacyForward(env: Env, id: string, state: "complete" | "unknown", status: number | null, now = Date.now()): Promise<void> {
  await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FgitMigrationFence.ts:17:9:finishLegacyForward:2e1667ca*/ UPDATE git_legacy_forward SET state = ?, status = ?, completed_at = ? WHERE id = ? AND state = 'forwarding'").bind(state, status, now, id).run();
}
