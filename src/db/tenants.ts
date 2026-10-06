import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import { isValidTenantSlug } from "../tenant";
import type { State, Tenant } from "./types";

export async function createTenant(db: D1Database, input: { slug: string; display_name: string }, now: number): Promise<Tenant> {
  if (!isValidTenantSlug(input.slug)) throw badRequest("invalid tenant slug");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  const row: Tenant = { id: ulid(now), slug: input.slug, display_name: input.display_name.trim(), state: "active", created_at: now };
  try {
    await db.prepare("INSERT INTO tenant (id, slug, display_name, state, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.id, row.slug, row.display_name, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("tenant slug exists");
    throw e;
  }
  return row;
}

export function getTenantBySlug(db: D1Database, slug: string): Promise<Tenant | null> {
  return db.prepare("SELECT * FROM tenant WHERE slug = ?").bind(slug).first<Tenant>();
}

export function getTenantById(db: D1Database, id: string): Promise<Tenant | null> {
  return db.prepare("SELECT * FROM tenant WHERE id = ?").bind(id).first<Tenant>();
}

export async function listTenants(db: D1Database, state: State): Promise<Tenant[]> {
  const r = await db.prepare("SELECT * FROM tenant WHERE state = ? ORDER BY slug").bind(state).all<Tenant>();
  return r.results;
}

export async function setTenantState(db: D1Database, id: string, state: State, _now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE tenant SET state = ? WHERE id = ? AND state <> ?").bind(state, id, state).run();
  return r.meta.changes === 1;
}
