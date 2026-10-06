import { ulid } from "../ids";
import { normalizeEmail } from "./identities";
import type { Consent } from "./types";

export function getActiveConsent(db: D1Database, email: string): Promise<Consent | null> {
  return db.prepare("SELECT * FROM consent WHERE email = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1")
    .bind(normalizeEmail(email)).first<Consent>();
}

// The consent rule (spec 6.2). sendMail is the only caller that gates delivery on it.
export async function hasActiveConsent(db: D1Database, email: string): Promise<boolean> {
  return (await getActiveConsent(db, email)) !== null;
}

export async function grantConsent(
  db: D1Database,
  input: { email: string; kind: string; source_message_id: string | null; evidence: string | null },
  now: number,
): Promise<{ consent: Consent; created: boolean }> {
  const existing = await getActiveConsent(db, input.email);
  if (existing) return { consent: existing, created: false };
  const row: Consent = {
    id: ulid(now), email: normalizeEmail(input.email), tenant_id: null, kind: input.kind, granted_at: now,
    revoked_at: null, source_message_id: input.source_message_id, evidence: input.evidence,
  };
  await db.prepare(
    "INSERT INTO consent (id, email, tenant_id, kind, granted_at, revoked_at, source_message_id, evidence) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)",
  ).bind(row.id, row.email, row.kind, row.granted_at, row.source_message_id, row.evidence).run();
  return { consent: row, created: true };
}

export async function listConsent(db: D1Database, email: string): Promise<Consent[]> {
  const r = await db.prepare("SELECT * FROM consent WHERE email = ? ORDER BY granted_at DESC, id DESC")
    .bind(normalizeEmail(email)).all<Consent>();
  return r.results;
}

export async function revokeConsent(db: D1Database, email: string, now: number): Promise<number> {
  const r = await db.prepare("UPDATE consent SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL")
    .bind(now, normalizeEmail(email)).run();
  return r.meta.changes;
}
