import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleEmail } from "../src/mail/inbound";
import { STRANGER_REASON } from "../src/mail/projectMail";
import { hasActiveConsent } from "../src/db/consent";
import { createProject } from "../src/db/projects";
import { apiPost, cookieHeaders, seedHuman, seedTenant } from "./helpers";

const ctx = {} as ExecutionContext;
const HUB = "pimwell.test";

function mime(opts: { from: string; to: string; subject?: string; body?: string; html?: string; rfc822?: string }) {
  const b = "XBOUNDARYX";
  const parts: string[] = [];
  if (opts.body !== undefined) parts.push(`--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.body}\r\n`);
  if (opts.html !== undefined) parts.push(`--${b}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${opts.html}\r\n`);
  if (opts.rfc822 !== undefined) parts.push(`--${b}\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="fwd.eml"\r\n\r\n${opts.rfc822}\r\n`);
  return `From: ${opts.from}\r\nTo: ${opts.to}\r\nSubject: ${opts.subject ?? "hello"}\r\nMessage-ID: <m${Math.random().toString(36).slice(2)}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.join("")}--${b}--\r\n`;
}

function fake(from: string, to: string, raw: string, opts: { replyThrows?: boolean; rawSize?: number } = {}) {
  const calls = { rejects: [] as string[], replies: 0 };
  const bytes = new TextEncoder().encode(raw);
  const message = {
    from, to, headers: new Headers({ "message-id": "<m1@example.com>", subject: "hello" }),
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    rawSize: opts.rawSize ?? bytes.length,
    setReject(reason: string) { calls.rejects.push(reason); },
    async forward() { throw new Error("not used"); },
    async reply() { if (opts.replyThrows) throw new Error("reply not permitted"); calls.replies++; return { messageId: "<r@x>" }; },
  };
  return { message: message as unknown as ForwardableEmailMessage, calls };
}

async function world() {
  const org = await seedTenant("acme");
  await createProject(env.HUB_DB, { tenant_id: org.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, Date.now());
  const member = await seedHuman("pat@example.com", { memberships: [{ tenant_id: org.id, role: "member" }] });
  const admin = await seedHuman("ada@example.com", { memberships: [{ tenant_id: org.id, role: "admin" }] });
  return { org, member, admin };
}
const stored = async () => (await env.HUB_DB.prepare("SELECT verdict, subject, text, forwarded, project_id FROM inbound_mail ORDER BY received_at").all<{ verdict: string; subject: string; text: string; forwarded: number; project_id: string | null }>()).results;

describe("mailbox names", () => {
  it("are never available as organization names, so no inbox can collide with the hub's own", async () => {
    const root = await seedHuman("root@example.com", { is_root: true });
    for (const slug of ["privacy", "legal", "postmaster", "abuse", "security", "support", "no-reply", "login", "signup"]) {
      const res = await apiPost(HUB, "tenant.create", { slug, display_name: slug }, cookieHeaders(root.token, HUB));
      expect(res.status, slug).toBe(400);
    }
  });
});

describe("mail to organizations and projects", () => {
  it("refuses addresses that name nothing", async () => {
    await world();
    for (const to of [`nosuch@${HUB}`, `acme.nosuch@${HUB}`, `acme.site@elsewhere.com`]) {
      const f = fake("pat@example.com", to, mime({ from: "pat@example.com", to, body: "hi" }));
      await handleEmail(f.message, env, ctx);
      expect(f.calls.rejects, to).toEqual(["Unknown recipient"]);
    }
    expect(await stored()).toHaveLength(0);
  });

  it("refuses strangers and stores nothing", async () => {
    await world();
    await seedHuman("outsider@example.com");
    const f = fake("outsider@example.com", `acme.site@${HUB}`, mime({ from: "outsider@example.com", to: `acme.site@${HUB}`, body: "hi" }));
    await handleEmail(f.message, env, ctx);
    expect(f.calls.rejects).toEqual([STRANGER_REASON]);
    expect(await stored()).toHaveLength(0);
  });

  it("admits a member's proven mail to a project, with a receipt", async () => {
    await world();
    const f = fake("pat@example.com", `acme.site@${HUB}`, mime({ from: "pat@example.com", to: `acme.site@${HUB}`, subject: "Checkout broke", body: "Users say checkout fails." }));
    await handleEmail(f.message, env, ctx);
    expect(f.calls.replies).toBe(1);
    const [m] = await stored();
    expect(m).toMatchObject({ verdict: "admitted", subject: "Checkout broke", forwarded: 0 });
    expect(m!.text).toContain("checkout fails");
    expect(m!.project_id).not.toBeNull();
    expect(await hasActiveConsent(env.HUB_DB, "pat@example.com")).toBe(true);
  });

  it("quarantines mail whose sender cannot be proven, and keeps no consent", async () => {
    await world();
    const f = fake("pat@example.com", `acme@${HUB}`, mime({ from: "pat@example.com", to: `acme@${HUB}`, body: "maybe forged" }), { replyThrows: true });
    await handleEmail(f.message, env, ctx);
    const [m] = await stored();
    expect(m).toMatchObject({ verdict: "quarantined", project_id: null });
    expect(await hasActiveConsent(env.HUB_DB, "pat@example.com")).toBe(false);
  });

  it("reads forwarded messages and HTML-only mail as text", async () => {
    await world();
    const inner = "From: user@customer.example\r\nSubject: Prices look wrong\r\nContent-Type: text/plain\r\n\r\nThe price for X is off by 10x.";
    const f = fake("pat@example.com", `acme.site@${HUB}`, mime({ from: "pat@example.com", to: `acme.site@${HUB}`, html: "<p>FYI <b>see below</b></p>", rfc822: inner }));
    await handleEmail(f.message, env, ctx);
    const [m] = await stored();
    expect(m!.forwarded).toBe(1);
    expect(m!.text).toContain("FYI see below");
    expect(m!.text).toContain("off by 10x");
  });

  it("refuses oversized mail", async () => {
    await world();
    const f = fake("pat@example.com", `acme.site@${HUB}`, mime({ from: "pat@example.com", to: `acme.site@${HUB}`, body: "x" }), { rawSize: 11 * 1024 * 1024 });
    await handleEmail(f.message, env, ctx);
    expect(f.calls.rejects).toEqual(["Message too large"]);
  });

  it("shows admitted mail to members, quarantine only to admins, and lets an admin release it", async () => {
    const w = await world();
    await handleEmail(fake("pat@example.com", `acme.site@${HUB}`, mime({ from: "pat@example.com", to: `acme.site@${HUB}`, subject: "ok one", body: "a" })).message, env, ctx);
    await handleEmail(fake("pat@example.com", `acme@${HUB}`, mime({ from: "pat@example.com", to: `acme@${HUB}`, subject: "held one", body: "b" }), { replyThrows: true }).message, env, ctx);
    const host = `acme.${HUB}`;
    const memberList = await (await apiPost(host, "mail.list", {}, cookieHeaders(w.member.token, host))).json() as { result: { mail: Array<{ subject: string }> } };
    expect(memberList.result.mail.map((m) => m.subject)).toEqual(["ok one"]);
    expect((await apiPost(host, "mail.list", { quarantined: true }, cookieHeaders(w.member.token, host))).status).toBe(404);
    const held = await (await apiPost(host, "mail.list", { quarantined: true }, cookieHeaders(w.admin.token, host))).json() as { result: { mail: Array<{ id: string }> } };
    expect(held.result.mail).toHaveLength(1);
    expect((await apiPost(host, "mail.read", { id: held.result.mail[0]!.id }, cookieHeaders(w.member.token, host))).status).toBe(404);
    expect((await apiPost(host, "mail.release", { id: held.result.mail[0]!.id }, cookieHeaders(w.admin.token, host))).status).toBe(200);
    expect((await apiPost(host, "mail.read", { id: held.result.mail[0]!.id }, cookieHeaders(w.member.token, host))).status).toBe(200);
    const page = await (await SELF.fetch(`https://${host}/mail`, { headers: cookieHeaders(w.member.token, host) })).text();
    expect(page).toContain(`acme.site@${HUB}`);
    expect(page).toContain("held one");
  });
});
