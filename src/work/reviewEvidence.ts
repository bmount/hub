import type { Ctx } from "../auth/context";
import type { WorkKind, WorkState } from "./names";

export type ReviewWorkItem = { id: string; project: string; number: number; ref: string; kind: WorkKind; state: WorkState; title: string; relationship: "filed" | "linked" | "commit" };
const RELATED_WORK_LIMIT = 50;

export function reviewWorkQuery(ctx: Ctx, review: { id: string; slug: string; number: number; head_oid: string | null }) {
  const url = `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/${encodeURIComponent(review.slug)}/reviews/${encodeURIComponent(String(review.number))}`;
  const commit = review.head_oid && /^[0-9a-f]{40}$/i.test(review.head_oid) ? `${review.slug}@${review.head_oid.toLowerCase()}` : null;
  const statement = ctx.db.prepare(`SELECT w.id, p.slug AS project, w.number, p.slug || '#' || w.number AS ref, w.kind, w.state, w.title,
      CASE WHEN w.source_kind = 'url' AND w.source_ref = ? THEN 'filed'
        WHEN EXISTS (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND l.target_kind = 'url' AND l.target_ref = ?) THEN 'linked'
        ELSE 'commit' END AS relationship
    FROM review r
    JOIN project rp ON rp.id = r.project_id AND rp.tenant_id = r.tenant_id AND rp.kind = 'repo'
    JOIN work_item w ON w.tenant_id = r.tenant_id
    JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'
    WHERE r.id = ? AND r.tenant_id = ? AND typeof(w.number) = 'integer' AND w.number BETWEEN 1 AND 99999999 AND
      ((w.source_kind = 'url' AND w.source_ref = ?) OR EXISTS
        (SELECT 1 FROM work_link l WHERE l.item_id = w.id AND
          ((l.target_kind = 'url' AND l.target_ref = ?) OR (l.target_kind = 'commit' AND lower(l.target_ref) = ?
            AND substr(l.target_ref, 1, length(rp.slug) + 1) = rp.slug || '@'))))
    ORDER BY w.created_at DESC, w.id DESC LIMIT ${RELATED_WORK_LIMIT + 1}`)
    .bind(url, url, review.id, ctx.tenant!.id, url, url, commit);
  return { statement, relatedWorkCommit: commit };
}

export function reviewWorkResults(rows: ReviewWorkItem[]) {
  const relatedWork = rows.slice(0, RELATED_WORK_LIMIT);
  return { relatedWork, relatedWorkCoverage: { limit: RELATED_WORK_LIMIT, shown: relatedWork.length, truncated: rows.length > RELATED_WORK_LIMIT } };
}
