import { rank, type Ctx } from "./context";

export type SqlFilter = { sql: string; bindings: Array<string | number> };

/** Human tenant admins may inspect quarantine; agents never gain a tenant-wide mailbox via their role. */
export function canInspectMail(ctx: Ctx): boolean {
  return !!ctx.identity && ctx.identity.kind === "human" && rank(ctx.role) >= rank("admin");
}

/**
 * Canonical read predicate, used before LIMIT and before loading mail into HTML, MCP or model inputs.
 * Organization/project mail is shared admitted evidence for tenant readers. Addressed-agent mail is
 * visible only to that agent, its human operator, or a human tenant admin. Quarantine is admin-only.
 * Tenant/role boundaries apply even to root and operator identities.
 */
export function readableMail(ctx: Ctx, alias = "m"): SqlFilter {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error("invalid mail SQL alias");
  if (!ctx.tenant || !ctx.identity || rank(ctx.role) < rank("reader")) return { sql: "0 = 1", bindings: [] };
  const admin = canInspectMail(ctx) ? 1 : 0;
  return {
    sql: `(${alias}.tenant_id = ? AND (${alias}.verdict = 'admitted' OR ? = 1) AND
      (${alias}.recipient_id IS NULL OR ${alias}.recipient_id = ? OR ? = 1 OR
        (? = 1 AND EXISTS (SELECT 1 FROM identity mail_recipient WHERE mail_recipient.id = ${alias}.recipient_id
          AND mail_recipient.kind = 'agent' AND mail_recipient.operator_id = ?))))`,
    bindings: [ctx.tenant.id, admin, ctx.identity.id, admin, ctx.identity.kind === "human" ? 1 : 0, ctx.identity.id],
  };
}

/** Mail event summaries contain subjects/addresses and must obey the same boundary as the record. */
export function readableMailEvents(ctx: Ctx, alias = "e"): SqlFilter {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error("invalid event SQL alias");
  if (!ctx.tenant || !ctx.identity || rank(ctx.role) < rank("reader")) return { sql: "0 = 1", bindings: [] };
  const mail = readableMail(ctx);
  return {
    sql: `(${alias}.target_kind NOT IN ('inbound_mail', 'outbound_mail') OR
      (${alias}.target_kind = 'inbound_mail' AND EXISTS (SELECT 1 FROM inbound_mail m WHERE m.id = ${alias}.target_id AND ${mail.sql})) OR
      (${alias}.target_kind = 'outbound_mail' AND EXISTS (SELECT 1 FROM outbound_mail o WHERE o.id = ${alias}.target_id AND o.tenant_id = ? AND
        (? = 1 OR o.sent_by = ? OR (? = 1 AND EXISTS (SELECT 1 FROM identity mail_sender WHERE mail_sender.id = o.sent_by
          AND mail_sender.kind = 'agent' AND mail_sender.operator_id = ?)) OR
          EXISTS (SELECT 1 FROM inbound_mail m WHERE m.id = o.in_reply_to AND ${mail.sql})))))`,
    bindings: [...mail.bindings, ctx.tenant.id, canInspectMail(ctx) ? 1 : 0, ctx.identity.id, ctx.identity.kind === "human" ? 1 : 0, ctx.identity.id, ...mail.bindings],
  };
}
