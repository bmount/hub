import type { Env } from "../env";
import { ArtifactsRest, isValidationCache } from "./artifactsRest";
import { HubError } from "../errors";
import { repoOwnership } from "./artifactPush";

/** Expire only explicitly owned scratch data. Never retry an uncertain published push. */
export async function cleanupGitStages(env: Env, now: number): Promise<{ cleaned: number; failed: number }> {
  if (!env.GIT_PUSH_STAGING) return { cleaned: 0, failed: 0 };
  const rows = (await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FgitStageCleanup.ts:8:23:cleanupGitStages:4363a47a*/ SELECT id, tenant_id, project_id, namespace, repo, shadow, replay_key FROM git_push WHERE state IN ('complete', 'refused', 'staging') AND created_at < ? AND replay_key <> '' ORDER BY created_at LIMIT 20")
    .bind(now - 24 * 3600_000).all<{ id: string; tenant_id: string; project_id: string; namespace: string; repo: string; shadow: string; replay_key: string }>()).results;
  const api = new ArtifactsRest(env), checked = new Set<string>();let cleaned = 0, failed = 0;
  for (const row of rows) {
    try {
      try {
        if (!isValidationCache(row.shadow)) {
          await api.deleteTemporary(row.namespace, row.shadow, row.id);
          checked.add(`${row.namespace}/${row.shadow}`);
        }
        else {
          const active = await env.HUB_DB.prepare("SELECT 1 FROM git_push WHERE namespace = ? AND shadow = ? AND (state IN ('publishing', 'unknown') OR created_at >= ?) LIMIT 1")
            .bind(row.namespace, row.shadow, now - 24 * 3600_000).first();
          if (!active) {
            await api.cleanupIncompleteValidation(row.namespace, row.repo, repoOwnership(row.tenant_id, row.project_id));
            checked.add(`${row.namespace}/${row.shadow}`);
          }
        }
      }
      catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
      await env.GIT_PUSH_STAGING.delete(row.replay_key);
      await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FgitStageCleanup.ts:16:13:cleanupGitStages:cc9c6c70*/ UPDATE git_push SET replay_key = '' WHERE id = ?").bind(row.id).run();
      cleaned++;
    } catch { failed++; }
  }
  // Creation may fail before saving a replay, and project deletion may have removed its push rows.
  // Durable reservations are independently retryable until upstream absence is confirmed.
  const forks = (await env.HUB_DB.prepare("SELECT namespace, target, source, description FROM artifact_fork_ownership f WHERE account = ? AND proof <> 'ready' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM git_push p WHERE p.namespace = f.namespace AND (p.shadow = f.target OR p.repo = f.source) AND (p.state IN ('publishing', 'unknown') OR p.created_at >= ?)) ORDER BY created_at LIMIT 20")
    .bind(api.account, now - 24 * 3600_000, now - 24 * 3600_000).all<{ namespace: string; target: string; source: string; description: string }>()).results;
  for (const fork of forks) {
    if (checked.has(`${fork.namespace}/${fork.target}`)) continue;
    try {
      if (isValidationCache(fork.target)) {
        const suffix = ` validation cache for ${fork.source}`;
        if (!fork.description.endsWith(suffix)) throw new Error("invalid cache ownership evidence");
        if (await api.cleanupIncompleteValidation(fork.namespace, fork.source, fork.description.slice(0, -suffix.length))) cleaned++;
      } else {
        await api.deleteTemporary(fork.namespace, fork.target, fork.target.slice("pimwell-stage-".length));
        cleaned++;
      }
    } catch { failed++; }
  }
  return { cleaned, failed };
}
