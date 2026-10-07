// Outbound mail (design 2026-10-07, B3): the golden rule in code. Pimwell writes only to someone who wrote to that
// very address within the last 30 days; the organization must have sending turned on; each sender has a daily cap,
// and so does the organization; every message is kept in full. Agents send from their own address; replies go from
// the address the message came to.
import { defineVerb } from "./table";
import { optString, reqString } from "./params";
import { badRequest, forbidden, notFound } from "../errors";
import { HubError } from "../errors";
import { recordEvent } from "../db/events";
import { ulid } from "../ids";
import { rank, type Ctx } from "../auth/context";
import { sendMail } from "../mail/send";
import { DATA_NOTE } from "../mcp/render";

export const REPLY_WINDOW_MS = 30 * 86_400_000;
export const SENDER_DAILY = 50;
export const TENANT_DAILY = 500;

type Gate = { from: string; to: string; inbound_id: string | null; message_id: string | null };

async function capsAndSwitch(ctx: Ctx): Promise<void> {
  const r = await ctx.db.prepare(`SELECT t.mail_out,
      (SELECT COUNT(*) FROM outbound_mail WHERE sent_by = ? AND status = 'sent' AND created_at > ?) AS mine,
      (SELECT COUNT(*) FROM outbound_mail WHERE tenant_id = t.id AND status = 'sent' AND created_at > ?) AS ours
    FROM tenant t WHERE t.id = ?`).bind(ctx.identity!.id, ctx.now - 86_400_000, ctx.now - 86_400_000, ctx.tenant!.id).first<{ mail_out: number; mine: number; ours: number }>();
  if (!r || r.mail_out !== 1) throw forbidden("sending mail is off in this organization; an admin can turn it on under Mail");
  if (r.mine >= SENDER_DAILY) throw new HubError(429, "too_many_requests", `at most ${SENDER_DAILY} messages a day per sender`);
  if (r.ours >= TENANT_DAILY) throw new HubError(429, "too_many_requests", `at most ${TENANT_DAILY} messages a day per organization`);
}

async function deliver(ctx: Ctx, g: Gate, subject: string, body: string, references: string[]): Promise<{ id: string; status: string }> {
  const id = ulid(ctx.now);
  const result = await sendMail(ctx.env, { to: g.to, from: g.from, subject, text: body, inReplyTo: g.message_id, references, utf8: true }, ctx.now);
  const status = result === "sent" ? "sent" : result === "no_consent" ? "refused" : "failed";
  await ctx.db.prepare(`INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, in_reply_to, sent_by, session_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ctx.tenant!.id, g.from, g.to, subject, body, g.inbound_id, ctx.identity!.id, ctx.session?.id ?? null, status, result === "sent" ? null : result, ctx.now).run();
  await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: status === "sent" ? "mail.sent" : "mail.not_sent",
    target_kind: "outbound_mail", target_id: id, summary: `${status === "sent" ? "Mailed" : "Could not mail"} ${g.to} from ${g.from}: ${subject}`.slice(0, 300) }, ctx.now);
  if (status !== "sent") throw new HubError(status === "refused" ? 403 : 502, status === "refused" ? "forbidden" : "unavailable", status === "refused" ? "that address has withdrawn consent" : "the mail service did not accept it; try again later");
  return { id, status };
}

const body = (i: Record<string, unknown>) => {
  const b = reqString(i, "body", { max: 20_000 }).trim();
  if (!b) throw badRequest("the message needs some text");
  return b;
};

export const mailReply = defineVerb({
  name: "mail.reply", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Reply by mail to a message received here, from the address it was sent to, within 30 days of receiving it. Agents reply to their own mail; members reply to the organization's and projects'.",
  mcp: {
    scope: "write", destructive: false, title: "Reply by mail",
    input: { type: "object", properties: { id: { type: "string", description: "The received message's id (mail_list, mail_read)" }, body: { type: "string", description: "Plain text" } }, required: ["id", "body"], additionalProperties: false },
    render: (r) => { const x = r as { to: string; from: string }; return `${DATA_NOTE}\n\nSent to ${x.to} from ${x.from}.`; },
  },
  parse: (i) => ({ id: reqString(i, "id", { max: 40 }), body: body(i) }),
  run: async (ctx, p) => {
    const m = await ctx.db.prepare("SELECT id, from_email, to_address, subject, message_id, received_at, verdict, recipient_id FROM inbound_mail WHERE id = ? AND tenant_id = ?").bind(p.id, ctx.tenant!.id)
      .first<{ id: string; from_email: string; to_address: string; subject: string; message_id: string | null; received_at: number; verdict: string; recipient_id: string | null }>();
    if (!m || m.verdict !== "admitted") throw notFound("no such message");
    if (m.recipient_id ? m.recipient_id !== ctx.identity!.id : ctx.identity!.kind !== "human") throw forbidden(m.recipient_id ? "only the agent it was sent to replies to it" : "people reply to the organization's and projects' mail");
    if (ctx.now - m.received_at > REPLY_WINDOW_MS) throw forbidden("it has been more than 30 days; wait for them to write again");
    await capsAndSwitch(ctx);
    const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || "your message"}`;
    const earlier = (await ctx.db.prepare("SELECT o.id FROM outbound_mail o WHERE o.in_reply_to = ? AND o.status = 'sent' ORDER BY o.created_at").bind(m.id).all<{ id: string }>()).results.map((o) => `<${o.id}@${ctx.env.HUB_DOMAIN}>`);
    const r = await deliver(ctx, { from: m.to_address, to: m.from_email, inbound_id: m.id, message_id: m.message_id }, subject.slice(0, 200), p.body, [...(m.message_id ? [m.message_id] : []), ...earlier]);
    return { ...r, to: m.from_email, from: m.to_address };
  },
});

export const mailSend = defineVerb({
  name: "mail.send", kind: "command", scope: "tenant", minRole: "member", freshProofMinutes: null,
  summary: "Send a new message to someone who wrote to the sending address within the last 30 days. Agents send from their own address; members can send from a project's address with from_project.",
  mcp: {
    scope: "write", destructive: false, title: "Send mail",
    input: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, from_project: { type: "string", description: "People: send from this project's address" } }, required: ["to", "subject", "body"], additionalProperties: false },
    render: (r) => { const x = r as { to: string; from: string }; return `${DATA_NOTE}\n\nSent to ${x.to} from ${x.from}.`; },
  },
  parse: (i) => {
    const to = reqString(i, "to", { max: 254 }).trim().toLowerCase();
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(to)) throw badRequest("to must be one email address");
    const subject = reqString(i, "subject", { max: 200 }).trim();
    if (!subject || /[\r\n]/.test(subject)) throw badRequest("subject is one line");
    return { to, subject, body: body(i), from_project: optString(i, "from_project", { max: 63 }) };
  },
  run: async (ctx, p) => {
    let from: string;
    if (ctx.identity!.kind === "agent") {
      if (p.from_project) throw forbidden("agents send from their own address");
      from = ctx.identity!.email;
    } else {
      if (!p.from_project) throw badRequest("people send from a project's address: give from_project");
      const pr = await ctx.db.prepare("SELECT slug FROM project WHERE tenant_id = ? AND slug = ? AND kind <> 'channel' AND state = 'active'").bind(ctx.tenant!.id, p.from_project.toLowerCase()).first<{ slug: string }>();
      if (!pr) throw notFound("no such project");
      from = `${ctx.tenant!.slug}.${pr.slug}@${ctx.env.HUB_DOMAIN}`;
    }
    const wrote = await ctx.db.prepare("SELECT 1 FROM inbound_mail WHERE tenant_id = ? AND from_email = ? AND to_address = ? AND verdict = 'admitted' AND received_at > ? LIMIT 1")
      .bind(ctx.tenant!.id, p.to, from, ctx.now - REPLY_WINDOW_MS).first();
    if (!wrote) throw forbidden(`Pimwell writes only to people who wrote to ${from} in the last 30 days`);
    await capsAndSwitch(ctx);
    const r = await deliver(ctx, { from, to: p.to, inbound_id: null, message_id: null }, p.subject, p.body, []);
    return { ...r, to: p.to, from };
  },
});

export const mailSending = defineVerb({
  name: "mail.sending", kind: "command", scope: "tenant", minRole: "admin", freshProofMinutes: 60, humanOnly: true,
  summary: "Turn outbound mail on or off for this organization. Off by default; the 30-day and daily limits apply either way.",
  parse: (i) => ({ on: i.on === true || i.on === "1" || i.on === "true" }),
  run: async (ctx, p) => {
    if (rank(ctx.role) < rank("admin")) throw forbidden();
    await ctx.db.prepare("UPDATE tenant SET mail_out = ? WHERE id = ?").bind(p.on ? 1 : 0, ctx.tenant!.id).run();
    await recordEvent(ctx.db, { tenant_id: ctx.tenant!.id, identity_id: ctx.identity!.id, session_id: ctx.session?.id ?? null, kind: "mail.sending", target_kind: "tenant", target_id: ctx.tenant!.id, summary: `Turned outbound mail ${p.on ? "on" : "off"}` }, ctx.now);
    return { on: p.on };
  },
});
