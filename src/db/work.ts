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

/** Only the authenticated verb supplies this actor; never infer it from owner_id. */
export type ClosureActor = { identity_id: string; session_id: string | null };
function doneEventStatement(db: D1Database, item: { id: string; tenant_id: string }, actor: ClosureActor, now: number): D1PreparedStatement {
  // Must immediately follow the work write inside one transactional D1 batch.
  // Snapshot losers have changes() = 0 even when the winner wrote identical values.
  return db.prepare(`INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
    SELECT ?, ?, ?, ?, 'work.done', 'work_item', ?, 'Recorded done transition', ? WHERE changes() = 1`)
    .bind(ulid(now), item.tenant_id, actor.identity_id, actor.session_id, item.id, now);
}

export async function createWork(
  db: D1Database,
  input: {
    tenant_id: string; project_id: string; kind: WorkKind; title: string; body: string; created_by: string;
    state?: WorkState; owner_id?: string | null; parent_id?: string | null;
    source_kind?: string | null; source_ref?: string | null; source_quote?: string | null; source_at?: number | null; created_at?: number;
  },
  now: number, closureActor?: ClosureActor,
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
  const insert = db.prepare(
    `INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, owner_id, parent_id, source_kind, source_ref, source_quote, source_at, created_by, created_at, updated_at, closed_at)
     SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM work_item WHERE project_id = ?`,
  ).bind(id, input.tenant_id, input.project_id, input.kind, title, input.body.trim(), state, input.owner_id ?? null, input.parent_id ?? null,
    input.source_kind ?? null, input.source_ref ?? null, input.source_quote ?? null, input.source_at ?? null, input.created_by, created, now,
    state === "done" || state === "dropped" ? now : null, input.project_id);
  if (state === "done" && closureActor) await db.batch([insert, doneEventStatement(db, { id, tenant_id: input.tenant_id }, closureActor, now)]);
  else await insert.run();
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
export function listWorkStatement(db: D1Database, tenant_id: string, f: WorkFilter, withProject = false): D1PreparedStatement {
  const where = ["w.tenant_id = ?"]; const args: unknown[] = [tenant_id];
  if (f.project_id) { where.push("w.project_id = ?"); args.push(f.project_id); }
  if (f.kinds?.length) { where.push(`w.kind IN (${f.kinds.map(() => "?").join(",")})`); args.push(...f.kinds); }
  if (f.states?.length) { where.push(`w.state IN (${f.states.map(() => "?").join(",")})`); args.push(...f.states); }
  if (f.owner_id) { where.push("w.owner_id = ?"); args.push(f.owner_id); }
  if (f.owner_email) { where.push("w.owner_id = (SELECT id FROM identity WHERE email = ?)"); args.push(f.owner_email.trim().toLowerCase()); }
  if (f.parent_id) { where.push("w.parent_id = ?"); args.push(f.parent_id); }
  if (f.parent_number && f.project_id) { where.push("w.parent_id = (SELECT id FROM work_item WHERE project_id = ? AND number = ?)"); args.push(f.project_id, f.parent_number); }
  if (f.before) { where.push("w.updated_at < ?"); args.push(f.before); }
  const join = withProject ? "JOIN project p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.kind <> 'channel'" : "";
  return db.prepare(`SELECT w.*${withProject ? ", p.slug AS project" : ""} FROM work_item w ${join} WHERE ${where.join(" AND ")} ORDER BY w.updated_at DESC, w.id DESC LIMIT ?`).bind(...args, f.limit);
}

export async function listWork(db: D1Database, tenant_id: string, f: WorkFilter): Promise<WorkItem[]> {
  return (await listWorkStatement(db, tenant_id, f).all<WorkItem>()).results;
}

/** One query regardless of the number of distinct projects in the work.list sample. */
export async function listWorkWithProjects(db: D1Database, tenant_id: string, f: WorkFilter): Promise<Array<WorkItem & { project: string }>> {
  return (await listWorkStatement(db, tenant_id, f, true).all<WorkItem & { project: string }>()).results;
}

/** Match everything a write derives from, including nullable fields. This also detects
 * writers (e.g. membership removal) that do not advance updated_at. No schema rollout. */
function snapshotPredicate(item: WorkItem): { sql: string; args: Array<string | number | null> } {
  const fields = ["title", "body", "kind", "state", "owner_id", "parent_id", "lease_until", "closed_at", "updated_at"] as const;
  return {
    sql: "id = ? AND tenant_id = ? AND project_id = ? AND " + fields.map((field) => `${field} IS ?`).join(" AND "),
    args: [item.id, item.tenant_id, item.project_id, ...fields.map((field) => item[field])],
  };
}

export async function updateWork(
  db: D1Database, item: WorkItem,
  ch: { title?: string; body?: string; kind?: WorkKind; state?: WorkState; owner_id?: string | null; parent_id?: string | null },
  now: number, closureActor?: ClosureActor,
): Promise<WorkItem> {
  const next = { ...item, ...Object.fromEntries(Object.entries(ch).filter(([, v]) => v !== undefined)) } as WorkItem;
  if (!next.title.trim()) throw badRequest("a title is required");
  const closing = (next.state === "done" || next.state === "dropped") && !(item.state === "done" || item.state === "dropped");
  const reopening = (next.state === "open" || next.state === "doing") && (item.state === "done" || item.state === "dropped");
  const closed_at = closing ? now : reopening ? null : item.closed_at;
  // A new owner must claim their own lease; reassignment must not inherit the old one.
  const lease = next.state === "doing" && next.owner_id === item.owner_id ? item.lease_until : null;
  const updated_at = Math.max(now, item.updated_at + 1);
  const snapshot = snapshotPredicate(item);
  const write = db.prepare(`UPDATE work_item SET title = ?, body = ?, kind = ?, state = ?, owner_id = ?, parent_id = ?, lease_until = ?, closed_at = ?, updated_at = ? WHERE ${snapshot.sql}`)
    .bind(next.title.trim(), next.body, next.kind, next.state, next.owner_id, next.parent_id, lease, closed_at, updated_at, ...snapshot.args);
  const r = next.state === "done" && item.state !== "done" && closureActor
    ? (await db.batch([write, doneEventStatement(db, item, closureActor, now)]))[0]!
    : await write.run();
  if (r.meta.changes !== 1) throw conflict("that item changed; read it again before retrying your edit");
  return { ...next, title: next.title.trim(), lease_until: lease, closed_at, updated_at };
}

/** Claim an item: owner and "under way" with a one-hour lease. Refused while someone else's lease is live. */
export async function claimWork(db: D1Database, item: WorkItem, identity_id: string, now: number): Promise<WorkItem> {
  if (item.state === "done" || item.state === "dropped") throw conflict("that item is closed");
  const snapshot = snapshotPredicate(item);
  const updated_at = Math.max(now, item.updated_at + 1);
  const r = await db.prepare(
    `UPDATE work_item SET owner_id = ?, state = 'doing', lease_until = ?, closed_at = NULL, updated_at = ? WHERE ${snapshot.sql}
     AND state IN ('open', 'doing') AND (owner_id IS NULL OR owner_id = ? OR lease_until IS NULL OR lease_until < ?)`,
  ).bind(identity_id, now + LEASE_MS, updated_at, ...snapshot.args, identity_id, now).run();
  if (r.meta.changes !== 1) throw conflict("that item changed or has another live claim; read it again before retrying your claim");
  return { ...item, owner_id: identity_id, state: "doing", lease_until: now + LEASE_MS, closed_at: null, updated_at };
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
