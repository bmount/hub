import type { Env } from "../env";
import { ArtifactsRest } from "./artifactsRest";
import { HubError } from "../errors";

/** Expire only explicitly owned scratch data. Never retry an uncertain published push. */
export async function cleanupGitStages(env: Env, now: number): Promise<{ cleaned: number; failed: number }> {
  if (!env.GIT_PUSH_STAGING) return { cleaned: 0, failed: 0 };
  const rows = (await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FgitStageCleanup.ts:8:23:cleanupGitStages:e2a4bc46*/ SELECT id, namespace, shadow, replay_key FROM git_push WHERE state IN ('complete', 'refused', 'staging') AND created_at < ? AND replay_key <> '' ORDER BY created_at LIMIT 20")
    .bind(now - 24 * 3600_000).all<{ id: string; namespace: string; shadow: string; replay_key: string }>()).results;
  const api = new ArtifactsRest(env);let cleaned = 0, failed = 0;
  for (const row of rows) {
    try {
      try { await api.deleteTemporary(row.namespace, row.shadow, row.id); }
      catch (error) { if (!(error instanceof HubError) || error.status !== 404) throw error; }
      await env.GIT_PUSH_STAGING.delete(row.replay_key);
      await env.HUB_DB.prepare("/*perf-site:src%2Fcode%2FgitStageCleanup.ts:16:13:cleanupGitStages:cc9c6c70*/ UPDATE git_push SET replay_key = '' WHERE id = ?").bind(row.id).run();
      cleaned++;
    } catch { failed++; }
  }
  return { cleaned, failed };
}
