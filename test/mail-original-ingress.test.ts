import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/mail-ingress.json";
import { seedAgent, seedHuman, seedTenant } from "./helpers";
import { handleEmail } from "../src/mail/inbound";
import { handleProjectMail } from "../src/mail/projectMail";
import { MAX_RAW_MAIL_READ_MS } from "../src/mail/raw";
import { REPLAY_PREFIX } from "../src/mail/replay";
import { WELCOME_PREFIX } from "../src/mail/welcome";
import { inboxStub } from "../src/chat/stubs";
import * as delivery from "../src/mail/send";

const now = Date.parse(fixtures.now) + 120_000;
afterEach(() => { delivery.setTestTransport(null); vi.useRealTimers(); vi.restoreAllMocks(); });
async function world() {
  const tenant = await seedTenant("deadline");
  const human = await seedHuman("member@example.com", { memberships: [{ tenant_id: tenant.id, role: "member" }] });
  const bot = await seedAgent(tenant, human.identity, "helper");
  const sent: delivery.SentMail[] = [];
  delivery.setTestTransport(async m => { sent.push(m); });
  return { tenant, bot, sent };
}
function message(raw: ReadableStream<Uint8Array>, to: string) {
  return { from: "member@example.com", to, rawSize: 1, raw, headers: new Headers(),
    setReject: vi.fn(), reply: vi.fn(), forward: vi.fn() } as unknown as
    ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}
async function noEffects(w: Awaited<ReturnType<typeof world>>) {
  for (const table of ["inbound_mail", "consent", "event"]) {
    expect(await env.HUB_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n")).toBe(0);
  }
  expect(await env.HUB_DB.prepare("SELECT key FROM meta WHERE key GLOB ? OR key GLOB ?")
    .bind(REPLAY_PREFIX + "*", WELCOME_PREFIX + "*").first()).toBeNull();
  const page = await inboxStub(env, w.tenant.id, w.bot.agent.identity.id).list(w.tenant.id, w.bot.agent.identity.id,
    { after: 0, limit: 100, include_acked: true });
  expect(page.items).toHaveLength(0);
  expect(w.sent).toHaveLength(0);
}

describe("production original-mail read refusal", () => {
  it.each(["empty", "partial", "signed"])("rejects stalled %s evidence before DNS or any mail effects", async kind => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetcher = vi.spyOn(globalThis, "fetch");
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let observed!: () => void;
    const started = new Promise<void>(resolve => { observed = resolve; });
    let pulled = false;
    const raw = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull(c) {
      if (!pulled) {
        pulled = true;
        if (kind !== "empty") c.enqueue(new TextEncoder().encode(kind === "signed" ? fixtures.first : "From: member@example.com\r\n"));
        observed();
      }
    }, cancel }, { highWaterMark: 0 });
    const m = message(raw, w.bot.agent.identity.email);
    let complete = false;
    const result = handleEmail(m, env, {} as ExecutionContext).then(() => { complete = true; });
    await started;
    await vi.advanceTimersByTimeAsync(MAX_RAW_MAIL_READ_MS - 1);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(m.setReject).toHaveBeenCalledExactlyOnceWith("Message too large or unreadable");
    expect(m.reply).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(raw.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await noEffects(w);
    // A late provider completion cannot re-enter parsing/verification or wake.
    expect(() => controller.enqueue(new TextEncoder().encode(fixtures.first))).toThrow();
    expect(() => controller.close()).toThrow();
    await vi.advanceTimersByTimeAsync(MAX_RAW_MAIL_READ_MS);
    await noEffects(w);
    if (kind === "signed") {
      // Read failure created no permanent replay state. An independently verified
      // complete redelivery can still admit and wake exactly once, without reply.
      const completeMessage = () => message(new ReadableStream<Uint8Array>({ start(c) {
        c.enqueue(new TextEncoder().encode(fixtures.first)); c.close();
      } }), w.bot.agent.identity.email);
      for (let i = 0; i < 2; i++) {
        const retry = completeMessage();
        expect(await handleProjectMail(retry, env, now, async () => [[fixtures.record]])).toBe("admitted");
        expect(retry.reply).not.toHaveBeenCalled();
        expect(retry.setReject).not.toHaveBeenCalled();
        expect(retry.raw.locked).toBe(false);
      }
      expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM inbound_mail WHERE verdict = 'admitted'").first<number>("n")).toBe(1);
      expect(await env.HUB_DB.prepare("SELECT COUNT(*) n FROM consent").first<number>("n")).toBe(1);
      const page = await inboxStub(env, w.tenant.id, w.bot.agent.identity.id).list(w.tenant.id, w.bot.agent.identity.id,
        { after: 0, limit: 100, include_acked: true });
      expect(page.items).toHaveLength(1);
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]!.subject).toBe("Welcome to Pimwell");
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("rejects a late signed completion before a delayed timer can run", async () => {
    const w = await world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const resolver = vi.fn(async () => [[fixtures.record]]);
    const cancel = vi.fn();
    let delivered = false;
    const raw = new ReadableStream<Uint8Array>({ pull(c) {
      if (delivered) { c.close(); return; }
      delivered = true;
      clock = MAX_RAW_MAIL_READ_MS;
      c.enqueue(new TextEncoder().encode(fixtures.first));
    }, cancel }, { highWaterMark: 0 });
    const m = message(raw, w.bot.agent.identity.email);
    expect(await handleProjectMail(m, env, now, resolver)).toBe("rejected");
    expect(m.setReject).toHaveBeenCalledExactlyOnceWith("Message too large or unreadable");
    expect(resolver).not.toHaveBeenCalled();
    expect(m.reply).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(raw.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await noEffects(w);
  });

  it("does not leak a source error into the SMTP rejection or create partial quarantine", async () => {
    const w = await world();
    const raw = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("private diagnostic with user content")); } });
    const resolver = vi.fn(async () => [[fixtures.record]]);
    const m = message(raw, w.bot.agent.identity.email);
    expect(await handleProjectMail(m, env, now, resolver)).toBe("rejected");
    expect(m.setReject).toHaveBeenCalledExactlyOnceWith("Message too large or unreadable");
    expect(resolver).not.toHaveBeenCalled();
    expect(m.reply).not.toHaveBeenCalled();
    expect(raw.locked).toBe(false);
    await noEffects(w);
  });
});
