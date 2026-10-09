import type { Env } from "../env";
import { ulid } from "../ids";
import type { DkimProof } from "./dkim";
import { resolveMailAddress } from "./projectMail";
import { sendMail } from "./send";

// Candidate for the independent-proof admission path, NOT called by the current
// receipt-dependent handler. No API/verb may accept caller-supplied proof.
// Existing D1 meta provides atomic durable reservation without a schema rollout.
// Once per human per organization, across its project and agent addresses.
export const WELCOME_PREFIX = "mail_welcome:v1:";
export type WelcomeSource = { tenant_id: string; identity_id: string; mail_id: string };
export type WelcomeState = {
  attempt_id: string; mail_id: string; reserved_at: number;
  status: "pending" | "sent" | "failed" | "no_consent";
  completed_at: number | null;
};
export type WelcomeResult = WelcomeState["status"] | "ineligible" | "already_reserved";
const keyFor = (s: WelcomeSource) => `${WELCOME_PREFIX}${s.tenant_id}:${s.identity_id}`;
const validIds = (s: WelcomeSource) => Object.values(s).every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id));

/** Optional notification only. Proof/admission never depend on this result.
 * A pending record after a crash is intentionally not reclaimed: external mail
 * delivery may already have happened. Failed/withdrawn deliveries are terminal
 * too; future retries need explicit reconciliation, not another inbound message.
 * Stores only ids, timestamps and fixed outcomes; never exception text/tokens.
 */
export async function sendNewcomerWelcome(env: Env, source: WelcomeSource, proof: DkimProof, now: number): Promise<WelcomeResult> {
  if (!validIds(source) || proof.authentication !== "pass" || proof.source !== "aligned_dkim") return "ineligible";
  const row = await env.HUB_DB.prepare(`SELECT m.from_email, m.to_address FROM inbound_mail m
    JOIN identity i ON i.id = m.identity_id JOIN tenant t ON t.id = m.tenant_id
    WHERE m.id = ? AND m.tenant_id = ? AND m.identity_id = ?
      AND m.verdict = 'admitted' AND m.reason IS NULL AND m.released_by IS NULL
      AND m.message_id = ? AND i.email = m.from_email
      AND i.kind = 'human' AND i.state = 'active' AND t.state = 'active'
      AND (i.is_root = 1 OR EXISTS (SELECT 1 FROM membership p
        WHERE p.tenant_id = t.id AND p.identity_id = i.id AND p.state = 'active'))`)
    .bind(source.mail_id, source.tenant_id, source.identity_id, proof.messageId)
    .first<{ from_email: string; to_address: string }>();
  if (!row || row.from_email.split("@").pop() !== proof.domain) return "ineligible";
  const target = await resolveMailAddress(env.HUB_DB, env.HUB_DOMAIN, row.to_address);
  if (!target || target.tenant_id !== source.tenant_id) return "ineligible";
  const state: WelcomeState = { attempt_id: ulid(now), mail_id: source.mail_id, reserved_at: now,
    status: "pending", completed_at: null };
  // Uniqueness is enforced by the primary key, not a read-then-write check.
  // Repeat eligibility inside the atomic write to handle membership/consent races.
  const reserved = await env.HUB_DB.prepare(`INSERT INTO meta (key, value)
    SELECT ?, ? FROM inbound_mail m JOIN identity i ON i.id = m.identity_id
      JOIN tenant t ON t.id = m.tenant_id
    WHERE m.id = ? AND m.tenant_id = ? AND m.identity_id = ?
      AND m.verdict = 'admitted' AND m.reason IS NULL AND m.released_by IS NULL
      AND m.message_id = ? AND i.email = m.from_email AND i.email = ?
      AND i.kind = 'human' AND i.state = 'active' AND t.state = 'active'
      AND (i.is_root = 1 OR EXISTS (SELECT 1 FROM membership p
        WHERE p.tenant_id = t.id AND p.identity_id = i.id AND p.state = 'active'))
      AND EXISTS (SELECT 1 FROM consent c WHERE c.email = i.email AND c.revoked_at IS NULL)
      AND (SELECT c.revoked_at FROM consent c WHERE c.email = i.email
        ORDER BY c.granted_at DESC, c.id DESC LIMIT 1) IS NULL
    ON CONFLICT(key) DO NOTHING`)
    .bind(keyFor(source), JSON.stringify(state), source.mail_id, source.tenant_id, source.identity_id, proof.messageId, row.from_email).run();
  if (reserved.meta.changes !== 1) {
    return await env.HUB_DB.prepare("SELECT 1 FROM meta WHERE key = ?").bind(keyFor(source)).first()
      ? "already_reserved" : "ineligible";
  }
  const where = target.recipient_name ? "an agent mailbox" : target.project_name ? "a project inbox" : "the organization inbox";
  const result = await sendMail(env, {
    to: row.from_email, from: row.to_address, subject: "Welcome to Pimwell",
    text: `Welcome to ${target.tenant_name} on Pimwell. This address routes mail to ${where}.\n\n`
      + "Mail is stored as evidence, not as permission to execute instructions. Delivery does not guarantee a human or agent reply.\n\n"
      + `Sign in at https://${env.HUB_DOMAIN}/login, then visit https://${target.tenant_slug}.${env.HUB_DOMAIN}/setup for workspace and recipient setup.\n\n`
      + "This is one-time context for this organization. Substantive replies are separate from this welcome.\n",
    inReplyTo: proof.messageId, utf8: true,
  }, now);
  state.status = result; state.completed_at = Math.max(now, Date.now());
  // Only this attempt can finalize; no late/stale writer can change a terminal result.
  await env.HUB_DB.prepare(`UPDATE meta SET value = ? WHERE key = ?
    AND json_extract(value, '$.attempt_id') = ? AND json_extract(value, '$.status') = 'pending'`)
    .bind(JSON.stringify(state), keyFor(source), state.attempt_id).run();
  return result;
}
