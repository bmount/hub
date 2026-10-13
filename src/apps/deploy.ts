import type { Ctx } from "../auth/context";
import type { WorkKind, WorkState } from "../work/names";

export type DeployRow = { id: string; project: string; script_name: string; version_id: string; tag: string | null; message: string | null; seen_at: number; commit_project: string | null };
const SELECT = `SELECT d.id, p.slug AS project, d.script_name, d.version_id, d.tag, d.message, d.seen_at,
  CASE WHEN p.kind = 'repo' AND NOT EXISTS
    (SELECT 1 FROM project other WHERE other.tenant_id = p.tenant_id AND other.slug = p.slug AND other.kind = 'repo' AND other.id <> p.id)
    THEN p.slug ELSE NULL END AS commit_project
  FROM app_deploy d JOIN project p ON p.id = d.project_id AND p.tenant_id = d.tenant_id AND p.kind NOT IN ('channel', 'agent-src')`;

/** Latest reported production release, not a privileged live rollout check. */
export function currentDeployStatement(ctx: Ctx, projectId: string, script: string) {
  return ctx.db.prepare(`${SELECT} WHERE d.tenant_id = ? AND d.project_id = ? AND d.script_name = ? AND length(d.version_id) = 73
    AND CASE WHEN json_valid(d.message) THEN json_extract(d.message, '$.release') = 1 AND json_extract(d.message, '$.environment') = 'production' ELSE 0 END
    ORDER BY d.seen_at DESC, d.id DESC LIMIT 1`).bind(ctx.tenant!.id, projectId, script);
}

export function deployStatement(ctx: Ctx, id: string) {
  return ctx.db.prepare(`${SELECT} WHERE d.id = ? AND d.tenant_id = ?`).bind(id, ctx.tenant!.id);
}

export function deploysStatement(ctx: Ctx, project: string | null = null, siteId: string | null = null) {
  return ctx.db.prepare(`${SELECT} WHERE d.tenant_id = ? AND (? IS NULL OR p.slug = ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM site_app sa JOIN site s ON s.id = sa.site_id JOIN app_source a ON a.id = sa.app_id
      WHERE s.id = ? AND s.tenant_id = d.tenant_id AND s.project_id = d.project_id AND a.tenant_id = s.tenant_id AND a.project_id = s.project_id AND a.script_name = d.script_name))
    ORDER BY d.seen_at DESC, d.id DESC LIMIT 51`)
    .bind(ctx.tenant!.id, project, project, siteId, siteId);
}

export function deployView(row: DeployRow) {
  const { commit_project, ...deploy } = row;
  const commit = /^[0-9a-f]{40}$/i.test(row.version_id) ? row.version_id :
    /^[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(row.version_id) ? row.tag : null;
  const oid = commit_project && commit && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
  let release = null;
  try {
    const metadata = JSON.parse(row.message ?? "null");
    if (metadata?.release === 1 && row.version_id === `${metadata.version}:${metadata.deployment}` && metadata.commit === row.tag) release = metadata;
  } catch { /* Legacy messages are plain text. */ }
  return { deploy, release, commitRef: oid ? `${commit_project}@${oid}` : null,
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
    FROM app_deploy d JOIN project dp ON dp.id = d.project_id AND dp.tenant_id = d.tenant_id AND dp.kind NOT IN ('channel', 'agent-src')
    JOIN work_item w ON w.tenant_id = d.tenant_id
    JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind NOT IN ('channel', 'agent-src')
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
