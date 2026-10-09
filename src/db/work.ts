// Work items and their links (overnight plan task 2).
import { ulid } from "../ids";
import { creationEventStatement } from "./events";
import type { EventRow } from "./types";
import { safeExternalUrl } from "../security/urls";
import { badRequest, conflict, notFound } from "../errors";
import type { WorkKind, WorkState } from "../work/names";

export type WorkItem = {
  id: string; tenant_id: string; project_id: string; number: number; kind: WorkKind; title: string; body: string; state: WorkState;
  owner_id: string | null; lease_until: number | null; parent_id: string | null;
  source_kind: string | null; source_ref: string | null; source_quote: string | null; source_at: number | null;
  created_by: string; created_at: number; updated_at: number; closed_at: number | null;
};
export type WorkLink = { id: string; item_id: string; target_kind: string; target_ref: string; note: string | null; created_by: string; created_at: number };

export const LEASE_MS = 3600_000;

export async function createWork(
  db: D1Database,
  input: {
    tenant_id: string; project_id: string; kind: WorkKind; title: string; body: string; created_by: string;
    state?: WorkState; owner_id?: string | null; parent_id?: string | null;
    source_kind?: string | null; source_ref?: string | null; source_quote?: string | null; source_at?: number | null; created_at?: number;
  },
  now: number,
): Promise<WorkItem> {
  const title = input.title.trim();
  if (!title) throw badRequest("a title is required");
  if (input.parent_id) {
    const parent = await db.prepare("SELECT kind FROM work_item WHERE id = ? AND project_id = ?").bind(input.parent_id, input.project_id).first<{ kind: string }>();
    if (!parent) throw badRequest("the parent must be an item in the same project");
  }
  const id = ulid(now);
  const created = input.created_at ?? now;
  const state = input.state ?? "open";
  await db.prepare(
    `INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, owner_id, parent_id, source_kind, source_ref, source_quote, source_at, created_by, created_at, updated_at, closed_at)
     SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM work_item WHERE project_id = ?`,
  ).bind(id, input.tenant_id, input.project_id, input.kind, title, input.body.trim(), state, input.owner_id ?? null, input.parent_id ?? null,
    input.source_kind ?? null, input.source_ref ?? null, input.source_quote ?? null, input.source_at ?? null, input.created_by, created, now,
    state === "done" || state === "dropped" ? now : null, input.project_id).run();
  return (await getWork(db, input.tenant_id, id))!;
}

export function getWork(db: D1Database, tenant_id: string, id: string): Promise<WorkItem | null> {
  return db.prepare("SELECT * FROM work_item WHERE id = ? AND tenant_id = ?").bind(id, tenant_id).first<WorkItem>();
}

export function getWorkByNumber(db: D1Database, project_id: string, number: number): Promise<WorkItem | null> {
  return db.prepare("SELECT * FROM work_item WHERE project_id = ? AND number = ?").bind(project_id, number).first<WorkItem>();
}

export type WorkFilter = {
  project_id?: string | null; kinds?: WorkKind[]; states?: WorkState[]; owner_id?: string | null; parent_id?: string | null; limit: number; before?: number | null;
  /** Owner by email, resolved inside the query so a filtered page stays one round trip. */
  owner_email?: string | null;
  /** Quest by its number in `project_id`, resolved inside the query. */
  parent_number?: number | null;
};

/** The Docket query as a statement, so pages can put it in a batch. */
export function listWorkStatement(db: D1Database, tenant_id: string, f: WorkFilter): D1PreparedStatement {
  const where = ["tenant_id = ?"]; const args: unknown[] = [tenant_id];
  if (f.project_id) { where.push("project_id = ?"); args.push(f.project_id); }
  if (f.kinds?.length) { where.push(`kind IN (${f.kinds.map(() => "?").join(",")})`); args.push(...f.kinds); }
  if (f.states?.length) { where.push(`state IN (${f.states.map(() => "?").join(",")})`); args.push(...f.states); }
  if (f.owner_id) { where.push("owner_id = ?"); args.push(f.owner_id); }
  if (f.owner_email) { where.push("owner_id = (SELECT id FROM identity WHERE email = ?)"); args.push(f.owner_email.trim().toLowerCase()); }
  if (f.parent_id) { where.push("parent_id = ?"); args.push(f.parent_id); }
  if (f.parent_number && f.project_id) { where.push("parent_id = (SELECT id FROM work_item WHERE project_id = ? AND number = ?)"); args.push(f.project_id, f.parent_number); }
  if (f.before) { where.push("updated_at < ?"); args.push(f.before); }
  return db.prepare(`SELECT * FROM work_item WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`).bind(...args, f.limit);
}

export async function listWork(db: D1Database, tenant_id: string, f: WorkFilter): Promise<WorkItem[]> {
  return (await listWorkStatement(db, tenant_id, f).all<WorkItem>()).results;
}

export async function updateWork(
  db: D1Database, item: WorkItem,
  ch: { title?: string; body?: string; kind?: WorkKind; state?: WorkState; owner_id?: string | null; parent_id?: string | null },
  now: number,
): Promise<WorkItem> {
  const next = { ...item, ...Object.fromEntries(Object.entries(ch).filter(([, v]) => v !== undefined)) } as WorkItem;
  if (!next.title.trim()) throw badRequest("a title is required");
  const closing = (next.state === "done" || next.state === "dropped") && !(item.state === "done" || item.state === "dropped");
  const reopening = (next.state === "open" || next.state === "doing") && (item.state === "done" || item.state === "dropped");
  const closed_at = closing ? now : reopening ? null : item.closed_at;
  const lease = next.state === "doing" ? item.lease_until : null;
  await db.prepare("UPDATE work_item SET title = ?, body = ?, kind = ?, state = ?, owner_id = ?, parent_id = ?, lease_until = ?, closed_at = ?, updated_at = ? WHERE id = ?")
    .bind(next.title.trim(), next.body, next.kind, next.state, next.owner_id, next.parent_id, lease, closed_at, now, item.id).run();
  return { ...next, lease_until: lease, closed_at, updated_at: now };
}

/** Claim an item: owner and "under way" with a one-hour lease. Refused while someone else's lease is live. */
export async function claimWork(db: D1Database, item: WorkItem, identity_id: string, now: number): Promise<WorkItem> {
  if (item.state === "done" || item.state === "dropped") throw conflict("that item is closed");
  const r = await db.prepare(
    "UPDATE work_item SET owner_id = ?, state = 'doing', lease_until = ?, updated_at = ? WHERE id = ? AND (owner_id IS NULL OR owner_id = ? OR lease_until IS NULL OR lease_until < ?)",
  ).bind(identity_id, now + LEASE_MS, now, item.id, identity_id, now).run();
  if (r.meta.changes !== 1) throw conflict("someone else is working on it; their claim runs out at " + new Date(item.lease_until ?? now).toISOString());
  return { ...item, owner_id: identity_id, state: "doing", lease_until: now + LEASE_MS, updated_at: now };
}

export async function linkWork(
  db: D1Database, item: WorkItem,
  input: { target_kind: string; target_ref: string; note: string | null; created_by: string }, now: number,
  event?: (link: WorkLink) => Omit<EventRow, "id" | "created_at">,
): Promise<{ link: WorkLink; created: boolean }> {
  if (!["commit", "mail", "message", "event", "item", "url"].includes(input.target_kind)) throw badRequest("unknown link kind");
  const ref = input.target_kind === "url" ? safeExternalUrl(input.target_ref) : input.target_ref.trim();
  if (!ref) throw badRequest(input.target_kind === "url" ? "URL links must be absolute HTTPS URLs without credentials, whitespace or control characters" : "a link target is required");
  const row: WorkLink = { id: ulid(now), item_id: item.id, target_kind: input.target_kind, target_ref: ref, note: input.note, created_by: input.created_by, created_at: now };
  const statements = [
    db.prepare(`INSERT INTO work_link (id, item_id, target_kind, target_ref, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (item_id, target_kind, target_ref) DO NOTHING RETURNING *`)
      .bind(row.id, row.item_id, row.target_kind, row.target_ref, row.note, row.created_by, row.created_at),
    db.prepare("UPDATE work_item SET updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM work_link WHERE id = ?)").bind(now, item.id, row.id),
  ];
  if (event) statements.push(creationEventStatement(db, event(row), now, { table: "work_link", id: row.id }));
  statements.push(db.prepare("SELECT * FROM work_link WHERE item_id = ? AND target_kind = ? AND target_ref = ?").bind(item.id, row.target_kind, row.target_ref));
  const results = await db.batch<WorkLink>(statements);
  const link = results[results.length - 1]!.results[0];
  if (!link) throw conflict("link creation could not be reconciled");
  return { link, created: results[0]!.results.length === 1 };
}

export function listLinksStatement(db: D1Database, item_id: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM work_link WHERE item_id = ? ORDER BY created_at").bind(item_id);
}

export async function listLinks(db: D1Database, item_id: string): Promise<WorkLink[]> {
  return (await listLinksStatement(db, item_id).all<WorkLink>()).results;
}

export async function requireWork(db: D1Database, tenant_id: string, id: string): Promise<WorkItem> {
  const w = await getWork(db, tenant_id, id);
  if (!w) throw notFound("no such item");
  return w;
}
