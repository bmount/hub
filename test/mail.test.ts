import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { buildMime, safeMessageId } from "../src/mail/mime";
import { sendMail, setTestTransport, type SentMail } from "../src/mail/send";
import { grantConsent, revokeConsent } from "../src/db/consent";

const consent = (email: string) => grantConsent(env.HUB_DB, { email, kind: "inbound_email", source_message_id: null, evidence: null }, Date.now());
const base = { from: "login@pimwell.test", to: "a@example.com", subject: "s", text: "t", messageId: "<x1@pimwell.test>", date: new Date(Date.UTC(2026, 9, 6)), inReplyTo: null };

describe("buildMime", () => {
  it("builds a CRLF plain-text message with threading headers on replies", () => {
    const raw = buildMime({ ...base, subject: "Your Pimwell sign-in link", text: "line one\nline two", inReplyTo: "<orig@example.com>" });
    expect(raw).toContain("From: login@pimwell.test\r\n");
    expect(raw).toContain("To: a@example.com\r\n");
    expect(raw).toContain("Subject: Your Pimwell sign-in link\r\n");
    expect(raw).toContain("Message-ID: <x1@pimwell.test>\r\n");
    expect(raw).toContain("In-Reply-To: <orig@example.com>\r\n");
    expect(raw).toContain("References: <orig@example.com>\r\n");
    expect(raw).toContain("Auto-Submitted: auto-replied\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8\r\n");
    expect(raw).toContain("\r\n\r\nline one\r\nline two\r\n");
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  it("marks non-replies auto-generated and omits threading headers", () => {
    const raw = buildMime(base);
    expect(raw).toContain("Auto-Submitted: auto-generated\r\n");
    expect(raw).not.toContain("In-Reply-To");
  });

  it("refuses header injection and non-ASCII bodies", () => {
    expect(() => buildMime({ ...base, subject: "s\r\nBcc: b@example.com" })).toThrow();
    expect(() => buildMime({ ...base, to: "a@example.com\nBcc: b@example.com" })).toThrow();
    expect(() => buildMime({ ...base, text: "café" })).toThrow();
  });

  it("accepts only well-formed message ids", () => {
    expect(safeMessageId(" <a.b@example.com> ")).toBe("<a.b@example.com>");
    expect(safeMessageId("<a b@example.com>")).toBeNull();
    expect(safeMessageId("<a@example.com>\r\nBcc: x")).toBeNull();
    expect(safeMessageId("a@example.com")).toBeNull();
    expect(safeMessageId(null)).toBeNull();
  });
});

describe("sendMail", () => {
  const sent: SentMail[] = [];
  afterEach(() => {
    sent.length = 0;
    setTestTransport(null);
  });
  const capture = () => setTestTransport(async (m) => { sent.push(m); });

  it("refuses without consent and never reaches the transport", async () => {
    capture();
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now())).toBe("no_consent");
    expect(sent).toHaveLength(0);
  });

  it("sends from login@ once consent exists, and stops after revoke", async () => {
    capture();
    await consent("a@example.com");
    expect(await sendMail(env, { to: "A@Example.com", subject: "s", text: "t" }, Date.now())).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe("login@pimwell.test");
    expect(sent[0]!.to).toBe("a@example.com");
    expect(sent[0]!.raw).toContain("Subject: s\r\n");
    expect(sent[0]!.raw).toMatch(/Message-ID: <[0-9A-Z]{26}@pimwell\.test>\r\n/);
    await revokeConsent(env.HUB_DB, "a@example.com", Date.now());
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now())).toBe("no_consent");
    expect(sent).toHaveLength(1);
  });

  it("reports failure without throwing", async () => {
    setTestTransport(async () => { throw new Error("boom"); });
    await consent("a@example.com");
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now())).toBe("failed");
    expect(await sendMail(env, { to: "a@example.com", subject: "café", text: "t" }, Date.now())).toBe("failed");
  });

  it("replies through the inbound message from the receiving address, gated by the same consent check", async () => {
    capture();
    const replies: Array<{ from: string; to: string }> = [];
    const message = {
      from: "a@example.com", to: "signup@pimwell.test", headers: new Headers({ "message-id": "<orig@example.com>" }),
      reply: async (m: EmailMessage) => { replies.push({ from: m.from, to: m.to }); return { messageId: "<r1@pimwell.test>" }; },
    } as unknown as ForwardableEmailMessage;
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now(), { replyTo: message })).toBe("no_consent");
    expect(replies).toHaveLength(0);
    await consent("a@example.com");
    expect(await sendMail(env, { to: "a@example.com", subject: "s", text: "t" }, Date.now(), { replyTo: message })).toBe("sent");
    expect(replies).toEqual([{ from: "signup@pimwell.test", to: "a@example.com" }]);
    expect(sent).toHaveLength(0);
  });

  it("returns failed, not a throw, when the consent lookup errors", async () => {
    capture();
    const broken = { ...env, HUB_DB: { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database };
    expect(await sendMail(broken, { to: "a@example.com", subject: "s", text: "t" }, Date.now())).toBe("failed");
    expect(sent).toHaveLength(0);
  });
});
