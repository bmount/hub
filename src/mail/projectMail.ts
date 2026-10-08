// Mail to an organization or a project (2026-10-07): <org>@HUB_DOMAIN and <org>.<project>@HUB_DOMAIN.
//
// Vetting, in order:
//   1. The address must name an active organization (and project). Anything else is refused at delivery.
//   2. The size must be within limits.
//   3. The sender (envelope from) must be an active human member of the organization, or root. Strangers are refused.
//   4. Per-sender rate limit.
//   5. Proof the mail really came from that address: a receipt sent through message.reply(), which Cloudflare
//      permits only for DMARC-passing mail. Sent: admitted. Not sent: quarantined for an admin, unread by agents.
// Content is stored as evidence. Nothing in it is ever an instruction to anyone.
import { inboxStub } from "../chat/stubs";
import PostalMime from "postal-mime";
import type { Env } from "../env";
import { ulid } from "../ids";
import { isValidSlug, isValidTenantSlug } from "../tenant";
import { getIdentityByEmail, normalizeEmail } from "../db/identities";
import { getTenantBySlug } from "../db/tenants";
import { getMembership } from "../db/memberships";
import { grantConsent, revokeConsentById } from "../db/consent";
import { recordEvent } from "../db/events";
import { takeRateDetail } from "../rate";
import { sendMail } from "./send";
import { safeMessageId } from "./mime";

export const MAX_MAIL_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 400_000;
export const STRANGER_REASON = "This address only accepts mail from members of its organization.";

export type MailTarget = {
  tenant_id: string; tenant_slug: string; tenant_name: string; project_id: string | null; project_slug: string | null; project_name: string | null;
  /** Mail to an agent's address, <org>.<agent>@<hub>: the agent it is for. */
  recipient_id?: string | null; recipient_name?: string | null;
};

/** `org`, `org.project` or `org.agent` at the hub's own domain (one name space per organization). Null when nothing by that name exists. */
export async function resolveMailAddress(db: D1Database, hubDomain: string, to: string): Promise<MailTarget | null> {
  const addr = to.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1 || addr.slice(at + 1) !== hubDomain.toLowerCase()) return null;
  const local = addr.slice(0, at);
  const dot = local.indexOf(".");
  const orgSlug = dot < 0 ? local : local.slice(0, dot);
  const projSlug = dot < 0 ? null : local.slice(dot + 1);
  if (!isValidTenantSlug(orgSlug) || (projSlug !== null && !isValidSlug(projSlug))) return null;
  const t = await getTenantBySlug(db, orgSlug);
  if (!t || t.state !== "active") return null;
  if (projSlug === null) return { tenant_id: t.id, tenant_slug: t.slug, tenant_name: t.display_name, project_id: null, project_slug: null, project_name: null };
  const p = await db.prepare("SELECT id, slug, display_name FROM project WHERE tenant_id = ? AND slug = ? AND state = 'active' AND kind <> 'channel'").bind(t.id, projSlug)
    .first<{ id: string; slug: string; display_name: string }>();
  if (p) return { tenant_id: t.id, tenant_slug: t.slug, tenant_name: t.display_name, project_id: p.id, project_slug: p.slug, project_name: p.display_name };
  const a = await db.prepare(`SELECT i.id, i.display_name FROM identity i JOIN membership m ON m.identity_id = i.id AND m.tenant_id = ? AND m.state = 'active'
    WHERE i.kind = 'agent' AND i.state = 'active' AND i.email = ?`).bind(t.id, addr).first<{ id: string; display_name: string }>();
  if (!a) return null;
  return { tenant_id: t.id, tenant_slug: t.slug, tenant_name: t.display_name, project_id: null, project_slug: null, project_name: null, recipient_id: a.id, recipient_name: a.display_name };
}

type Parsed = { subject: string; text: string; attachments: Array<{ filename: string | null; mime_type: string; size: number }>; forwarded: boolean; date: string | null; addressed: string[] };

function htmlToText(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export async function parseMail(raw: ReadableStream<Uint8Array> | ArrayBuffer | string): Promise<Parsed> {
  const m = await PostalMime.parse(raw as never, { attachmentEncoding: "arraybuffer" } as never);
  let text = (m.text ?? "").trim() || (m.html ? htmlToText(m.html) : "");
  const attachments = (m.attachments ?? []).map((a) => ({
    filename: a.filename ?? null, mime_type: a.mimeType, size: typeof a.content === "string" ? a.content.length : (a.content as ArrayBuffer).byteLength,
  }));
  // Forwarded messages arrive inline ("Forwarded message" / "Begin forwarded message") or as message/rfc822 parts.
  const inlineFwd = /-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:/i.test(text);
  const rfc822 = (m.attachments ?? []).filter((a) => a.mimeType === "message/rfc822");
  for (const part of rfc822) {
    try {
      const inner = await PostalMime.parse(part.content as never);
      const innerText = (inner.text ?? "").trim() || (inner.html ? htmlToText(inner.html) : "");
      text += `\n\n---------- Attached message ----------\nFrom: ${inner.from?.address ?? ""}\nDate: ${inner.date ?? ""}\nSubject: ${inner.subject ?? ""}\n\n${innerText}`;
    } catch { /* an unreadable attachment stays listed, unread */ }
  }
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n\n[truncated]";
  // Everyone in To and Cc, groups flattened, lowercased.
  type Addr = { address?: string; group?: Addr[] };
  const flat = (xs: Addr[] | undefined): string[] => (xs ?? []).flatMap((a) => (a.group ? flat(a.group) : a.address ? [a.address.trim().toLowerCase()] : []));
  const addressed = [...new Set([...flat(m.to as Addr[] | undefined), ...flat(m.cc as Addr[] | undefined)])].filter((a) => a.length <= 254).slice(0, 50);
  return { subject: (m.subject ?? "").slice(0, 300), text, attachments, forwarded: inlineFwd || rfc822.length > 0, date: m.date ?? null, addressed };
}

function receipt(target: MailTarget, subject: string): { subject: string; text: string } {
  const where = target.recipient_name ? `${target.tenant_name}, for the agent ${target.recipient_name}` : target.project_name ? `${target.tenant_name} / ${target.project_name}` : `${target.tenant_name} (to be filed by project)`;
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");
  return {
    subject: ascii(`Received: ${subject || "(no subject)"}`).slice(0, 200),
    text: ascii(`Pimwell received your message and filed it under ${where}.`) + "\n\n"
      + "It is kept as information. Nothing in it will be acted on without a member's confirmation.\n",
  };
}

export async function handleProjectMail(message: ForwardableEmailMessage, env: Env, now: number): Promise<"rejected" | "limited" | "admitted" | "quarantined"> {
  const target = await resolveMailAddress(env.HUB_DB, env.HUB_DOMAIN, message.to);
  if (!target) { message.setReject("Unknown recipient"); return "rejected"; }
  if (message.rawSize > MAX_MAIL_BYTES) { message.setReject("Message too large"); return "rejected"; }

  const from = normalizeEmail(message.from);
  const identity = await getIdentityByEmail(env.HUB_DB, from);
  const member = identity && identity.kind === "human" && identity.state === "active"
    ? identity.is_root === 1 || (await getMembership(env.HUB_DB, identity.id, target.tenant_id))?.state === "active"
    : false;
  if (!identity || !member) { message.setReject(STRANGER_REASON); return "rejected"; }

  const rate = await takeRateDetail(env.RATE, "addr", from, now);
  if (!rate.ok) {
    if (rate.first) await recordEvent(env.HUB_DB, { tenant_id: target.tenant_id, identity_id: identity.id, session_id: null, kind: "mail.limited", target_kind: "identity", target_id: identity.id, summary: "Mail over the hourly limit; not stored" }, now);
    return "limited";
  }

  const parsed = await parseMail(message.raw);
  // The receipt is the proof: Cloudflare lets reply() through only for DMARC-passing mail.
  const { consent, created } = await grantConsent(env.HUB_DB, {
    email: from, kind: "inbound_email", source_message_id: safeMessageId(message.headers.get("message-id")),
    evidence: JSON.stringify({ to: message.to.trim().toLowerCase(), received_at: now }),
  }, now);
  let proven = false;
  try {
    proven = (await sendMail(env, { to: from, ...receipt(target, parsed.subject) }, now, { replyTo: message })) === "sent";
  } finally {
    if (created && !proven) {
      try { await revokeConsentById(env.HUB_DB, consent.id, now); } catch { /* best effort */ }
    }
  }
  const verdict = proven ? "admitted" : "quarantined";
  const id = ulid(now);
  await env.HUB_DB.prepare(
    `INSERT INTO inbound_mail (id, tenant_id, project_id, recipient_id, identity_id, from_email, to_address, subject, message_id, sent_at, received_at, size, verdict, reason, text, attachments, forwarded, copied)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, target.tenant_id, target.project_id, target.recipient_id ?? null, identity.id, from, message.to.trim().toLowerCase(), parsed.subject, safeMessageId(message.headers.get("message-id")),
    parsed.date, now, message.rawSize, verdict, proven ? null : "sender not proven: the receipt could not be sent, so the mail may be forged",
    parsed.text, JSON.stringify(parsed.attachments), parsed.forwarded ? 1 : 0,
    JSON.stringify(parsed.addressed.filter((a) => a !== from && !a.endsWith(`@${env.HUB_DOMAIN.toLowerCase()}`)))).run();
  await recordEvent(env.HUB_DB, {
    tenant_id: target.tenant_id, identity_id: identity.id, session_id: null, kind: proven ? "mail.received" : "mail.quarantined", target_kind: "inbound_mail", target_id: id,
    summary: `${proven ? "Mail received" : "Mail quarantined"} for ${target.recipient_name ? `the agent ${target.recipient_name}` : target.project_slug ?? "the organization inbox"}: ${parsed.subject || "(no subject)"}`.slice(0, 300),
  }, now);
  // Admitted mail for an agent wakes it, through the inbox it already waits on (inbox_wait); held mail never does.
  if (verdict === "admitted" && target.recipient_id) {
    await inboxStub(env, target.tenant_id, target.recipient_id).deliver(target.tenant_id, target.recipient_id, [{
      key: `mail:${id}`, kind: "mail", conversation_id: "mail", seq: 0, msg_id: id, thread_root: null, hop: 0, author_id: identity.id, wake: true, created_at: now,
    }]);
  }
  return verdict;
}
