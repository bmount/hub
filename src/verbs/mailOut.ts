// Member-started mail goes only to signed-up human organization members.
// Sending switch, daily caps, consent withdrawal and refusal records apply to all senders.
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, forbidden, notFound } from "../errors";
import { HubError } from "../errors";
import { recordEvent } from "../db/events";
import { ulid } from "../ids";
import { rank, type Ctx } from "../auth/context";
import { readableMail } from "../auth/mailAccess";
import { sendMail } from "../mail/send";
import type { MailAttachment } from "../mail/mime";
import { DATA_NOTE } from "../mcp/render";

export const SENDER_DAILY = 50;
export const TENANT_DAILY = 500;

type Gate = { from: string; to: string; cc?: string[]; inbound_id: string | null; message_id: string | null; basis?: "consent" | "member" };

const EMAIL = /^[^\s@<>",]+@[^\s@<>",]+\.[a-z]{2,}$/i;
export const MAX_RECIPIENTS = 10;

/** One address, a comma-separated list, or an array: lowercased, unique, checked. */
export function addresses(v: unknown, name: string): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : v === undefined || v === null ? [] : null;
  if (!raw) throw badRequest(`${name} is an address or a list of addresses`);
  const list = [...new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  for (const a of list) if (!EMAIL.test(a)) throw badRequest(`${name}: "${a.slice(0, 80)}" is not an email address`);
  return list;
}

/** Anyone who may write to this organization may be written to: a signed-up human who is a member here, or root.
 * Never contact history, and never anyone else. */
export async function memberRecipientRefusals(ctx: Ctx, recipients: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of recipients) {
    const member = await ctx.db.prepare(`SELECT 1 FROM identity i
      WHERE (lower(i.email) = ?1 OR EXISTS (SELECT 1 FROM identity_email ie WHERE ie.identity_id = i.id AND lower(ie.email) = ?1 AND ie.confirmed_at IS NOT NULL))
      AND i.kind = 'human' AND i.state = 'active'
      AND (i.is_root = 1 OR EXISTS (SELECT 1 FROM membership m WHERE m.identity_id = i.id AND m.tenant_id = ?2 AND m.state = 'active')) LIMIT 1`).bind(r, ctx.tenant!.id).first();
    if (!member) out.push(`${r} is not a signed-up member of this organization; they need to accept an invitation or sign in with this address`);
  }
  return out;
}

export async function capsAndSwitch(ctx: Ctx): Promise<void> {
  const r = await ctx.db.prepare(`/*perf-site:src%2Fverbs%2FmailOut.ts:60:19:capsAndSwitch:44fcc385*/ SELECT t.mail_out,
      (SELECT COUNT(*) FROM outbound_mail WHERE sent_by = ? AND status = 'sent' AND created_at > ?) AS mine,
      (SELECT COUNT(*) FROM outbound_mail WHERE tenant_id = t.id AND status = 'sent' AND created_at > ?) AS ours
    FROM tenant t WHERE t.id = ?`).bind(ctx.identity!.id, ctx.now - 86_400_000, ctx.now - 86_400_000, ctx.tenant!.id).first<{ mail_out: number; mine: number; ours: number }>();
  if (!r || r.mail_out !== 1) throw new HubError(403, "forbidden", "sending mail is off in this organization; an admin can turn it on under Mail", { mail_block: "sending_off" });
  if (r.mine >= SENDER_DAILY) throw new HubError(429, "too_many_requests", `at most ${SENDER_DAILY} messages a day per sender`, { mail_block: "sender_limit" });
  if (r.ours >= TENANT_DAILY) throw new HubError(429, "too_many_requests", `at most ${TENANT_DAILY} messages a day per organization`, { mail_block: "tenant_limit" });
}

async function recordOutgoing(ctx: Ctx, g: Gate, subject: string, body: string, status: string, error: string | null): Promise<string> {
  const id = ulid(ctx.now);
  const all = [g.to, ...(g.cc ?? [])].join(", ");
  await ctx.db.prepare(`/*perf-site:src%2Fverbs%2FmailOut.ts:72:9:recordOutgoing:b4d98151*/ INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, in_reply_to, sent_by, session_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ctx.tenant!.id, g.from, all, subject, body, g.inbound_id, ctx.identity!.id, ctx.session?.id ?? null, status, error, ctx.now).run();
  await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: status === "sent" ? "mail.sent" : "mail.not_sent",
    target_kind: "outbound_mail", target_id: id, summary: `${status === "sent" ? "Mailed" : "Could not mail"} ${all} from ${g.from}: ${subject}`.slice(0, 300) }, ctx.now);
  return id;
}

export async function deliver(ctx: Ctx, g: Gate, subject: string, body: string, references: string[], policy: () => Promise<void>, attachments?: MailAttachment[]): Promise<{ id: string; status: string }> {
  // Authorization and mailbox ownership are checked before this point. Only valid attempts are recorded.
  try { await policy(); } catch (e) {
    if (!(e instanceof HubError) || !e.data?.mail_block) throw e;
    const id = await recordOutgoing(ctx, g, subject, body, "refused", String(e.data.mail_block));
    e.data = { ...e.data, mail_delivery: { id, to_address: [g.to, ...(g.cc ?? [])].join(", "), in_reply_to: g.inbound_id, status: "refused", error: e.data.mail_block } };
    throw e;
  }
  const result = await sendMail(ctx.env, { to: g.to, cc: g.cc, from: g.from, subject, text: body, inReplyTo: g.message_id, references, utf8: true, basis: g.basis, attachments }, ctx.now);
  const status = result === "sent" ? "sent" : result === "no_consent" ? "refused" : "failed";
  const error = result === "sent" ? null : result === "failed" ? "pre_transport_failure" : result;
  const id = await recordOutgoing(ctx, g, subject, body, status, error);
  if (status !== "sent") throw new HubError(status === "refused" ? 403 : 502, status === "refused" ? "forbidden" : "unavailable",
    status === "refused" ? "recipient consent is unavailable or withdrawn; no mail was sent" : result === "unknown" ? "mail transport failed; delivery is uncertain; check with recipients before sending again" : "mail preparation failed before transport; no mail was sent",
    { mail_delivery: { id, to_address: [g.to, ...(g.cc ?? [])].join(", "), in_reply_to: g.inbound_id, status, error } });
  return { id, status };
}

const body = (i: Record<string, unknown>) => {
  const b = reqString(i, "body", { max: 20_000 }).trim();
  if (!b) throw badRequest("the message needs some text");
  return b;
};

export const mailReply = defineVerb({
  name: "mail.reply", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Reply from the address a message was sent to, only to signed-up active human members of this organization (primary or confirmed linked addresses). No prior-contact or age limit. Agents reply to their own mail; people reply to organization/project mail. Agents may use all to include eligible copied members.",
  mcp: {
    scope: "write", destructive: false, title: "Reply by mail",
    input: { type: "object", properties: { id: { type: "string", description: "The received message's id (mail_list, mail_read)" }, body: { type: "string", description: "Plain text" }, all: { type: "boolean", description: "Agents: also write to the members it was addressed or copied to" } }, required: ["id", "body"], additionalProperties: false },
    render: (r) => {
      const x = r as { to: string; from: string; notice?: string };
      return `${DATA_NOTE}\n\nSent to ${x.to} from ${x.from}.${x.notice ? `\n\n${x.notice}` : ""}`;
    },
  },
  parse: (i) => ({ id: reqString(i, "id", { max: 40 }), body: body(i), all: i.all === true || i.all === "1" || i.all === "true" }),
  run: async (ctx, p) => {
    const access = readableMail(ctx);
    const m = await ctx.db.prepare(`/*perf-site:src%2Fverbs%2FmailOut.ts:117:21:mailReply.run:41c9b32c*/ SELECT m.id, m.from_email, m.to_address, m.subject, m.message_id, m.received_at, m.verdict, m.recipient_id, m.copied FROM inbound_mail m WHERE m.id = ? AND ${access.sql}`).bind(p.id, ...access.bindings)
      .first<{ id: string; from_email: string; to_address: string; subject: string; message_id: string | null; received_at: number; verdict: string; recipient_id: string | null; copied: string | null }>();
    if (!m || m.verdict !== "admitted") throw notFound("no such message");
    if (m.recipient_id ? m.recipient_id !== ctx.identity!.id : ctx.identity!.kind !== "human") throw forbidden(m.recipient_id ? "only the agent it was sent to replies to it" : "people reply to the organization's and projects' mail");
    const agent = ctx.identity!.kind === "agent";
    let cc: string[] = [];
    let skipped: string[] = [];
    if (agent) {
      // Reply all: the others it was addressed to, if they are members; anyone else is left out and named.
      if (p.all) {
        let others: string[] = [];
        try { others = (JSON.parse(m.copied ?? "[]") as string[]).filter((a) => a !== m.from_email && a !== ctx.identity!.email.toLowerCase()); } catch { others = []; }
        for (const a of others.slice(0, MAX_RECIPIENTS - 1)) ((await memberRecipientRefusals(ctx, [a])).length ? skipped : cc).push(a);
      }
    }
    const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || "your message"}`;
    const earlier = (await ctx.db.prepare("/*perf-site:src%2Fverbs%2FmailOut.ts:133:28:mailReply.run:04887000*/ SELECT o.id FROM outbound_mail o WHERE o.in_reply_to = ? AND o.status = 'sent' ORDER BY o.created_at").bind(m.id).all<{ id: string }>()).results.map((o) => `<${o.id}@${ctx.env.HUB_DOMAIN}>`);
    const notice = skipped.length
      ? `Reply-all omitted: ${skipped.join(", ")}. No mail was sent to these addresses. Recipients must join this organization or accept its membership invitation, with an active human membership for their exact email address set up by an administrator. Membership checks cannot be bypassed by external mail.`
      : undefined;
    const text = notice ? `${p.body}\n\n${notice}` : p.body;
    const r = await deliver(ctx, { from: m.to_address, to: m.from_email, cc, inbound_id: m.id, message_id: m.message_id, basis: "member" }, subject.slice(0, 200), text, [...(m.message_id ? [m.message_id] : []), ...earlier], async () => {
      const refused = await memberRecipientRefusals(ctx, [m.from_email, ...cc]);
      if (refused.length) throw new HubError(403, "forbidden", refused.join("; "), { mail_block: "recipient_policy" });
      await capsAndSwitch(ctx);
    });
    return { ...r, to: [m.from_email, ...cc].join(", "), from: m.to_address, ...(skipped.length ? { left_out: skipped, why: "copied recipients are not eligible under the organization membership policy", notice } : {}) };
  },
});

export const mailSend = defineVerb({
  name: "mail.send", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Send to signed-up active human members of this organization, at primary or confirmed linked addresses (to and cc, up to 10 total). No prior mail required. Agents send from their own address; people use from_project. Sending switch, daily caps and consent withdrawal apply.",
  mcp: {
    scope: "write", destructive: false, title: "Send mail",
    input: { type: "object", properties: {
      to: { type: "string", description: "An address, or several separated by commas" }, cc: { type: "string", description: "More addresses, separated by commas" },
      subject: { type: "string" }, body: { type: "string" }, from_project: { type: "string", description: "People: send from this project's address" } }, required: ["to", "subject", "body"], additionalProperties: false },
    render: (r) => { const x = r as { to: string; from: string }; return `${DATA_NOTE}\n\nSent to ${x.to} from ${x.from}.`; },
  },
  parse: (i) => {
    const to = addresses(i.to, "to"), cc = addresses(i.cc, "cc").filter((a) => !to.includes(a));
    if (!to.length) throw badRequest("to is required");
    if (to.length + cc.length > MAX_RECIPIENTS) throw badRequest(`at most ${MAX_RECIPIENTS} recipients`);
    const subject = reqString(i, "subject", { max: 200 }).trim();
    if (!subject || /[\r\n]/.test(subject)) throw badRequest("subject is one line");
    return { to, cc, subject, body: body(i), from_project: optString(i, "from_project", { max: 63 }) };
  },
  run: async (ctx, p) => {
    let from: string;
    if (ctx.identity!.kind === "agent") {
      if (p.from_project) throw forbidden("agents send from their own address");
      from = ctx.identity!.email;
    } else {
      if (!p.from_project) throw badRequest("people send from a project's address: give from_project");
      const pr = await ctx.db.prepare("/*perf-site:src%2Fverbs%2FmailOut.ts:174:24:mailSend.run:f365a4f2*/ SELECT slug FROM project WHERE tenant_id = ? AND slug = ? AND kind NOT IN ('channel', 'agent-src') AND state = 'active' AND (? IS NULL OR id = ?)").bind(ctx.tenant!.id, p.from_project.toLowerCase(), ctx.mcpProject?.id ?? null, ctx.mcpProject?.id ?? null).first<{ slug: string }>();
      if (!pr) throw notFound("no such project");
      from = `${ctx.tenant!.slug}.${pr.slug}@${ctx.env.HUB_DOMAIN}`;
    }
    const r = await deliver(ctx, { from, to: p.to[0]!, cc: [...p.to.slice(1), ...p.cc], inbound_id: null, message_id: null, basis: "member" }, p.subject, p.body, [], async () => {
      const refused = await memberRecipientRefusals(ctx, [...p.to, ...p.cc]);
      if (refused.length) throw new HubError(403, "forbidden", refused.join("; "), { mail_block: "recipient_policy" });
      await capsAndSwitch(ctx);
    });
    return { ...r, to: [...p.to, ...p.cc].join(", "), from };
  },
});

export const mailSending = defineVerb({
  name: "mail.sending", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, humanOnly: true,
  summary: "Turn outbound mail on or off for this organization. Off by default; membership, consent withdrawal and daily limits still apply.",
  parse: (i) => ({ on: i.on === true || i.on === "1" || i.on === "true" }),
  run: async (ctx, p) => {
    if (rank(ctx.role) < rank("admin")) throw forbidden();
    await ctx.db.prepare("/*perf-site:src%2Fverbs%2FmailOut.ts:204:11:mailSending.run:40425880*/ UPDATE tenant SET mail_out = ? WHERE id = ?").bind(p.on ? 1 : 0, ctx.tenant!.id).run();
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "mail.sending", target_kind: "tenant", target_id: ctx.tenant!.id, summary: `Turned outbound mail ${p.on ? "on" : "off"}` }, ctx.now);
    return { on: p.on };
  },
});
