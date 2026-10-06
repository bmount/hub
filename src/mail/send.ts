import { EmailMessage } from "cloudflare:email";
import type { Env } from "../env";
import { ulid } from "../ids";
import { normalizeEmail } from "../db/identities";
import { hasActiveConsent } from "../db/consent";
import { buildMime, safeMessageId } from "./mime";

export type Outbound = { to: string; subject: string; text: string };
export type SendResult = "sent" | "no_consent" | "failed";
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
  try {
    if (!(await hasActiveConsent(env.HUB_DB, to))) return "no_consent";
    const from = reply ? reply.to.trim().toLowerCase() : senderAddress(env);
    const raw = buildMime({
      from, to, subject: mail.subject, text: mail.text,
      messageId: `<${ulid(now)}@${env.HUB_DOMAIN}>`, date: new Date(now),
      inReplyTo: reply ? safeMessageId(reply.headers.get("message-id")) : null,
    });
    if (reply) await reply.reply(new EmailMessage(from, reply.from, raw));
    else if (testTransport) await testTransport({ from, to, subject: mail.subject, text: mail.text, raw });
    else await env.MAIL.send(new EmailMessage(from, to, raw));
    return "sent";
  } catch (e) {
    console.log("mail delivery failed", reply ? "reply" : "send", e instanceof Error ? e.name : "unknown");
    return "failed";
  }
}
