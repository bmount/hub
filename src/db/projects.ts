import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidSlug } from "../tenant";
import type { Project, State } from "./types";

const KINDS = new Set(["repo", "tracker"]);

/** Built-in pages on an organization's host. A project page lives at /<project>, so a project may not take these names. */
export const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "archive", "assets", "attention", "auth", "c", "docket", "healthz", "inbox", "internal", "invite", "login", "logout", "m", "mail",
  "mcp", "me", "jump", "new", "oauth", "people", "planned", "playground", "privacy", "projects", "search", "settings", "signed-out", "skills", "static", "terms", "well-known",
]);

/** A helper in the tenant (?1) whose name (?2) is the local part of its address; archived helpers keep their names. */
export const HELPER_NAMED = `SELECT 1 FROM identity i JOIN membership m ON m.identity_id = i.id
  WHERE m.tenant_id = ? AND i.kind = 'agent' AND substr(i.email, 1, instr(i.email, '@') - 1) = ?`;

export async function createProject(
  db: D1Database,
  input: { tenant_id: string; namespace_id: string | null; slug: string; kind: string; display_name: string },
  now: number,
): Promise<Project> {
  if (!isValidSlug(input.slug)) throw badRequest("invalid project slug");
  if (RESERVED_PROJECT_SLUGS.has(input.slug)) throw badRequest(`"${input.slug}" is the name of a built-in page; choose another project name`);
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
    // Projects and helpers share one name space per organization, first come, first served (mailboxes spec,
    // amendment 2026-10-07 b). The check is inside the insert, so two creators can never both win.
    const r = await db.prepare(
      `INSERT INTO project (id, tenant_id, namespace_id, slug, kind, display_name, state, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (${HELPER_NAMED})`,
    ).bind(row.id, row.tenant_id, row.namespace_id, row.slug, row.kind, row.display_name, row.state, row.created_at, row.tenant_id, row.slug).run();
    if (r.meta.changes !== 1) throw conflict(`"${row.slug}" is the name of a helper in this organization; choose another project name`);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("project slug exists");
    throw e;
  }
  return row;
}

export function getProjectById(db: D1Database, tenant_id: string, id: string): Promise<Project | null> {
  return db.prepare("SELECT * FROM project WHERE id = ? AND tenant_id = ?").bind(id, tenant_id).first<Project>();
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
  const r = await db.prepare("SELECT * FROM project WHERE tenant_id = ? AND state = ? AND kind <> 'channel' ORDER BY namespace_id, slug").bind(tenant_id, state).all<Project>();
  return r.results;
}

export async function setProjectState(db: D1Database, tenant_id: string, id: string, state: State): Promise<boolean> {
  const r = await db.prepare("UPDATE project SET state = ? WHERE id = ? AND tenant_id = ? AND state <> ?").bind(state, id, tenant_id, state).run();
  return r.meta.changes === 1;
}
