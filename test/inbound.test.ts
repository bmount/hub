import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { handleEmail } from "../src/mail/inbound";
import { hasActiveConsent, listConsent } from "../src/db/consent";
import { createIdentity } from "../src/db/identities";
import { takeRate } from "../src/rate";
import { seedHuman } from "./helpers";

type Calls = { rejects: string[]; replies: Array<{ from: string; to: string }> };

function fakeMessage(from: string, to: string, opts: { replyThrows?: boolean; messageId?: string | null } = {}) {
  const calls: Calls = { rejects: [], replies: [] };
  const headers = new Headers({ subject: "hello" });
  if (opts.messageId !== null) headers.set("message-id", opts.messageId ?? "<m1@example.com>");
  const message = {
    from, to, headers,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    rawSize: 0,
    setReject(reason: string) { calls.rejects.push(reason); },
    async forward() { throw new Error("not used"); },
    async reply(m: EmailMessage) {
      if (opts.replyThrows) throw new Error("reply not permitted");
      calls.replies.push({ from: m.from, to: m.to });
      return { messageId: "<r1@pimwell.test>" };
    },
  };
  return { message: message as unknown as ForwardableEmailMessage, calls };
}

const ctx = {} as ExecutionContext;
const links = async () => (await env.HUB_DB.prepare("SELECT identity_id, purpose FROM auth_link").all<{ identity_id: string; purpose: string }>()).results;
const eventKinds = async () => (await env.HUB_DB.prepare("SELECT kind FROM event ORDER BY created_at, id").all<{ kind: string }>()).results.map((r) => r.kind);

describe("worker entry", () => {
  it("exports email alongside fetch and still serves routes", async () => {
    expect(typeof worker.email).toBe("function");
    expect(typeof worker.fetch).toBe("function");
    expect(await (await SELF.fetch("https://pimwell.test/healthz")).text()).toBe("ok");
  });
});

describe("handleEmail", () => {
  it("records consent and replies from login@ with a login link", async () => {
    const h = await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test");
    await handleEmail(message, env, ctx);
    expect(calls.rejects).toEqual([]);
    expect(calls.replies).toEqual([{ from: "login@pimwell.test", to: "a@example.com" }]);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(true);
    const [c] = await listConsent(env.HUB_DB, "a@example.com");
    expect(c!.kind).toBe("inbound_email");
    expect(c!.source_message_id).toBe("<m1@example.com>");
    expect(await links()).toEqual([{ identity_id: h.identity.id, purpose: "login" }]);
    expect((await eventKinds()).sort()).toEqual(["auth_link.create", "consent.grant"]);
  });

  it("signup@ behaves the same, replies from signup@, and does not duplicate consent", async () => {
    await seedHuman("a@example.com");
    await handleEmail(fakeMessage("a@example.com", "login@pimwell.test").message, env, ctx);
    const { message, calls } = fakeMessage("a@example.com", "Signup@Pimwell.test", { messageId: "<m2@example.com>" });
    await handleEmail(message, env, ctx);
    expect(calls.replies).toEqual([{ from: "signup@pimwell.test", to: "a@example.com" }]);
    expect(await listConsent(env.HUB_DB, "a@example.com")).toHaveLength(1);
    expect(await links()).toHaveLength(2);
  });

  it("matches the sender case-insensitively", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("A@Example.COM", "login@pimwell.test");
    await handleEmail(message, env, ctx);
    expect(calls.rejects).toEqual([]);
    expect(calls.replies).toHaveLength(1);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(true);
  });

  it("rejects unknown, archived, and agent senders without consent or reply", async () => {
    const gone = await seedHuman("gone@example.com");
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(gone.identity.id).run();
    const op = await seedHuman("op@example.com");
    await createIdentity(env.HUB_DB, { kind: "agent", email: "bot@acme.pimwell.test", display_name: "Bot", is_root: 0, operator_id: op.identity.id }, Date.now());
    for (const from of ["nobody@example.com", "gone@example.com", "bot@acme.pimwell.test"]) {
      const { message, calls } = fakeMessage(from, "login@pimwell.test");
      await handleEmail(message, env, ctx);
      expect(calls.rejects).toHaveLength(1);
      expect(calls.replies).toHaveLength(0);
      expect(await hasActiveConsent(env.HUB_DB, from)).toBe(false);
    }
    expect(await links()).toHaveLength(0);
  });

  it("rejects mail to any other recipient", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "other@pimwell.test");
    await handleEmail(message, env, ctx);
    expect(calls.rejects).toHaveLength(1);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(false);
  });

  it("revokes the new consent and records an event when reply throws (no DMARC pass)", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test", { replyThrows: true });
    await expect(handleEmail(message, env, ctx)).resolves.toBeUndefined();
    expect(calls.rejects).toEqual([]);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(false);
    expect(await eventKinds()).toContain("login.reply_failed");
  });

  it("keeps pre-existing consent when a later reply fails", async () => {
    await seedHuman("a@example.com");
    await handleEmail(fakeMessage("a@example.com", "login@pimwell.test").message, env, ctx);
    await handleEmail(fakeMessage("a@example.com", "login@pimwell.test", { replyThrows: true }).message, env, ctx);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(true);
  });

  it("grants no consent to a rate-limited message", async () => {
    await seedHuman("a@example.com");
    for (let i = 0; i < 3; i++) await takeRate(env.RATE, "addr", "a@example.com", Date.now());
    const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test");
    await handleEmail(message, env, ctx);
    expect(calls.replies).toHaveLength(0);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(false);
    expect(await links()).toHaveLength(0);
  });

  it("rejects a spoofed header From when the envelope sender is unknown", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("stranger@example.com", "login@pimwell.test");
    message.headers.set("from", "a@example.com");
    await handleEmail(message, env, ctx);
    expect(calls.rejects).toHaveLength(1);
    expect(calls.replies).toHaveLength(0);
    expect(await hasActiveConsent(env.HUB_DB, "a@example.com")).toBe(false);
    expect(await hasActiveConsent(env.HUB_DB, "stranger@example.com")).toBe(false);
  });

  it("swallows internal failures", async () => {
    const { message } = fakeMessage("a@example.com", "login@pimwell.test");
    await expect(handleEmail(message, { ...env, HUB_DB: undefined as unknown as D1Database }, ctx)).resolves.toBeUndefined();
  });

  it("replies even when the inbound message has no Message-ID", async () => {
    await seedHuman("a@example.com");
    const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test", { messageId: null });
    await handleEmail(message, env, ctx);
    expect(calls.replies).toHaveLength(1);
    expect((await listConsent(env.HUB_DB, "a@example.com"))[0]!.source_message_id).toBeNull();
  });

  it("caps replies at 3 per sender per hour", async () => {
    await seedHuman("a@example.com");
    let replies = 0;
    for (let i = 0; i < 4; i++) {
      const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test", { messageId: `<m${i}@example.com>` });
      await handleEmail(message, env, ctx);
      replies += calls.replies.length;
    }
    expect(replies).toBe(3);
    expect(await eventKinds()).toContain("login.inbound_limited");
  });

  it("records exactly one limited event for 6 messages", async () => {
    await seedHuman("a@example.com");
    let replies = 0;
    for (let i = 0; i < 6; i++) {
      const { message, calls } = fakeMessage("a@example.com", "login@pimwell.test", { messageId: `<m${i}@example.com>` });
      await handleEmail(message, env, ctx);
      replies += calls.replies.length;
    }
    expect(replies).toBe(3);
    expect((await eventKinds()).filter((k) => k === "login.inbound_limited")).toHaveLength(1);
  });
});
