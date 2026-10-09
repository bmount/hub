import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/mail-ingress.json";
import { seedAgent, seedHuman, seedTenant } from "./helpers";
import { handleProjectMail } from "../src/mail/projectMail";
import { handleEmail } from "../src/mail/inbound";
import { createProject } from "../src/db/projects";
import { grantConsent, revokeConsent } from "../src/db/consent";
import { inboxStub } from "../src/chat/stubs";
import * as stubs from "../src/chat/stubs";
import { REPLAY_PREFIX } from "../src/mail/replay";
import { WELCOME_PREFIX } from "../src/mail/welcome";
import * as delivery from "../src/mail/send";
import type { Env } from "../src/env";

const now = Date.parse(fixtures.now) + 120_000;
const from = "member@example.com", to = "ingress@pimwell.test";
function message(raw = fixtures.first, address = to, sender = from) {
  const bytes = new TextEncoder().encode(raw);
  // Deliberately untrusted transport Message-ID; admission/threading use signed bytes.
  const m = { from: sender, to: address, headers: new Headers({ "message-id": "<forged@transport.example>" }), rawSize: bytes.length,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject: vi.fn(), reply: vi.fn(async () => { throw new Error("reply unavailable; secret diagnostic"); }),
    forward: vi.fn() };
  return m as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}
const lookup = async () => [[fixtures.record]];
const receive = (raw = fixtures.first, address = to, sender = from, e: Env = env, time = now) => handleProjectMail(message(raw, address, sender), e, time, lookup);
const count = async (table: string) => env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n");
async function world() {
  const tenant = await seedTenant("ingress");
  const human = await seedHuman(from, { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const bot = await seedAgent(tenant, human.identity, "helper");
  await createProject(env.HUB_DB, { tenant_id: tenant.id, namespace_id: null, slug: "site", kind: "repo", display_name: "Site" }, now);
  const sent: delivery.SentMail[] = [];
  delivery.setTestTransport(async (m) => { sent.push(m); });
  return { tenant, human, bot, sent };
}
const welcome = async () => {
  const value = await env.HUB_DB.prepare("SELECT value FROM meta WHERE key GLOB ?").bind(WELCOME_PREFIX + "*").first<string>("value");
  return value ? JSON.parse(value) : null;
};
const inbox = (w: Awaited<ReturnType<typeof world>>) => inboxStub(env, w.tenant.id, w.bot.agent.identity.id);
const page = (w: Awaited<ReturnType<typeof world>>) => inbox(w).list(w.tenant.id, w.bot.agent.identity.id, { after: 0, limit: 100, include_acked: true });
afterEach(() => { delivery.setTestTransport(null); vi.restoreAllMocks(); });

describe("receipt-free independently authenticated ingress", () => {
  it("admits first and subsequent signed mail, sends guidance once and never replies with Received", async () => {
    const w = await world();
    expect(await receive()).toBe("admitted");
    expect(await receive(fixtures.second)).toBe("admitted");
    expect(await count("inbound_mail")).toBe(2);
    expect(await count("event")).toBe(2);
    expect(await count("consent")).toBe(1);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ subject: "Welcome to Pimwell", from: to });
    expect(w.sent[0]!.raw).toContain("In-Reply-To: <first@example.com>");
    expect(await welcome()).toMatchObject({ status: "sent" });
  });

  it("deduplicates concurrent different messages across project and agent mailboxes", async () => {
    const w = await world();
    const address = w.bot.agent.identity.email;
    expect(await Promise.all([receive(fixtures.first, address), receive(fixtures.second, "ingress.site@pimwell.test"), receive(fixtures.third)]))
      .toEqual(["admitted", "admitted", "admitted"]);
    expect(await count("inbound_mail")).toBe(3);
    expect(await count("consent")).toBe(1);
    expect(await count("event")).toBe(3);
    expect(w.sent).toHaveLength(1);
    expect((await page(w)).items).toHaveLength(1);
  });

  it("deduplicates concurrent identical arrivals, audit, welcome and agent wake", async () => {
    const w = await world();
    expect(await Promise.all(Array.from({ length: 3 }, () => receive(fixtures.first, w.bot.agent.identity.email))))
      .toEqual(["admitted", "admitted", "admitted"]);
    expect(await count("inbound_mail")).toBe(1);
    expect(await count("event")).toBe(1);
    expect(w.sent).toHaveLength(1);
    expect((await page(w)).items).toHaveLength(1);
  });

  it.each(["transport", "unexpected_welcome", "consent_storage", "no_consent"]) ("optional %s failure never quarantines proof or loses wake", async (failure) => {
    const w = await world();
    if (failure === "transport") delivery.setTestTransport(async () => { throw new Error("secret transport diagnostic"); });
    if (failure === "unexpected_welcome") vi.spyOn(delivery, "sendMail").mockRejectedValue(new Error("secret credential"));
    if (failure === "no_consent") vi.spyOn(delivery, "sendMail").mockResolvedValue("no_consent");
    if (failure === "consent_storage") await env.HUB_DB.exec("CREATE TRIGGER fail_optional BEFORE INSERT ON consent BEGIN SELECT RAISE(ABORT, 'secret consent diagnostic'); END");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await receive(fixtures.first, w.bot.agent.identity.email)).toBe("admitted");
    expect((await page(w)).items).toHaveLength(1);
    expect(await env.HUB_DB.prepare("SELECT verdict, reason FROM inbound_mail").first()).toEqual({ verdict: "admitted", reason: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    if (failure === "consent_storage") expect(await welcome()).toBeNull();
    else expect(await welcome()).toMatchObject({ status: failure === "transport" ? "failed" : failure === "no_consent" ? "no_consent" : "pending" });
    if (failure === "consent_storage") await env.HUB_DB.exec("DROP TRIGGER fail_optional");
  });

  it("never retries an ambiguous or failed welcome on another incoming message", async () => {
    const w = await world();
    const send = vi.spyOn(delivery, "sendMail").mockRejectedValue(new Error("ambiguous delivery"));
    expect(await receive()).toBe("admitted");
    expect(await receive(fixtures.second)).toBe("admitted");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await welcome()).toMatchObject({ status: "pending" });
    expect(w.sent).toHaveLength(0);
  });

  it("admits independently proven withdrawn users without restoring any consent or sending welcome", async () => {
    const w = await world();
    await grantConsent(env.HUB_DB, { email: from, kind: "inbound_email", source_message_id: null, evidence: null }, now - 100);
    await revokeConsent(env.HUB_DB, from, now - 50);
    expect(await receive(fixtures.first, w.bot.agent.identity.email)).toBe("admitted");
    expect((await page(w)).items).toHaveLength(1);
    expect(await count("consent")).toBe(1);
    expect(await env.HUB_DB.prepare("SELECT revoked_at FROM consent").first("revoked_at")).toBe(now - 50);
    expect(w.sent).toHaveLength(0);
    expect(await welcome()).toBeNull();
  });

  it("an atomic first-consent grant cannot race past a withdrawal", async () => {
    const w = await world();
    const db = env.HUB_DB;
    let raced = false;
    const e = { ...env, HUB_DB: new Proxy(db, { get(target, prop) {
      if (prop === "prepare") return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.startsWith("INSERT INTO consent")) return stmt;
        return { bind: (...args: unknown[]) => ({ run: async () => {
          if (!raced) {
            raced = true;
            await grantConsent(db, { email: from, kind: "inbound_email", source_message_id: null, evidence: null }, now - 2);
            await revokeConsent(db, from, now - 1);
          }
          return stmt.bind(...args).run();
        } }) };
      };
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } }) } as Env;
    expect(await receive(fixtures.first, to, from, e)).toBe("admitted");
    expect(await count("consent")).toBe(1);
    expect(w.sent).toHaveLength(0);
  });

  it("reconciles a committed storage transaction with a lost response", async () => {
    const w = await world(), db = env.HUB_DB;
    const e = { ...env, HUB_DB: new Proxy(db, { get(target, prop) {
      if (prop === "batch") return async (statements: D1PreparedStatement[]) => { await target.batch(statements); throw new Error("response lost"); };
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    await expect(receive(fixtures.first, w.bot.agent.identity.email, from, e)).rejects.toThrow("response lost");
    expect((await page(w)).items).toHaveLength(0);
    expect(await receive(fixtures.first, w.bot.agent.identity.email)).toBe("admitted");
    expect((await page(w)).items).toHaveLength(1);
    expect(await count("event")).toBe(1);
    expect(w.sent).toHaveLength(1);
  });

  it("reconciles a committed agent delivery whose response was lost, without re-waking", async () => {
    const w = await world();
    const box = inbox(w);
    const deliver = vi.spyOn(stubs, "inboxStub").mockReturnValue(new Proxy(box, { get(target, prop) {
      if (prop === "deliver") return async (...args: Parameters<typeof box.deliver>) => { await target.deliver(...args); throw new Error("wake response lost"); };
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } }));
    await expect(receive(fixtures.first, w.bot.agent.identity.email)).rejects.toThrow("wake response lost");
    deliver.mockRestore();
    expect((await page(w)).items).toHaveLength(1);
    expect(w.sent).toHaveLength(0);
    expect(await receive(fixtures.first, w.bot.agent.identity.email)).toBe("admitted");
    expect((await page(w)).items).toHaveLength(1);
    expect(await count("event")).toBe(1);
    expect(w.sent).toHaveLength(1);
  });

  it("keeps unknown proof admin-only with no consent, notification or wake", async () => {
    const w = await world();
    const m = message("Authentication-Results: forged; dkim=pass; dmarc=pass\r\n" + fixtures.first.replace("Original body.", "Tampered body."), w.bot.agent.identity.email);
    expect(await handleProjectMail(m, env, now, lookup)).toBe("quarantined");
    expect(m.reply).not.toHaveBeenCalled();
    expect(await count("consent")).toBe(0);
    expect(w.sent).toHaveLength(0);
    expect((await page(w)).items).toHaveLength(0);
    expect(await env.HUB_DB.prepare("SELECT verdict, reason FROM inbound_mail").first()).toMatchObject({ verdict: "quarantined", reason: expect.stringContaining("authentication unknown") });
  });

  it("does not replay any effects for byte collision or legacy admitted evidence", async () => {
    const w = await world();
    expect(await receive(fixtures.first, w.bot.agent.identity.email)).toBe("admitted");
    expect(await receive("Received: from another-hop.example\r\n" + fixtures.first, w.bot.agent.identity.email)).toBe("rejected");
    await env.HUB_DB.prepare("DELETE FROM meta WHERE key GLOB ?").bind(REPLAY_PREFIX + "*").run();
    expect(await receive(fixtures.first, w.bot.agent.identity.email)).toBe("rejected");
    expect(await count("inbound_mail")).toBe(1);
    expect(await count("event")).toBe(1);
    expect((await page(w)).items).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it("isolates human and tenant welcome state while preserving exact destination mailboxes", async () => {
    const w = await world();
    const other = await seedTenant("otheringress");
    await seedHuman("other@example.com", { memberships: [{ tenant_id: w.tenant.id, role: "member" }] });
    await env.HUB_DB.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(w.human.identity.id).run();
    expect(await receive()).toBe("admitted");
    expect(await receive(fixtures.first, "otheringress@pimwell.test")).toBe("admitted");
    expect(await receive(fixtures.other, to, "other@example.com")).toBe("admitted");
    expect(w.sent).toHaveLength(3);
    expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM inbound_mail WHERE tenant_id = ?").bind(other.id).first("n")).toBe(1);
  });

  it("authenticates only outer forwarded sender and stores inner contents as evidence", async () => {
    const w = await world();
    expect(await receive(fixtures.forwarded)).toBe("admitted");
    expect(await env.HUB_DB.prepare("SELECT identity_id, forwarded, text FROM inbound_mail").first())
      .toMatchObject({ identity_id: w.human.identity.id, forwarded: 1, text: expect.stringContaining("stranger@example.com") });
  });

  it("production email entry point uses bounded trusted DoH, not reply or transport auth headers", async () => {
    const w = await world();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = new URL(String(url));
      expect(u.origin).toBe("https://cloudflare-dns.com");
      const name = u.searchParams.get("name");
      return new Response(JSON.stringify({ Status: 0, Question: [{ name, type: 16 }], Answer: [{ name, type: 16, data: `"${fixtures.record}"` }] }), { headers: { "content-type": "application/dns-json" } });
    });
    const m = message(fixtures.first, w.bot.agent.identity.email);
    await handleEmail(m, env, {} as ExecutionContext);
    expect(fetcher).toHaveBeenCalled();
    expect(m.reply).not.toHaveBeenCalled();
    expect((await page(w)).items).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });
});
