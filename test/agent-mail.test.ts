// Agents' own addresses and inboxes (owner, 2026-10-07): <org>.<agent>@<hub>, mail from members admitted and stored
// for the agent, and a wake in the inbox it already waits on. Hub addresses never belong to a person.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleEmail } from "../src/mail/inbound";
import { handleProjectMail } from "../src/mail/projectMail";
import fixtures from "./fixtures/dkim.json";
import { admitGoogle } from "../src/auth/googleAdmit";
import { apiPost, bearer, cookieHeaders, seedAgent, seedHuman, seedTenant } from "./helpers";
import migration from "../migrations/0011_agent_addresses.sql?raw";

const ctx = {} as ExecutionContext;
const HOST = "acme.pimwell.test";

function message(from: string, to: string, subject: string, body: string) {
  const raw = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <m${Math.random().toString(36).slice(2)}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  const bytes = new TextEncoder().encode(raw);
  const calls = { rejects: [] as string[], replies: 0 };
  const m = {
    from, to, headers: new Headers({ "message-id": "<m1@example.com>", subject }), rawSize: bytes.length,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject(reason: string) { calls.rejects.push(reason); }, async forward() { throw new Error("not used"); },
    async reply() { calls.replies++; return { messageId: "<r@x>" }; },
  };
  return { m: m as unknown as ForwardableEmailMessage, calls };
}

async function world() {
  const t = await seedTenant("acme");
  const pat = await seedHuman("member@example.com", { memberships: [{ tenant_id: t.id, role: "member" }] });
  const scout = await seedAgent(t, pat.identity, "scout");
  return { t, pat, scout };
}

describe("agent mail", () => {
  it("gives agents <org>.<agent>@<hub> addresses", async () => {
    const w = await world();
    expect(w.scout.agent.identity.email).toBe("acme.scout@pimwell.test");
    expect(w.scout.agent.slug).toBe("scout");
  });

  it("stores a member's mail for the agent and wakes its inbox", async () => {
    const w = await world();
    const { m, calls } = message("member@example.com", "acme.scout@pimwell.test", "Signed fixture", "Original body.");
    const bytes = new TextEncoder().encode(fixtures.valid);
    Object.defineProperty(m, "raw", { value: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) });
    expect(await handleProjectMail(m, env, Date.parse(fixtures.now) + 120_000, async () => [[fixtures.record]])).toBe("admitted");
    expect(calls.rejects).toEqual([]);
    expect(calls.replies).toBe(0);
    const row = await env.HUB_DB.prepare("SELECT verdict, recipient_id, project_id FROM inbound_mail").first();
    expect(row).toEqual({ verdict: "admitted", recipient_id: w.scout.agent.identity.id, project_id: null });
    const inbox = await (await apiPost(HOST, "chat.inbox", {}, bearer(w.scout.token))).json() as { result: { text: string; items: Array<{ kind: string }> } };
    expect(inbox.result.items.map((i) => i.kind)).toEqual(["mail"]);
    expect(inbox.result.text).toContain("read it with mail_read");
    const mine = await (await apiPost(HOST, "mail.list", { mine: true }, bearer(w.scout.token))).json() as { result: { mail: Array<{ subject: string }> } };
    expect(mine.result.mail.map((x) => x.subject)).toEqual(["Signed fixture"]);
    const patMine = await (await apiPost(HOST, "mail.list", { mine: true }, cookieHeaders(w.pat.token, HOST))).json() as { result: { mail: unknown[] } };
    expect(patMine.result.mail).toEqual([]);
  });

  it("rejects strangers and unknown agents", async () => {
    await world();
    const a = message("stranger@example.com", "acme.scout@pimwell.test", "hi", "x");
    await handleEmail(a.m, env, ctx);
    expect(a.calls.rejects.length).toBe(1);
    const b = message("pat@example.com", "acme.nobody@pimwell.test", "hi", "x");
    await handleEmail(b.m, env, ctx);
    expect(b.calls.rejects).toEqual(["Unknown recipient"]);
  });

  it("never lets a person sign in with Google at a hub address", async () => {
    await world();
    const r = await admitGoogle(env.HUB_DB, { sub: "g1", email: "acme.scout@pimwell.test", email_verified: true, name: "Fake" } as never, Date.now(), env.HUB_DOMAIN);
    expect(r).toEqual({ ok: false, reason: "unavailable" });
  });

  it("moves old addresses to the new form, once", async () => {
    const w = await world();
    await env.HUB_DB.prepare("UPDATE identity SET email = 'scout@acme.pimwell.test' WHERE id = ?").bind(w.scout.agent.identity.id).run();
    const update = migration.slice(migration.indexOf("UPDATE identity"), migration.indexOf(";", migration.indexOf("UPDATE identity")) + 1);
    await env.HUB_DB.prepare(update).run();
    await env.HUB_DB.prepare(update).run();
    expect((await env.HUB_DB.prepare("SELECT email FROM identity WHERE id = ?").bind(w.scout.agent.identity.id).first<{ email: string }>())!.email).toBe("acme.scout@pimwell.test");
    expect((await env.HUB_DB.prepare("SELECT email FROM identity WHERE id = ?").bind(w.pat.identity.id).first<{ email: string }>())!.email).toBe("member@example.com");
  });
});
