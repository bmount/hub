// Permanently delete an archived organization's hub data (admin spec 8.1, class C).
// One D1 batch: any reference left behind fails the whole batch, so a delete is all or nothing.
import { badRequest, conflict, notFound } from "../errors";

/** Tables holding rows that belong to one tenant, children before parents. */
const TENANT_TABLES = [
  "review_comment", "review",
  "situation", "assistant_message", "assistant_thread", "ardi_cred", "agent_mcp_session", "agent_connect_link", "code_event", "code_sync",
  "attention", "follow", "work_comment",
  "app_event", "app_error_group", "app_deploy", "app_stat", "app_source",
  "msg_ref", "msg_index", "conversation_member", "agent_chat_state", "chat_control", "channel",
  "model_call", "model_route", "provider_credential", "signin_grant",
  "event", "oauth_grant", "api_token", "invite", "consent",
  "outbound_mail", "work_item", "inbound_mail",
  "session", "membership", "project", "namespace",
] as const;

export type DeleteResult = { tenant_id: string; slug: string; counts: Record<string, number>; agents_deleted: number };

export async function deleteTenant(db: D1Database, slug: string, deleted_by: string, now: number): Promise<DeleteResult> {
  const t = await db.prepare("SELECT id, slug, display_name, state FROM tenant WHERE slug = ?").bind(slug)
    .first<{ id: string; slug: string; display_name: string; state: string }>();
  if (!t) throw notFound("no such organization");
  if (t.state !== "archived") throw conflict("archive the organization before deleting it");

  const counts: Record<string, number> = {};
  for (const table of TENANT_TABLES) {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).bind(t.id).first<{ n: number }>();
    if (r && r.n) counts[table] = r.n;
  }
  // Agents that belong only to this organization go with it.
  const agents = (await db.prepare(
    `SELECT i.id FROM identity i JOIN membership m ON m.identity_id = i.id AND m.tenant_id = ?
     WHERE i.kind = 'agent' AND NOT EXISTS (SELECT 1 FROM membership o WHERE o.identity_id = i.id AND o.tenant_id != ?)`,
  ).bind(t.id, t.id).all<{ id: string }>()).results.map((r) => r.id);
  if (agents.length) counts.identity = agents.length;
  const links = await db.prepare("SELECT COUNT(*) AS n FROM work_link WHERE item_id IN (SELECT id FROM work_item WHERE tenant_id = ?)").bind(t.id).first<{ n: number }>();
  if (links?.n) counts.work_link = links.n;

  const stmts: D1PreparedStatement[] = [db.prepare("PRAGMA defer_foreign_keys = true")];
  // One-time welcome reservations live in existing meta until a dedicated schema
  // is authorized. Tenant ids are internal ULIDs; the trailing colon scopes them.
  stmts.push(db.prepare("DELETE FROM meta WHERE key GLOB ?").bind(`mail_welcome:v1:${t.id}:*`));
  const sessions = "SELECT id FROM session WHERE tenant_id = ?";
  // Records elsewhere that point at this organization's sessions keep their meaning without the link.
  stmts.push(db.prepare(`UPDATE event SET session_id = NULL WHERE session_id IN (${sessions}) AND IFNULL(tenant_id, '') != ?`).bind(t.id, t.id));
  stmts.push(db.prepare(`UPDATE oauth_grant SET approved_by_session_id = NULL WHERE approved_by_session_id IN (${sessions}) AND tenant_id != ?`).bind(t.id, t.id));
  // Review verdicts carry no tenant column; they go with their reviews, before the reviews.
  stmts.push(db.prepare("DELETE FROM review_reviewer WHERE review_id IN (SELECT id FROM review WHERE tenant_id = ?)").bind(t.id));
  // Work links carry no tenant column; they go with their items, before the items.
  stmts.push(db.prepare("DELETE FROM work_link WHERE item_id IN (SELECT id FROM work_item WHERE tenant_id = ?)").bind(t.id));
  for (const table of TENANT_TABLES) stmts.push(db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).bind(t.id));
  for (const id of agents) {
    stmts.push(db.prepare("UPDATE event SET identity_id = NULL WHERE identity_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM session WHERE identity_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM api_token WHERE identity_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM proof WHERE identity_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM auth_link WHERE identity_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM identity WHERE id = ?").bind(id));
  }
  stmts.push(db.prepare("DELETE FROM tenant WHERE id = ?").bind(t.id));
  stmts.push(db.prepare("INSERT INTO deleted_tenant (id, slug, display_name, deleted_by, deleted_at, counts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(t.id, t.slug, t.display_name, deleted_by, now, JSON.stringify(counts)));
  await db.batch(stmts);
  return { tenant_id: t.id, slug: t.slug, counts, agents_deleted: agents.length };
}

/** A deleted organization's name stays reserved until the git host has purged its data for that name. */
export async function slugReserved(db: D1Database, slug: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM deleted_tenant WHERE slug = ? AND git_purged_at IS NULL").bind(slug).first()) !== null;
}

export async function listDeletedTenants(db: D1Database): Promise<Array<{ id: string; slug: string; display_name: string; deleted_by: string | null; deleted_at: number; counts: string; git_purged_at: number | null }>> {
  return (await db.prepare("SELECT * FROM deleted_tenant ORDER BY deleted_at DESC").all<{ id: string; slug: string; display_name: string; deleted_by: string | null; deleted_at: number; counts: string; git_purged_at: number | null }>()).results;
}

export function confirmMatches(slug: string, confirm: string | null): void {
  if ((confirm ?? "").trim().toLowerCase() !== slug.toLowerCase()) throw badRequest("type the organization's name exactly to confirm");
}
