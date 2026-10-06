import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug } from "../tenant";
import type { Project, State } from "./types";

const KINDS = new Set(["repo", "tracker"]);

export async function createProject(
  db: D1Database,
  input: { tenant_id: string; namespace_id: string | null; slug: string; kind: string; display_name: string },
  now: number,
): Promise<Project> {
  if (!isValidSlug(input.slug)) throw badRequest("invalid project slug");
  if (!KINDS.has(input.kind)) throw badRequest("unknown project kind");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  if (input.namespace_id === null) {
    const clash = await db.prepare("SELECT 1 FROM namespace WHERE tenant_id = ? AND slug = ?").bind(input.tenant_id, input.slug).first();
    if (clash) throw conflict("slug is used by a namespace");
  } else {
    const ns = await db.prepare("SELECT 1 FROM namespace WHERE id = ? AND tenant_id = ?").bind(input.namespace_id, input.tenant_id).first();
    if (!ns) throw badRequest("namespace not in tenant");
  }
  const row: Project = {
    id: ulid(now), tenant_id: input.tenant_id, namespace_id: input.namespace_id, slug: input.slug, kind: input.kind,
    display_name: input.display_name.trim(), state: "active", created_at: now,
  };
  try {
    await db.prepare("INSERT INTO project (id, tenant_id, namespace_id, slug, kind, display_name, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.tenant_id, row.namespace_id, row.slug, row.kind, row.display_name, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("project slug exists");
    throw e;
  }
  return row;
}

export function getProjectById(db: D1Database, id: string): Promise<Project | null> {
  return db.prepare("SELECT * FROM project WHERE id = ?").bind(id).first<Project>();
}

export function getProjectByPath(db: D1Database, tenant_id: string, namespace_slug: string | null, slug: string): Promise<Project | null> {
  if (namespace_slug === null) {
    return db.prepare("SELECT * FROM project WHERE tenant_id = ? AND namespace_id IS NULL AND slug = ?").bind(tenant_id, slug).first<Project>();
  }
  return db.prepare(
    "SELECT p.* FROM project p JOIN namespace n ON n.id = p.namespace_id WHERE p.tenant_id = ? AND n.slug = ? AND p.slug = ?",
  ).bind(tenant_id, namespace_slug, slug).first<Project>();
}

export async function listProjects(db: D1Database, tenant_id: string, state: State): Promise<Project[]> {
  const r = await db.prepare("SELECT * FROM project WHERE tenant_id = ? AND state = ? ORDER BY namespace_id, slug").bind(tenant_id, state).all<Project>();
  return r.results;
}

export async function setProjectState(db: D1Database, id: string, state: State): Promise<boolean> {
  const r = await db.prepare("UPDATE project SET state = ? WHERE id = ? AND state <> ?").bind(state, id, state).run();
  return r.meta.changes === 1;
}
