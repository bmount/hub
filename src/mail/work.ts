import type { Ctx } from "../auth/context";
import { readableMail } from "../auth/mailAccess";
import type { WorkKind, WorkState } from "../work/names";

export type MailWorkItem = { id: string; project: string; number: number; ref: string; kind: WorkKind; state: WorkState; title: string; relationship: "filed" | "linked" };
const LIMIT = 50;

export function mailWorkStatement(ctx: Ctx, mailId: string): D1PreparedStatement {
  const access = readableMail(ctx);
  return ctx.db.prepare(`SELECT w.id, p.slug AS project, w.number, p.slug || '#' || w.number AS ref, w.kind, w.state, w.title,
      CASE WHEN w.source_kind = 'mail' AND w.source_ref = ? THEN 'filed' ELSE 'linked' END AS relationship
    FROM work_item w JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'
    WHERE w.tenant_id = ? AND ((w.source_kind = 'mail' AND w.source_ref = ?) OR EXISTS (
      SELECT 1 FROM work_link l WHERE l.item_id = w.id AND l.target_kind = 'mail' AND l.target_ref = ?))
      AND EXISTS (SELECT 1 FROM inbound_mail m WHERE m.id = ? AND ${access.sql})
    ORDER BY w.created_at DESC, w.id DESC LIMIT ${LIMIT + 1}`)
    .bind(mailId, ctx.tenant!.id, mailId, mailId, mailId, ...access.bindings);
}

export function mailWorkResults(rows: MailWorkItem[]) {
  const relatedWork = rows.slice(0, LIMIT);
  return { relatedWork, relatedWorkCoverage: { limit: LIMIT, shown: relatedWork.length, truncated: rows.length > LIMIT } };
}
