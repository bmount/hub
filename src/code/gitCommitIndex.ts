import { HubError } from "../errors";
export type CommitNode = { hash: string; treeHash: string; parents: string[]; committedAt: number };

/** Small derived metadata, not Git objects. Supports Ardi-compatible all-parent history ordering. */
export async function indexCommitNodes(db: D1Database, tenantId: string, projectId: string, nodes: CommitNode[]): Promise<void> {
  if (!nodes.length) return;
  const generations = new Map<string, number>(), needed = [...new Set(nodes.flatMap(node => node.parents))];
  for (let offset = 0; offset < needed.length; offset += 100) {
    const ids = needed.slice(offset, offset + 100);
    const rows = (await db.prepare(`SELECT oid, generation FROM git_commit WHERE tenant_id = ? AND project_id = ? AND oid IN (${ids.map(() => "?").join(",")})`)
      .bind(tenantId, projectId, ...ids).all<{ oid: string; generation: number }>()).results;
    for (const row of rows) generations.set(row.oid, row.generation);
  }
  const pending = new Map(nodes.map(node => [node.hash, node])), ready: D1PreparedStatement[] = [];
  while (pending.size) {
    let progress = false;
    for (const [hash, node] of pending) {
      if (node.parents.some(parent => !generations.has(parent))) continue;
      const generation = 1 + Math.max(0, ...node.parents.map(parent => generations.get(parent)!));
      generations.set(hash, generation);pending.delete(hash);progress = true;
      ready.push(db.prepare("INSERT OR IGNORE INTO git_commit (tenant_id, project_id, oid, tree_hash, parents_json, generation, commit_time) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(tenantId, projectId, hash, node.treeHash, JSON.stringify(node.parents), generation, node.committedAt));
    }
    if (!progress) throw new HubError(503, "unavailable", "repository history metadata is incomplete");
  }
  for (let offset = 0; offset < ready.length; offset += 100) await db.batch(ready.slice(offset, offset + 100));
}
