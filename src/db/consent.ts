import { ulid } from "../ids";
import { normalizeEmail } from "./identities";
import type { Consent } from "./types";

export function getActiveConsent(db: D1Database, email: string): Promise<Consent | null> {
  return db.prepare("/*perf-site:src%2Fdb%2Fconsent.ts:6:10:getActiveConsent:140252af*/ SELECT * FROM consent WHERE email = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1")
    .bind(normalizeEmail(email)).first<Consent>();
}

// The consent rule (spec 6.2). sendMail is the only caller that gates delivery on it.
export async function hasActiveConsent(db: D1Database, email: string): Promise<boolean> {
  return (await getActiveConsent(db, email)) !== null;
}

/** True when the latest consent is revoked. This conservatively includes
 * failed provisional grants: legacy rows do not distinguish rollback from
 * withdrawal. Passive project mail must not silently opt the sender back in;
 * login@ is an explicit request and may establish new consent.
 */
export async function consentWithdrawn(db: D1Database, email: string): Promise<boolean> {
  const row = await db.prepare("/*perf-site:src%2Fdb%2Fconsent.ts:21:21:row:76cc5421*/ SELECT revoked_at FROM consent WHERE email = ? ORDER BY granted_at DESC, id DESC LIMIT 1")
    .bind(normalizeEmail(email)).first<{ revoked_at: number | null }>();
  return !!row && row.revoked_at !== null;
}

export async function grantConsent(
  db: D1Database,
  input: { email: string; kind: string; source_message_id: string | null; evidence: string | null },
  now: number,
): Promise<{ consent: Consent; created: boolean }> {
  const row: Consent = {
    id: ulid(now), email: normalizeEmail(input.email), tenant_id: null, kind: input.kind, granted_at: now,
    revoked_at: null, source_message_id: input.source_message_id, evidence: input.evidence,
  };
  // Single statement: concurrent grants cannot both insert an active row.
  // If the active row we lost to is revoked before we read it, insert once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await db.prepare(
      `/*perf-site:src%2Fdb%2Fconsent.ts:38:21:r:8a9b3b9e*/ INSERT INTO consent (id, email, tenant_id, kind, granted_at, revoked_at, source_message_id, evidence)
       SELECT ?, ?, NULL, ?, ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM consent WHERE email = ? AND revoked_at IS NULL)`,
    ).bind(row.id, row.email, row.kind, row.granted_at, row.source_message_id, row.evidence, row.email).run();
    if (r.meta.changes === 1) return { consent: row, created: true };
    const existing = await getActiveConsent(db, row.email);
    if (existing) return { consent: existing, created: false };
  }
  throw new Error("consent grant contended");
}

export async function revokeConsentById(db: D1Database, id: string, now: number): Promise<number> {
  const r = await db.prepare("/*perf-site:src%2Fdb%2Fconsent.ts:50:19:r:0d474bc8*/ UPDATE consent SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
  return r.meta.changes;
}

export async function listConsent(db: D1Database, email: string): Promise<Consent[]> {
  const r = await db.prepare("/*perf-site:src%2Fdb%2Fconsent.ts:55:19:r:070990a5*/ SELECT * FROM consent WHERE email = ? ORDER BY granted_at DESC, id DESC")
    .bind(normalizeEmail(email)).all<Consent>();
  return r.results;
}

export async function revokeConsent(db: D1Database, email: string, now: number): Promise<number> {
  const r = await db.prepare("/*perf-site:src%2Fdb%2Fconsent.ts:61:19:r:3c0925e5*/ UPDATE consent SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL")
    .bind(now, normalizeEmail(email)).run();
  return r.meta.changes;
}
