import { ulid } from "../ids";
import type { EventRow } from "./types";

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

export async function listEvents(db: D1Database, tenant_id: string, limit: number): Promise<EventRow[]> {
  const r = await db.prepare("SELECT * FROM event WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(tenant_id, limit).all<EventRow>();
  return r.results;
}
