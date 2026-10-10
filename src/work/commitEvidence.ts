import type { Ctx } from "../auth/context";
import type { WorkKind, WorkState } from "./names";

export type CommitWorkItem = { id: string; project: string; number: number; ref: string; kind: WorkKind; state: WorkState; title: string; relationship: "filed" | "linked" | "commit" };
const LIMIT = 50;

export function commitWorkStatement(ctx: Ctx, projectId: string, oid: string) {
  const normalized = /^[0-9a-f]{40}$/i.test(oid) ? oid.toLowerCase() : null;
  const origin = `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/`;
  return ctx.db.prepare(`SELECT w.id, p.slug AS project, w.number, p.slug || '#' || w.number AS ref, w.kind, w.state, w.title,
      CASE WHEN w.source_kind = 'url' AND w.source_ref = ? || cp.slug || '/code?c=' || ? THEN 'filed'
        WHEN EXISTS (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND l.target_kind = 'url'
          AND l.target_ref = ? || cp.slug || '/code?c=' || ?) THEN 'linked' ELSE 'commit' END AS relationship
    FROM project cp JOIN work_item w ON w.tenant_id = cp.tenant_id
    JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'
    WHERE cp.id = ? AND cp.tenant_id = ? AND cp.kind = 'repo' AND ? IS NOT NULL
      AND typeof(w.number) = 'integer' AND w.number BETWEEN 1 AND 99999999 AND
      ((w.source_kind = 'url' AND w.source_ref = ? || cp.slug || '/code?c=' || ?) OR EXISTS
        (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND
          ((l.target_kind = 'url' AND l.target_ref = ? || cp.slug || '/code?c=' || ?)
           OR (l.target_kind = 'commit' AND lower(l.target_ref) = cp.slug || '@' || ?
             AND substr(l.target_ref, 1, length(cp.slug) + 1) = cp.slug || '@'))))
    ORDER BY w.created_at DESC, w.id DESC LIMIT ${LIMIT + 1}`)
    .bind(origin, normalized, origin, normalized, projectId, ctx.tenant!.id, normalized,
      origin, normalized, origin, normalized, normalized);
}

export function commitWorkResults(rows: CommitWorkItem[]) {
  const relatedWork = rows.slice(0, LIMIT);
  return { relatedWork, relatedWorkCoverage: { limit: LIMIT, shown: relatedWork.length, truncated: rows.length > LIMIT } };
}
