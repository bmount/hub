import type { Ctx } from "../auth/context";

export type DeployRow = { id: string; project: string; script_name: string; version_id: string; tag: string | null; message: string | null; seen_at: number; commit_project: string | null };
const SELECT = `SELECT d.id, p.slug AS project, d.script_name, d.version_id, d.tag, d.message, d.seen_at,
  CASE WHEN p.kind = 'repo' AND NOT EXISTS
    (SELECT 1 FROM project other WHERE other.tenant_id = p.tenant_id AND other.slug = p.slug AND other.kind = 'repo' AND other.id <> p.id)
    THEN p.slug ELSE NULL END AS commit_project
  FROM app_deploy d JOIN project p ON p.id = d.project_id AND p.tenant_id = d.tenant_id AND p.kind <> 'channel'`;

export function deployStatement(ctx: Ctx, id: string) {
  return ctx.db.prepare(`${SELECT} WHERE d.id = ? AND d.tenant_id = ?`).bind(id, ctx.tenant!.id);
}

export function deploysStatement(ctx: Ctx, project: string | null = null) {
  return ctx.db.prepare(`${SELECT} WHERE d.tenant_id = ? AND (? IS NULL OR p.slug = ?) ORDER BY d.seen_at DESC, d.id DESC LIMIT 51`)
    .bind(ctx.tenant!.id, project, project);
}

export function deployView(row: DeployRow) {
  const { commit_project, ...deploy } = row;
  const oid = commit_project && /^[0-9a-f]{40}$/i.test(row.version_id) ? row.version_id.toLowerCase() : null;
  return { deploy, commitRef: oid ? `${commit_project}@${oid}` : null,
    commitHref: oid ? `/${encodeURIComponent(commit_project!)}/code?c=${oid}` : null };
}

export function deployListResults(rows: DeployRow[]) {
  const deploys = rows.slice(0, 50).map(row => deployView(row).deploy);
  return { deploys, coverage: { limit: 50, shown: deploys.length, truncated: rows.length > 50 } };
}
