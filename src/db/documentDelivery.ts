import type { Ctx } from "../auth/context";

export async function documentDeliveries(ctx: Ctx, projectId: string, kind: "file" | "page", ref: string) {
  return (await ctx.db.prepare(`SELECT d.id, d.revision, d.recipient, d.mode, d.status, d.outbound_id, d.created_at, i.display_name AS sender
    FROM document_delivery d JOIN identity i ON i.id = d.sent_by
    WHERE d.tenant_id = ? AND d.project_id = ? AND d.document_kind = ? AND d.document_ref = ?
    ORDER BY d.created_at DESC, d.id DESC LIMIT 200`).bind(ctx.tenant!.id, projectId, kind, ref).all<{id: string; revision: number; recipient: string; mode: string; status: string; outbound_id: string | null; created_at: number; sender: string}>()).results;
}
