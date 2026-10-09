import type { Env } from "../env";
import { ulid } from "../ids";
import type { DkimProof } from "./dkim";
import { resolveMailAddress } from "./projectMail";
import { sendMail } from "./send";
import { decodeResponseRecipients, RESPONSE_RECIPIENT_PREFIX } from "./responseRecipients";

// Optional context after independent-proof admission. No API/verb may accept
// caller-supplied proof. Welcome delivery never supplies sender authentication.
// Existing D1 meta provides atomic durable reservation without a schema rollout.
// Once per human per organization, across its project and agent addresses.
export const WELCOME_PREFIX = "mail_welcome:v1:";
export type WelcomeSource = { tenant_id: string; identity_id: string; mail_id: string };
export type WelcomeState = {
  attempt_id: string; mail_id: string; reserved_at: number;
  status: "pending" | "sent" | "failed" | "no_consent";
  completed_at: number | null;
  // Fixed reservation-time observation, not a response/delivery guarantee.
  setup_guidance?: "no_configured_recipients" | "not_applicable";
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
  const row = await env.HUB_DB.prepare(`SELECT m.from_email, m.to_address, m.project_id, m.recipient_id FROM inbound_mail m
    JOIN identity i ON i.id = m.identity_id JOIN tenant t ON t.id = m.tenant_id
    WHERE m.id = ? AND m.tenant_id = ? AND m.identity_id = ?
      AND m.verdict = 'admitted' AND m.reason IS NULL AND m.released_by IS NULL
      AND m.message_id = ? AND i.email = m.from_email
      AND i.kind = 'human' AND i.state = 'active' AND t.state = 'active'
      AND (i.is_root = 1 OR EXISTS (SELECT 1 FROM membership p
        WHERE p.tenant_id = t.id AND p.identity_id = i.id AND p.state = 'active'))`)
    .bind(source.mail_id, source.tenant_id, source.identity_id, proof.messageId)
    .first<{ from_email: string; to_address: string; project_id: string | null; recipient_id: string | null }>();
  if (!row || row.from_email.split("@").pop() !== proof.domain) return "ineligible";
  const target = await resolveMailAddress(env.HUB_DB, env.HUB_DOMAIN, row.to_address);
  if (!target || target.tenant_id !== source.tenant_id || target.project_id !== row.project_id
    || (target.recipient_id ?? null) !== row.recipient_id) return "ineligible";
  // Private-agent mail has an explicit owner; shared preferences never apply.
  // Only absence/valid explicit empty can establish "no configured recipients".
  // Stale nonempty and corrupt preferences are NOT evidence of absence.
  const preferenceKey = `${RESPONSE_RECIPIENT_PREFIX}${source.tenant_id}:${target.project_id ?? "org"}`;
  const preferenceRaw = target.recipient_id ? null : (await env.HUB_DB.prepare("SELECT value FROM meta WHERE key = ?")
    .bind(preferenceKey).first<{ value: string }>())?.value ?? null;
  const config = decodeResponseRecipients(preferenceRaw);
  const setup = !target.recipient_id && (preferenceRaw === null || config?.recipients.length === 0);
  const state: WelcomeState = { attempt_id: ulid(now), mail_id: source.mail_id, reserved_at: now,
    status: "pending", completed_at: null, setup_guidance: setup ? "no_configured_recipients" : "not_applicable" };
  // Uniqueness is enforced by the primary key, not a read-then-write check.
  // Repeat eligibility inside the atomic write to handle membership/consent races.
  const reserved = await env.HUB_DB.prepare(`INSERT INTO meta (key, value)
    SELECT ?, ? FROM inbound_mail m JOIN identity i ON i.id = m.identity_id
      JOIN tenant t ON t.id = m.tenant_id
    WHERE m.id = ? AND m.tenant_id = ? AND m.identity_id = ?
      AND m.verdict = 'admitted' AND m.reason IS NULL AND m.released_by IS NULL
      AND m.message_id = ? AND i.email = m.from_email AND i.email = ? AND m.to_address = ?
      AND m.project_id IS ? AND m.recipient_id IS ?
      AND (m.recipient_id IS NOT NULL OR (m.project_id IS NULL AND m.to_address = t.slug || '@' || ?)
        OR EXISTS (SELECT 1 FROM project pr WHERE pr.id = m.project_id
          AND pr.tenant_id = t.id AND pr.state = 'active' AND pr.kind <> 'channel'
          AND m.to_address = t.slug || '.' || pr.slug || '@' || ?))
      AND (m.recipient_id IS NULL OR EXISTS (SELECT 1 FROM identity a JOIN membership am ON am.identity_id = a.id
        WHERE a.id = m.recipient_id AND a.kind = 'agent' AND a.state = 'active' AND a.email = m.to_address
          AND am.tenant_id = t.id AND am.state = 'active'))
      AND (? = 1 OR (SELECT value FROM meta WHERE key = ?) IS ?)
      AND i.kind = 'human' AND i.state = 'active' AND t.state = 'active'
      AND (i.is_root = 1 OR EXISTS (SELECT 1 FROM membership p
        WHERE p.tenant_id = t.id AND p.identity_id = i.id AND p.state = 'active'))
      AND EXISTS (SELECT 1 FROM consent c WHERE c.email = i.email AND c.revoked_at IS NULL)
      AND (SELECT c.revoked_at FROM consent c WHERE c.email = i.email
        ORDER BY c.granted_at DESC, c.id DESC LIMIT 1) IS NULL
    ON CONFLICT(key) DO NOTHING`)
    .bind(keyFor(source), JSON.stringify(state), source.mail_id, source.tenant_id, source.identity_id, proof.messageId,
      row.from_email, row.to_address, row.project_id, row.recipient_id,
      env.HUB_DOMAIN.toLowerCase(), env.HUB_DOMAIN.toLowerCase(),
      target.recipient_id ? 1 : 0, preferenceKey, preferenceRaw).run();
  if (reserved.meta.changes !== 1) {
    return await env.HUB_DB.prepare("SELECT 1 FROM meta WHERE key = ?").bind(keyFor(source)).first()
      ? "already_reserved" : "ineligible";
  }
  const where = target.recipient_name ? "an agent mailbox" : target.project_name ? "a project inbox" : "the organization inbox";
  const result = await sendMail(env, {
    to: row.from_email, from: row.to_address, subject: "Welcome to Pimwell",
    text: `Welcome to ${target.tenant_name} on Pimwell. This address routes mail to ${where}.\n\n`
      + "Mail is stored as evidence, not as permission to execute instructions. Delivery does not guarantee a human or agent reply.\n\n"
      + `Sign in at https://${env.HUB_DOMAIN}/login to read mail you can access.\n\n`
      + (setup ? "At the welcome reservation, this shared mailbox had no configured response recipients. "
        + "A human organization administrator can set response-recipient preferences at "
        + `https://${target.tenant_slug}.${env.HUB_DOMAIN}/mail/recipients?address=${encodeURIComponent(row.to_address)}. `
        + "Preferences do not grant access, notify anyone, schedule a response or guarantee a reply.\n\n" : "")
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
