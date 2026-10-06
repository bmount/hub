import { ulid } from "../ids";
import { badRequest, conflict } from "../errors";
import type { Identity, IdentityKind } from "./types";

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export async function createIdentity(
  db: D1Database,
  input: { kind: IdentityKind; email: string; display_name: string; is_root: number; operator_id: string | null },
  now: number,
): Promise<Identity> {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw badRequest("invalid email");
  if (!input.display_name.trim()) throw badRequest("display_name required");
  const row: Identity = {
    id: ulid(now), kind: input.kind, display_name: input.display_name.trim(), is_root: input.is_root, email,
    operator_id: input.operator_id, state: "active", created_at: now,
  };
  try {
    await db.prepare(
      "INSERT INTO identity (id, kind, display_name, is_root, email, operator_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(row.id, row.kind, row.display_name, row.is_root, row.email, row.operator_id, row.state, row.created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("email exists");
    throw e;
  }
  return row;
}

export function getIdentityByEmail(db: D1Database, email: string): Promise<Identity | null> {
  return db.prepare("SELECT * FROM identity WHERE email = ?").bind(normalizeEmail(email)).first<Identity>();
}

export function getIdentityById(db: D1Database, id: string): Promise<Identity | null> {
  return db.prepare("SELECT * FROM identity WHERE id = ?").bind(id).first<Identity>();
}

export async function rootExists(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT 1 FROM identity WHERE is_root = 1 AND state = 'active' LIMIT 1").first();
  return r !== null;
}
