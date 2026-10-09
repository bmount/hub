import { ulid } from "../ids";
import type { EventRow } from "./types";
import type { SqlFilter } from "../auth/mailAccess";

export async function recordEvent(
  db: D1Database,
  e: Omit<EventRow, "id" | "created_at">,
  now: number,
): Promise<EventRow> {
  const row: EventRow = { ...e, id: ulid(now), created_at: now };
  await db.prepare(
    "INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.tenant_id, row.identity_id, row.session_id, row.kind, row.target_kind, row.target_id, row.summary, row.created_at).run();
  return row;
}

/** Batch alongside a create-if-absent insert. Only the attempt's fresh internal ID may authorize an event. */
export function creationEventStatement(
  db: D1Database, e: Omit<EventRow, "id" | "created_at">, now: number,
  source: { table: "work_link" | "app_deploy"; id: string },
): D1PreparedStatement {
  return db.prepare(`INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${source.table} WHERE id = ?)`)
    .bind(ulid(now), e.tenant_id, e.identity_id, e.session_id, e.kind, e.target_kind, e.target_id, e.summary, now, source.id);
}

/**
 * One page of a tenant's events, newest first. Event ids are ULIDs minted from the same clock as
 * `created_at`, so id order is time order and the last id on a page is the cursor for the next.
 */
export async function listEventsPage(
  db: D1Database, tenant_id: string, opts: { limit: number; before: string | null; session_id: string | null; visibility?: SqlFilter },
): Promise<EventRow[]> {
  const where = ["tenant_id = ?"];
  const binds: Array<string | number> = [tenant_id];
  if (opts.before) { where.push("id < ?"); binds.push(opts.before); }
  if (opts.session_id) { where.push("session_id = ?"); binds.push(opts.session_id); }
  if (opts.visibility) { where.push(opts.visibility.sql); binds.push(...opts.visibility.bindings); }
  const r = await db.prepare(`SELECT * FROM event WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).bind(...binds, opts.limit).all<EventRow>();
  return r.results;
}

export async function listEvents(db: D1Database, tenant_id: string, limit: number): Promise<EventRow[]> {
  const r = await db.prepare("SELECT * FROM event WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(tenant_id, limit).all<EventRow>();
  return r.results;
}
