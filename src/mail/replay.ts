import { createHash } from "node:crypto";
import type { DNSResolver } from "mailauth";
import type { Env } from "../env";
import { ulid, sha256Hex } from "../ids";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { verifyIndependentDkim, MAX_DKIM_BYTES, type DkimProof } from "./dkim";
import { parseMail, resolveMailAddress, type MailTarget } from "./projectMail";

// Inactive until the ingress integration is accepted. No API accepts proof or
// replay state supplied by a caller; this entry point verifies original bytes.
export const REPLAY_PREFIX = "mail_replay:v1:";
type Pass = Extract<DkimProof, { authentication: "pass" }>;
export type ReplayState = {
  attempt_id: string; mail_id: string; identity_id: string; raw_sha256: string;
  reserved_at: number; status: "pending" | "stored";
};
export type IndependentStoreResult =
  | { status: "stored"; mail_id: string; identity_id: string; target: MailTarget; proof: Pass }
  | { status: "duplicate"; mail_id: string }
  | { status: "unknown"; proof: DkimProof }
  | { status: "ineligible" | "collision" | "blocked" };

// Repeated inside the atomic write, not just a stale resolveMailAddress read.
// CASE binds the exact mailbox and destination identity/project, including active
// membership of an addressed agent. Never permit a renamed/replaced destination.
const ELIGIBLE = `EXISTS (SELECT 1 FROM identity i JOIN tenant t ON t.id = ?
  WHERE i.id = ? AND i.email = ? AND i.kind = 'human' AND i.state = 'active' AND t.state = 'active'
    AND (i.is_root = 1 OR EXISTS (SELECT 1 FROM membership m
      WHERE m.tenant_id = t.id AND m.identity_id = i.id AND m.state = 'active'))
    AND CASE WHEN ? IS NOT NULL THEN EXISTS (SELECT 1 FROM identity a JOIN membership am
      ON am.identity_id = a.id AND am.tenant_id = t.id AND am.state = 'active'
      WHERE a.id = ? AND a.kind = 'agent' AND a.state = 'active' AND a.email = ?)
    WHEN ? IS NOT NULL THEN EXISTS (SELECT 1 FROM project p
      WHERE p.id = ? AND p.tenant_id = t.id AND p.state = 'active' AND p.kind <> 'channel'
        AND ? = t.slug || '.' || p.slug || '@' || ?)
    ELSE ? = t.slug || '@' || ? END)`;
const LEGACY = `EXISTS (SELECT 1 FROM inbound_mail
  WHERE tenant_id = ? AND from_email = ? AND to_address = ? AND message_id = ?)`;

/** Durable admission-storage candidate, with no consent, outbound, audit or wake
 * effects. D1's transactional batch reserves, inserts the evidence and finalizes
 * together: a failed statement rolls ALL three back. A lost batch response is
 * reconciled by another cryptographically verified invocation, never by a send.
 * Conflicting bytes, legacy rows, corrupt state or a dangling reservation block
 * automatic replay. There is no lease expiry/reclaim and no delete-on-failure.
 * Callers still need ingress rate limits and post-storage delivery integration.
 */
export async function storeIndependentMailCandidate(env: Env,
  input: { bytes: Uint8Array; from: string; to: string }, now: number,
  resolver?: DNSResolver): Promise<IndependentStoreResult> {
  if (!Number.isSafeInteger(now) || now < 0) return { status: "ineligible" };
  if (input.bytes.byteLength > MAX_DKIM_BYTES) return { status: "ineligible" };
  // Snapshot before any await; the authenticated bytes must also be parsed/hashed.
  const bytes = new Uint8Array(input.bytes);
  const from = normalizeEmail(input.from), to = input.to.trim().toLowerCase();
  const target = await resolveMailAddress(env.HUB_DB, env.HUB_DOMAIN, to);
  const identity = await getIdentityByEmail(env.HUB_DB, from);
  if (!target || !identity) return { status: "ineligible" };
  const eligibility = [target.tenant_id, identity.id, from,
    target.recipient_id ?? null, target.recipient_id ?? null, to,
    target.project_id, target.project_id, to, env.HUB_DOMAIN.toLowerCase(), to, env.HUB_DOMAIN.toLowerCase()];
  const eligible = async () => !!await env.HUB_DB.prepare(`SELECT 1 WHERE ${ELIGIBLE}`).bind(...eligibility).first();
  if (!await eligible()) return { status: "ineligible" };
  const proof = await verifyIndependentDkim(bytes, from, now, resolver);
  if (proof.authentication !== "pass") return { status: "unknown", proof };
  const key = REPLAY_PREFIX + target.tenant_id + ":" + await sha256Hex(JSON.stringify([from, to, proof.messageId]));
  const raw_sha256 = createHash("sha256").update(bytes).digest("hex");
  const legacy = [target.tenant_id, from, to, proof.messageId];
  const state: ReplayState = { attempt_id: ulid(now), mail_id: ulid(now), identity_id: identity.id,
    raw_sha256, reserved_at: now, status: "pending" };
  const pending = JSON.stringify(state), stored = JSON.stringify({ ...state, status: "stored" });
  const parsed = await parseMail(bytes.buffer);
  const results = await env.HUB_DB.batch([
    env.HUB_DB.prepare(`INSERT INTO meta (key, value) SELECT ?, ? WHERE ${ELIGIBLE} AND NOT ${LEGACY}
      ON CONFLICT(key) DO NOTHING`).bind(key, pending, ...eligibility, ...legacy),
    env.HUB_DB.prepare(`INSERT INTO inbound_mail
      (id, tenant_id, project_id, recipient_id, identity_id, from_email, to_address, subject, message_id,
       sent_at, received_at, size, verdict, reason, text, attachments, forwarded, copied)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', NULL, ?, ?, ?, ?
      FROM meta r WHERE r.key = ? AND r.value = ? AND ${ELIGIBLE} AND NOT ${LEGACY}`)
      .bind(state.mail_id, target.tenant_id, target.project_id, target.recipient_id ?? null, identity.id,
        from, to, parsed.subject, proof.messageId, parsed.date, now, bytes.byteLength,
        parsed.text, JSON.stringify(parsed.attachments), parsed.forwarded ? 1 : 0,
        JSON.stringify(parsed.addressed.filter((a) => a !== from && !a.endsWith(`@${env.HUB_DOMAIN.toLowerCase()}`))),
        key, pending, ...eligibility, ...legacy),
    env.HUB_DB.prepare(`UPDATE meta SET value = ? WHERE key = ? AND value = ?
      AND EXISTS (SELECT 1 FROM inbound_mail WHERE id = ? AND tenant_id = ? AND identity_id = ?
        AND from_email = ? AND to_address = ? AND message_id = ? AND verdict = 'admitted' AND reason IS NULL)`)
      .bind(stored, key, pending, state.mail_id, target.tenant_id, identity.id, from, to, proof.messageId),
  ]);
  if (results[1]!.meta.changes === 1 && results[2]!.meta.changes === 1) {
    return { status: "stored", mail_id: state.mail_id, identity_id: identity.id, target, proof };
  }
  // Recheck current authority before even returning a scoped existing row id.
  if (!await eligible()) return { status: "ineligible" };
  const value = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<string>("value");
  if (!value) return { status: "blocked" }; // includes pre-rollout admitted/quarantined rows
  let existing: ReplayState;
  try { existing = JSON.parse(value); } catch { return { status: "blocked" }; }
  if (!existing || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(existing.mail_id)
    || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(existing.attempt_id)
    || !/^[a-f0-9]{64}$/.test(existing.raw_sha256) || existing.identity_id !== identity.id
    || !Number.isSafeInteger(existing.reserved_at) || existing.reserved_at < 0) return { status: "blocked" };
  if (existing.raw_sha256 !== raw_sha256) return { status: "collision" };
  if (existing.status !== "stored") return { status: "blocked" };
  const row = await env.HUB_DB.prepare(`SELECT id FROM inbound_mail WHERE id = ? AND tenant_id = ?
    AND identity_id = ? AND from_email = ? AND to_address = ? AND message_id = ?
    AND project_id IS ? AND recipient_id IS ? AND verdict = 'admitted' AND reason IS NULL AND released_by IS NULL`)
    .bind(existing.mail_id, ...[target.tenant_id, identity.id, from, to, proof.messageId], target.project_id,
      target.recipient_id ?? null).first<{ id: string }>();
  return row ? { status: "duplicate", mail_id: row.id } : { status: "blocked" };
}
