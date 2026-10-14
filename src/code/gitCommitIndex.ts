import { HubError } from "../errors";
export type CommitNode = { hash: string; treeHash: string; parents: string[]; committedAt: number };

/** Small derived metadata, not Git objects. Supports Ardi-compatible all-parent history ordering. */
export async function indexCommitNodes(db: D1Database, tenantId: string, projectId: string, nodes: CommitNode[], repo = ""): Promise<void> {
  if (!nodes.length) return;
  const generations = new Map<string, number>(), needed = [...new Set(nodes.flatMap(node => node.parents))];
  for (let offset = 0; offset < needed.length; offset += 100) {
    const ids = needed.slice(offset, offset + 100);
    const rows = (await db.prepare(`/*perf-site:src%2Fcode%2FgitCommitIndex.ts:10:25:indexCommitNodes:ab52df74*/ SELECT oid, generation FROM repository_commit WHERE tenant_id = ? AND project_id = ? AND repo = ? AND oid IN (${ids.map(() => "?").join(",")})`)
      .bind(tenantId, projectId, repo, ...ids).all<{ oid: string; generation: number }>()).results;
    for (const row of rows) generations.set(row.oid, row.generation);
  }
  const pending = new Map(nodes.map(node => [node.hash, node])), ready: D1PreparedStatement[] = [];
  while (pending.size) {
    let progress = false;
    for (const [hash, node] of pending) {
      if (node.parents.some(parent => !generations.has(parent))) continue;
      const generation = 1 + Math.max(0, ...node.parents.map(parent => generations.get(parent)!));
      generations.set(hash, generation);pending.delete(hash);progress = true;
      ready.push(db.prepare(repo ? "INSERT OR IGNORE INTO repository_commit (tenant_id, project_id, repo, oid, tree_hash, parents_json, generation, commit_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)" : "/*perf-site:src%2Fcode%2FgitCommitIndex.ts:21:18:indexCommitNodes:1a6cc675*/ INSERT OR IGNORE INTO git_commit (tenant_id, project_id, oid, tree_hash, parents_json, generation, commit_time) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(tenantId, projectId, ...(repo ? [repo] : []), hash, node.treeHash, JSON.stringify(node.parents), generation, node.committedAt));
    }
    if (!progress) throw new HubError(503, "unavailable", "repository history metadata is incomplete");
  }
  for (let offset = 0; offset < ready.length; offset += 100) await db.batch(ready.slice(offset, offset + 100));
}
