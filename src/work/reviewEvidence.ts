import type { Ctx } from "../auth/context";
import type { WorkKind, WorkState } from "./names";

export type ReviewWorkItem = { id: string; project: string; number: number; ref: string; kind: WorkKind; state: WorkState; title: string; relationship: "filed" | "linked" | "commit" };
const RELATED_WORK_LIMIT = 50;

export function reviewEvidenceUrl(ctx: Ctx, review: { slug: string; number: number }): string {
  return `https://${ctx.tenant!.slug}.${ctx.env.HUB_DOMAIN}/${encodeURIComponent(review.slug)}/reviews/${encodeURIComponent(String(review.number))}`;
}

export function reviewDraftStatement(ctx: Ctx, reference: string) {
  const match = /^([a-z0-9-]+)!([1-9][0-9]{0,7})$/.exec(reference.trim());
  return ctx.db.prepare(`SELECT r.id, p.slug AS project, r.number, r.title, r.summary, r.branch, r.base, r.head_oid, r.status FROM review r
    JOIN project p ON p.id = r.project_id AND p.tenant_id = r.tenant_id AND p.kind = 'repo' AND p.state = 'active'
    WHERE r.tenant_id = ? AND ${match ? "p.slug = ? AND r.number = ?" : "r.id = ?"}
      AND typeof(r.number) = 'integer' AND r.number BETWEEN 1 AND 99999999 AND NOT EXISTS
      (SELECT 1 FROM project other WHERE other.tenant_id = p.tenant_id AND other.slug = p.slug
        AND other.kind <> 'channel' AND other.id <> p.id)`)
    .bind(ctx.tenant!.id, ...(match ? [match[1], Number(match[2])] : [reference.trim()]));
}

export function reviewWorkQuery(ctx: Ctx, review: { id: string; slug: string; number: number; head_oid: string | null }) {
  const url = reviewEvidenceUrl(ctx, review);
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
