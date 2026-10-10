import type { Ctx } from "../auth/context";
import type { WorkKind, WorkState } from "../work/names";

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

export type DeployWorkItem = { id: string; project: string; number: number; ref: string; kind: WorkKind; state: WorkState; title: string; relationship: "filed" | "linked" | "commit" };

export function deployWorkStatement(ctx: Ctx, row: DeployRow) {
  const url = `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/apps?d=${encodeURIComponent(row.id)}`;
  const commit = deployView(row).commitRef;
  return ctx.db.prepare(`SELECT w.id, p.slug AS project, w.number, p.slug || '#' || w.number AS ref, w.kind, w.state, w.title,
      CASE WHEN w.source_kind = 'url' AND w.source_ref = ? THEN 'filed'
        WHEN EXISTS (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND l.target_kind = 'url' AND l.target_ref = ?) THEN 'linked'
        ELSE 'commit' END AS relationship
    FROM app_deploy d JOIN project dp ON dp.id = d.project_id AND dp.tenant_id = d.tenant_id AND dp.kind <> 'channel'
    JOIN work_item w ON w.tenant_id = d.tenant_id
    JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'
    WHERE d.id = ? AND d.tenant_id = ? AND typeof(w.number) = 'integer' AND w.number BETWEEN 1 AND 99999999 AND
      ((w.source_kind = 'url' AND w.source_ref = ?) OR EXISTS
        (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND
          ((l.target_kind = 'url' AND l.target_ref = ?) OR (l.target_kind = 'commit' AND lower(l.target_ref) = ?
            AND substr(l.target_ref, 1, length(dp.slug) + 1) = dp.slug || '@'))))
    ORDER BY w.created_at DESC, w.id DESC LIMIT 51`)
    .bind(url, url, row.id, ctx.tenant!.id, url, url, commit);
}

export function deployWorkResults(rows: DeployWorkItem[]) {
  const relatedWork = rows.slice(0, 50);
  return { relatedWork, relatedWorkCoverage: { limit: 50, shown: relatedWork.length, truncated: rows.length > 50 } };
}

export function deployListResults(rows: DeployRow[]) {
  const deploys = rows.slice(0, 50).map(row => deployView(row).deploy);
  return { deploys, coverage: { limit: 50, shown: deploys.length, truncated: rows.length > 50 } };
}
