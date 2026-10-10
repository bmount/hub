import { EmailMessage } from "cloudflare:email";
import type { Env } from "../env";
import { ulid } from "../ids";
import { normalizeEmail } from "../db/identities";
import { hasActiveConsent, consentWithdrawn } from "../db/consent";
import { buildMime, safeMessageId } from "./mime";

/**
 * `cc` adds Cc recipients; `basis: "member"` sends to members of the sender's organization without a consent record,
 * but never to anyone who has withdrawn consent.
 */
export type Outbound = { to: string; cc?: string[]; subject: string; text: string; from?: string; inReplyTo?: string | null; references?: string[]; utf8?: boolean; basis?: "consent" | "member" };
export type SendResult = "sent" | "no_consent" | "failed" | "unknown";
export type SentMail = { from: string; to: string; subject: string; text: string; raw: string };

let testTransport: ((m: SentMail) => Promise<void>) | null = null;

// Tests only: replaces the MAIL binding call. Replies still go through message.reply.
export function setTestTransport(t: ((m: SentMail) => Promise<void>) | null): void {
  testTransport = t;
}

export function senderAddress(env: Env): string {
  return `login@${env.HUB_DOMAIN}`;
}

// The only path to outbound mail (spec 10). Consent is checked here for both
// the MAIL binding and inbound replies.
export async function sendMail(env: Env, mail: Outbound, now: number, opts: { replyTo?: ForwardableEmailMessage } = {}): Promise<SendResult> {
  const reply = opts.replyTo ?? null;
  const to = normalizeEmail(reply ? reply.from : mail.to);
  const cc = reply ? [] : (mail.cc ?? []).map(normalizeEmail);
  let attempted = false;
  try {
    for (const r of [to, ...cc]) {
      if (await consentWithdrawn(env.HUB_DB, r)) return "no_consent";
      if ((reply || mail.basis !== "member") && !(await hasActiveConsent(env.HUB_DB, r))) return "no_consent";
    }
    const from = reply ? reply.to.trim().toLowerCase() : mail.from ?? senderAddress(env);
    const raw = buildMime({
      from, to, cc, subject: mail.subject, text: mail.text,
      messageId: `<${ulid(now)}@${env.HUB_DOMAIN}>`, date: new Date(now),
      inReplyTo: reply ? safeMessageId(reply.headers.get("message-id")) : mail.inReplyTo ?? null, references: mail.references, utf8: mail.utf8,
    });
    if (reply) {
      const message = new EmailMessage(from, reply.from, raw);
      attempted = true;
      await reply.reply(message);
    }
    // One message, every recipient in its headers; one envelope per recipient.
    else for (const r of [to, ...cc]) {
      const message = new EmailMessage(from, r, raw);
      attempted = true;
      if (testTransport) await testTransport({ from, to: r, subject: mail.subject, text: mail.text, raw });
      else await env.MAIL.send(message);
    }
    return "sent";
  } catch {
    // Transport errors can contain credentials in any field (including name).
    console.log("mail delivery failed", reply ? "reply" : "send");
    // A rejected transport call may already have delivered, including earlier Cc envelopes.
    return attempted ? "unknown" : "failed";
  }
}
