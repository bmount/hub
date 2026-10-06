import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug } from "../tenant";
import type { Namespace, State } from "./types";

export async function createNamespace(
  db: D1Database,
  input: { tenant_id: string; slug: string; display_name: string },
  now: number,
): Promise<Namespace> {
  if (!isValidSlug(input.slug)) throw badRequest("invalid namespace slug");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  const clash = await db.prepare("SELECT 1 FROM project WHERE tenant_id = ? AND namespace_id IS NULL AND slug = ?")
    .bind(input.tenant_id, input.slug).first();
  if (clash) throw conflict("slug is used by a top-level project");
  const row: Namespace = { id: ulid(now), tenant_id: input.tenant_id, slug: input.slug, display_name: input.display_name.trim(), state: "active", created_at: now };
  try {
    await db.prepare("INSERT INTO namespace (id, tenant_id, slug, display_name, state, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.slug, row.display_name, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("namespace slug exists");
    throw e;
  }
  return row;
}

export function getNamespaceBySlug(db: D1Database, tenant_id: string, slug: string): Promise<Namespace | null> {
  return db.prepare("SELECT * FROM namespace WHERE tenant_id = ? AND slug = ?").bind(tenant_id, slug).first<Namespace>();
}

export function getNamespaceById(db: D1Database, id: string): Promise<Namespace | null> {
  return db.prepare("SELECT * FROM namespace WHERE id = ?").bind(id).first<Namespace>();
}

export async function listNamespaces(db: D1Database, tenant_id: string, state: State): Promise<Namespace[]> {
  const r = await db.prepare("SELECT * FROM namespace WHERE tenant_id = ? AND state = ? ORDER BY slug").bind(tenant_id, state).all<Namespace>();
  return r.results;
}

export async function setNamespaceState(db: D1Database, id: string, state: State): Promise<boolean> {
  const [ns] = await db.batch([
    db.prepare("UPDATE namespace SET state = ? WHERE id = ? AND state <> ?").bind(state, id, state),
    db.prepare("UPDATE project SET state = ? WHERE namespace_id = ? AND state <> ?").bind(state, id, state),
  ]);
  return ns!.meta.changes === 1;
}
