import type { Env } from "../env";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { grantConsent, revokeConsentById } from "../db/consent";
import { recordEvent } from "../db/events";
import { takeRateDetail } from "../rate";
import { issueLink, linkMail } from "../auth/login";
import { sendMail } from "./send";
import { safeMessageId } from "./mime";

export const INBOUND_LOCALS = ["login", "signup"] as const;
export const REJECT_REASON = "This address does not accept mail from you.";

// Spec 6.4. Cloudflare's MX already rejected SPF/DKIM failures; reply() adds
// the DMARC gate. Authentication-Results is deliberately not read.
export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    await handle(message, env, ctx);
  } catch (e) {
    console.log("inbound failed", e instanceof Error ? e.name : "error");
  }
}

async function handle(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  const to = message.to.trim().toLowerCase();
  const local = INBOUND_LOCALS.find((l) => to === `${l}@${env.HUB_DOMAIN}`);
  if (!local) {
    message.setReject("Unknown recipient");
    return;
  }
  const from = normalizeEmail(message.from);
  const identity = await getIdentityByEmail(env.HUB_DB, from);
  if (!identity || identity.kind !== "human" || identity.state !== "active") {
    message.setReject(REJECT_REASON);
    return;
  }

  const rate = await takeRateDetail(env.RATE, "addr", from, now);
  if (!rate.ok) {
    if (rate.first) {
      await recordEvent(env.HUB_DB, {
        tenant_id: null, identity_id: identity.id, session_id: null, kind: "login.inbound_limited",
        target_kind: "identity", target_id: identity.id, summary: "Inbound sign-in over the hourly limit; no consent or reply",
      }, now);
    }
    return;
  }

  const { consent, created } = await grantConsent(env.HUB_DB, {
    email: from, kind: "inbound_email", source_message_id: safeMessageId(message.headers.get("message-id")),
    evidence: JSON.stringify({ to: local, received_at: now }),
  }, now);
  // Consent from mail sticks only when the DMARC-gated reply went out; any failure after the grant undoes it.
  let delivered = false;
  try {
    if (created) {
      await recordEvent(env.HUB_DB, {
        tenant_id: null, identity_id: identity.id, session_id: null, kind: "consent.grant",
        target_kind: "consent", target_id: consent.id, summary: `Consent recorded from mail to ${local}@`,
      }, now);
    }
    const url = await issueLink(env, { identity, purpose: "login", next: null, via: "inbound", session_id: null }, now);
    const result = await sendMail(env, { to: from, ...linkMail("login", url) }, now, { replyTo: message });
    delivered = result === "sent";
    if (!delivered) {
      await recordEvent(env.HUB_DB, {
        tenant_id: null, identity_id: identity.id, session_id: null, kind: "login.reply_failed",
        target_kind: "identity", target_id: identity.id, summary: `Link not delivered (${result}); consent not kept`,
      }, now);
    }
  } finally {
    if (created && !delivered) {
      try {
        await revokeConsentById(env.HUB_DB, consent.id, now);
      } catch (e) {
        console.log("inbound consent revoke failed", e instanceof Error ? e.name : "error");
      }
    }
  }
}
