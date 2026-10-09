// Outbound mail (B3): the golden rule in code. Only to someone who wrote to that address in the last 30 days, only
// when the organization has sending on, within daily caps, and kept in full.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { handleProjectMail } from "../src/mail/projectMail";
import fixtures from "./fixtures/mail-ingress.json";
import { setTestTransport, type SentMail } from "../src/mail/send";
import { buildMime } from "../src/mail/mime";
import { createProject } from "../src/db/projects";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";

const HOST = "acme.pimwell.test";
afterEach(() => setTestTransport(null));

async function inbound(raw: string, to: string) {
  const bytes = new TextEncoder().encode(raw);
  const message = {
    from: "pat@example.com", to, headers: new Headers(), rawSize: bytes.length,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject() {}, async forward() {}, async reply() { throw new Error("routine reply forbidden"); },
  } as unknown as ForwardableEmailMessage;
  expect(await handleProjectMail(message, env, Date.now(), async () => [[fixtures.record]])).toBe("admitted");
}

async function world() {
  const t = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: t.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const pat = await seedHuman("pat@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const ada = await seedHuman("ada@example.com", { memberships: [{ tenant_id: t.id, role: "admin" }] });
  const bot = await seedAgent(t, pat.identity, "scout");
  setTestTransport(async () => {});
  await inbound(fixtures.outProject, "acme.site@pimwell.test");
  await inbound(fixtures.outAgent, "acme.scout@pimwell.test");
  const ids = (await env.HUB_DB.prepare("SELECT id, to_address FROM inbound_mail ORDER BY to_address").all<{ id: string; to_address: string }>()).results;
  const sent: SentMail[] = [];
  setTestTransport(async (m) => { sent.push(m); });
  const call = async (h: Record<string, string>, verb: string, body: unknown) => {
    const r = await apiPost(HOST, verb, body, h);
    return { status: r.status, ...((await r.json()) as { result: Record<string, unknown>; detail?: string }) };
  };
  return { t, pat: cookieHeaders(pat.token, HOST), ada: cookieHeaders(ada.token, HOST), bot: bearer(bot.token), call, sent,
    agentMail: ids.find((x) => x.to_address === "acme.scout@pimwell.test")!.id, projectMail: ids.find((x) => x.to_address === "acme.site@pimwell.test")!.id };
}

describe("outbound mail", () => {
  it("sends nothing until an admin turns sending on", async () => {
    const w = await world();
    expect((await w.call(w.pat, "mail.reply", { id: w.projectMail, body: "Thanks" })).status).toBe(403);
    expect((await w.call(w.pat, "mail.sending", { on: true })).status).toBe(403);
    expect((await w.call(w.ada, "mail.sending", { on: true })).status).toBe(200);
    const r = await w.call(w.pat, "mail.reply", { id: w.projectMail, body: "Thanks — on it. 👍" });
    expect(r.status, r.detail).toBe(200);
    expect(w.sent.length).toBe(1);
    expect(w.sent[0]).toMatchObject({ from: "acme.site@pimwell.test", to: "pat@example.com", subject: "Re: Prices" });
    expect(w.sent[0]!.raw).toContain("In-Reply-To: <");
    expect(w.sent[0]!.raw).toContain("Content-Transfer-Encoding: base64");
    expect((await env.HUB_DB.prepare("SELECT status, in_reply_to FROM outbound_mail").first())).toEqual({ status: "sent", in_reply_to: w.projectMail });
  });

  it("lets an agent answer only its own mail, and people only the organization's and projects'", async () => {
    const w = await world();
    await w.call(w.ada, "mail.sending", { on: true });
    expect((await w.call(w.pat, "mail.reply", { id: w.agentMail, body: "x" })).status).toBe(403);
    expect((await w.call(w.bot, "mail.reply", { id: w.projectMail, body: "x" })).status).toBe(403);
    expect((await w.call(w.bot, "mail.reply", { id: w.agentMail, body: "Done." })).status).toBe(200);
    expect(w.sent[0]).toMatchObject({ from: "acme.scout@pimwell.test", to: "pat@example.com" });
  });

  it("people write only to those who wrote in the last 30 days; agents to members who wrote, at any time", async () => {
    const w = await world();
    await w.call(w.ada, "mail.sending", { on: true });
    expect((await w.call(w.bot, "mail.send", { to: "pat@example.com", subject: "Follow-up", body: "Hi" })).status).toBe(200);
    expect((await w.call(w.bot, "mail.send", { to: "stranger@example.com", subject: "Hi", body: "Hi" })).status).toBe(403);
    expect((await w.call(w.bot, "mail.send", { to: "pat@example.com", subject: "x", body: "x", from_project: "site" })).status).toBe(403);
    expect((await w.call(w.pat, "mail.send", { to: "pat@example.com", subject: "x", body: "x" })).status).toBe(400);
    expect((await w.call(w.pat, "mail.send", { to: "pat@example.com", subject: "Update", body: "x", from_project: "site" })).status).toBe(200);
    expect((await w.call(w.bot, "mail.send", { to: "pat@example.com", subject: "a\r\nBcc: x@y.z", body: "x" })).status).toBe(400);
    await env.HUB_DB.prepare("UPDATE inbound_mail SET received_at = received_at - 31 * 86400000").run();
    // A member who wrote to the agent stays reachable; the 30-day window is for people writing from project addresses.
    expect((await w.call(w.bot, "mail.send", { to: "pat@example.com", subject: "Late", body: "x" })).status).toBe(200);
    expect((await w.call(w.bot, "mail.reply", { id: w.agentMail, body: "Late" })).status).toBe(200);
    expect((await w.call(w.pat, "mail.send", { to: "pat@example.com", subject: "Late", body: "x", from_project: "site" })).status).toBe(403);
  });

  it("caps each sender at 50 a day", async () => {
    const w = await world();
    await w.call(w.ada, "mail.sending", { on: true });
    const botId = (await env.HUB_DB.prepare("SELECT id FROM identity WHERE email = 'acme.scout@pimwell.test'").first<{ id: string }>())!.id;
    const now = Date.now();
    await env.HUB_DB.batch(Array.from({ length: 50 }, (_, n) => env.HUB_DB.prepare(`INSERT INTO outbound_mail (id, tenant_id, from_address, to_address, subject, text, sent_by, status, created_at) VALUES (?, ?, 'a', 'b', 's', 't', ?, 'sent', ?)`).bind(`O${n}`, w.t.id, botId, now)));
    expect((await w.call(w.bot, "mail.reply", { id: w.agentMail, body: "one more" })).status).toBe(429);
  });

  it("encodes non-ASCII subjects and refuses header injection", () => {
    const raw = buildMime({ from: "a@pimwell.test", to: "b@example.com", subject: "Größe ✓", text: "ok", messageId: "<x@pimwell.test>", date: new Date(0), inReplyTo: null, utf8: true });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(() => buildMime({ from: "a@pimwell.test", to: "b@example.com", subject: "x\r\nBcc: c@d.e", text: "ok", messageId: "<x@pimwell.test>", date: new Date(0), inReplyTo: null, utf8: true })).toThrow();
    expect(() => buildMime({ from: "a@pimwell.test", to: "b@example.com", subject: "x", text: "é", messageId: "<x@pimwell.test>", date: new Date(0), inReplyTo: null })).toThrow();
  });

  it("lets agents write to members who wrote to them or were copied by a member, and to no one else", async () => {
    const w = await world();
    await w.call(w.ada, "mail.sending", { on: true });
    await seedHuman("kim@example.com", { memberships: [{ tenant_id: w.t.id, role: "member" }] });
    await seedHuman("lee@example.com", { memberships: [{ tenant_id: w.t.id, role: "member" }] });
    // Pat writes to the agent, copying Kim (a member) and someone outside the organization.
    await inbound(fixtures.outCopied, "acme.scout@pimwell.test");
    const copiedMail = (await env.HUB_DB.prepare("SELECT id, copied FROM inbound_mail WHERE subject = 'Launch plan'").first<{ id: string; copied: string }>())!;
    expect(JSON.parse(copiedMail.copied)).toEqual(["kim@example.com", "outside@example.org"]);

    expect((await w.call(w.bot, "mail.send", { to: "kim@example.com", subject: "Plan", body: "Kim, here is the plan." })).status).toBe(200);
    const outsider = await w.call(w.bot, "mail.send", { to: "outside@example.org", subject: "Plan", body: "x" });
    expect(outsider.status).toBe(403);
    expect(outsider.detail).toContain("not a member");
    const lee = await w.call(w.bot, "mail.send", { to: "lee@example.com", subject: "Plan", body: "x" });
    expect(lee.status).toBe(403);
    expect(lee.detail).toContain("hasn't written to you");
    // Several recipients: all must qualify; one message, every recipient in its headers.
    expect((await w.call(w.bot, "mail.send", { to: "pat@example.com, kim@example.com", cc: "lee@example.com", subject: "x", body: "x" })).status).toBe(403);
    w.sent.length = 0;
    expect((await w.call(w.bot, "mail.send", { to: "pat@example.com", cc: "kim@example.com", subject: "Both of you", body: "x" })).status).toBe(200);
    expect(w.sent.map((m) => m.to).sort()).toEqual(["kim@example.com", "pat@example.com"]);
    expect(w.sent[0]!.raw).toContain("Cc: kim@example.com");
    // Reply all: the members it was addressed to; the outsider is left out, and named.
    w.sent.length = 0;
    const all = await w.call(w.bot, "mail.reply", { id: copiedMail.id, body: "Thanks, both.", all: true });
    expect(all.status).toBe(200);
    expect(all.result).toMatchObject({ to: "pat@example.com, kim@example.com", left_out: ["outside@example.org"] });
    expect(w.sent.map((m) => m.to).sort()).toEqual(["kim@example.com", "pat@example.com"]);
    // A member who withdrew consent is never written to.
    await env.HUB_DB.prepare("INSERT INTO consent (id, email, tenant_id, kind, granted_at, revoked_at, source_message_id, evidence) VALUES ('c-kim', 'kim@example.com', NULL, 'inbound_email', 1, 2, NULL, NULL)").run();
    expect((await w.call(w.bot, "mail.send", { to: "kim@example.com", subject: "x", body: "x" })).status).toBe(403);
    // Kim leaves the organization: no longer reachable.
    await env.HUB_DB.prepare("DELETE FROM consent WHERE id = 'c-kim'").run();
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = (SELECT id FROM identity WHERE email = 'kim@example.com')").run();
    expect((await w.call(w.bot, "mail.send", { to: "kim@example.com", subject: "x", body: "x" })).status).toBe(403);
  });
});
