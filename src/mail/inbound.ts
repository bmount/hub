import type { Env } from "../env";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { grantConsent, revokeConsentById } from "../db/consent";
import { recordEvent } from "../db/events";
import { takeRateDetail } from "../rate";
import { issueLink, linkMail } from "../auth/login";
import { sendMail } from "./send";
import { safeMessageId } from "./mime";
import { handleProjectMail } from "./projectMail";

export const INBOUND_LOCALS = ["login", "signup"] as const;
export const REJECT_REASON = "This address does not accept mail from you.";

// Sign-in links still require Cloudflare's DMARC-gated reply. A failed
// reply leaves authentication unknown (it may fail for non-auth reasons).
// Authentication-Results is deliberately not read.
export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const started = Date.now();
  let error: string | null = null;
  try {
    await handle(message, env, ctx);
  } catch {
    // Library, DNS and transport exceptions may contain private values. Keep
    // diagnostics fixed; never log raw mail, exception names/messages or stacks.
    error = "inbound processing unavailable";
    console.error(JSON.stringify({ msg: "inbound failed" }));
  }
  // Who wrote to which address, and how long it took; what happened to it is in inbound_mail and the event log.
  console.log(JSON.stringify({ msg: "mail", to: message.to.trim().toLowerCase(), from: message.from.trim().toLowerCase(), size: message.rawSize, ms: Date.now() - started, error }));
}

async function handle(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  const to = message.to.trim().toLowerCase();
  const local = INBOUND_LOCALS.find((l) => to === `${l}@${env.HUB_DOMAIN}`);
  if (!local) {
    // <org>@ and <org>.<project>@: mail for an organization or a project, vetted there.
    await handleProjectMail(message, env, now);
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
      } catch {
        console.log("inbound consent revoke failed");
      }
    }
  }
}
