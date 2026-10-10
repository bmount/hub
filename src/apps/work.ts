import type { Ctx } from "../auth/context";
import type { WorkKind, WorkState } from "../work/names";

export type TraceWorkItem = { id: string; project: string; number: number; ref: string; kind: WorkKind; state: WorkState; title: string; relationship: "filed" | "linked" };
const RELATED_WORK_LIMIT = 50;

export function traceEvidenceUrl(ctx: Ctx, id: string): string {
  return `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/apps?g=${encodeURIComponent(id)}`;
}

export function traceGroupStatement(ctx: Ctx, id: string) {
  return ctx.db.prepare(`SELECT g.*, p.slug AS project FROM app_error_group g
    JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id AND p.kind <> 'channel'
    WHERE g.id = ? AND g.tenant_id = ?`).bind(id, ctx.tenant!.id);
}

export function traceDraftStatement(ctx: Ctx, id: string) {
  return ctx.db.prepare(`SELECT g.*, p.slug AS project FROM app_error_group g
    JOIN project p ON p.id = g.project_id AND p.tenant_id = g.tenant_id AND p.kind <> 'channel' AND p.state = 'active'
    WHERE g.id = ? AND g.tenant_id = ? AND NOT EXISTS
      (SELECT 1 FROM project other WHERE other.tenant_id = p.tenant_id AND other.slug = p.slug
        AND other.kind <> 'channel' AND other.id <> p.id)`)
    .bind(id, ctx.tenant!.id);
}

export function traceWorkStatement(ctx: Ctx, id: string) {
  const url = traceEvidenceUrl(ctx, id);
  return ctx.db.prepare(`SELECT w.id, p.slug AS project, w.number, p.slug || '#' || w.number AS ref, w.kind, w.state, w.title,
      CASE WHEN w.source_kind = 'url' AND w.source_ref = ? THEN 'filed' ELSE 'linked' END AS relationship
    FROM app_error_group g
    JOIN project gp ON gp.id = g.project_id AND gp.tenant_id = g.tenant_id AND gp.kind <> 'channel'
    JOIN work_item w ON w.tenant_id = g.tenant_id
    JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'
    WHERE g.id = ? AND g.tenant_id = ? AND
      ((w.source_kind = 'url' AND w.source_ref = ?) OR w.id = g.work_item_id OR
        EXISTS (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND l.target_kind = 'url' AND l.target_ref = ?))
    ORDER BY w.created_at DESC, w.id DESC LIMIT ${RELATED_WORK_LIMIT + 1}`)
    .bind(url, id, ctx.tenant!.id, url, url);
}

export function traceWorkResults(rows: TraceWorkItem[]) {
  const relatedWork = rows.slice(0, RELATED_WORK_LIMIT);
  return { relatedWork, relatedWorkCoverage: { limit: RELATED_WORK_LIMIT, shown: relatedWork.length, truncated: rows.length > RELATED_WORK_LIMIT } };
}
