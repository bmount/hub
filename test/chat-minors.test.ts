import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { internalBacklinks } from "../src/http/internalBacklinks";
import { seedAgent, seedHuman } from "./helpers";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";


const SECRET = "test-internal-secret";
const req = (body: unknown) =>
  new Request("https://hub.internal/internal/backlinks", { method: "POST", headers: { "content-type": "application/json", "x-hub-internal": SECRET }, body: JSON.stringify(body) });

describe("batch C minors", () => {
  it("counts an agent's edits and retractions against its per-session rate window", async () => {
    const w = await chatWorld();
    await channelWith(w);
    let head = 0;
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ok(w.scout.token, "chat.post", { c: "general", body: `post ${i}`, after: head });
      head = r.head;
      seqs.push(r.seq);
    }
    for (let i = 0; i < 3; i++) head = (await ok(w.scout.token, "chat.edit", { c: "general", msg: seqs[i], body: `edit ${i}`, after: head })).head;
    const edit = await call(w.scout.token, "chat.edit", { c: "general", msg: seqs[0], body: "one more", after: head });
    expect([edit.status, edit.body.error]).toEqual([429, "rate"]);
    // Ruling C-8: a retraction is exempt from the window, and from the tripwire.
    const retract = await call(w.scout.token, "chat.retract", { c: "general", msg: seqs[1] });
    expect([retract.status, retract.body.error]).toEqual([200, undefined]);
    expect((await call(w.scout.token, "chat.retract", { c: "general", msg: seqs[2] })).status).toBe(200);
    // A human's edits are not held to the agent window.
    const mine = await ok(w.lead.token, "chat.post", { c: "general", body: "human" });
    for (let i = 0; i < 8; i++) await ok(w.lead.token, "chat.edit", { c: "general", msg: mine.seq, body: `human ${i}` });
  }, 30_000);

  it("rejects malformed refs and too many refs before reading the channel", async () => {
    const w = await chatWorld();
    const many = Array.from({ length: 21 }, (_, i) => `site#k7q${i}`).join(" ");
    // The channel does not exist: a structural error still wins, because it needs no lookup.
    expect((await call(w.lead.token, "chat.post", { c: "nope", body: many })).status).toBe(400);
    expect((await call(w.lead.token, "chat.post", { c: "nope", body: "x", refs: [{ kind: "ticket", key: "not a ref" }] })).status).toBe(400);
    expect((await call(w.lead.token, "chat.post", { c: "nope", body: "fine" })).status).toBe(404);
  });

  it("caps only agent mentions at 10; a human's inbox item is never dropped", async () => {
    const w = await chatWorld();
    await ok(w.lead.token, "channel.create", { slug: "general" });
    const extra = await seedHuman("extra@example.com", { memberships: [{ tenant_id: w.acme.id, role: "member" }] });
    const names: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `bot${String.fromCharCode(97 + i)}`;
      await seedAgent(w.acme, w.lead.identity, name);
      await ok(w.lead.token, "channel.add_agent", { c: "general", agent: name });
      names.push(name);
    }
    const body = `${names.map((n) => `@${n}`).join(" ")} @dev @extra`;
    const r = await ok(w.lead.token, "chat.post", { c: "general", body });
    // 10 agents plus both humans woke; two agents did not.
    expect([r.woke, r.mentions_not_waking]).toEqual([12, 2]);
    void extra;
  });

  it("logs a failed event write after a committed post and still answers success", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await env.HUB_DB.exec("CREATE TRIGGER fail_chat_events BEFORE INSERT ON event WHEN NEW.kind LIKE 'chat.%' BEGIN SELECT RAISE(ABORT, 'event store down'); END");
    try {
      const r = await call(w.lead.token, "chat.post", { c: "general", body: "still posted" });
      expect(r.status).toBe(200);
      const e = await call(w.lead.token, "chat.edit", { c: "general", msg: r.body.result.seq, body: "still edited" });
      expect(e.status).toBe(200);
    } finally {
      await env.HUB_DB.exec("DROP TRIGGER fail_chat_events");
    }
    const page = await ok(w.lead.token, "chat.read", { c: "general" });
    expect(page.text).toContain("still edited");
  });

  it("backlinks filter unreadable channels in SQL: newer hits elsewhere cannot starve the page", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.lead.token, "channel.create", { slug: "ops" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "visible site#k7q2" });
    for (let i = 0; i < 6; i++) await ok(w.lead.token, "chat.post", { c: "ops", body: `hidden ${i} site#k7q2` });
    const asScout = await (await internalBacklinks(req({ tenant: "acme", principal: w.scout.agent.identity.id, kind: "ticket", key: "site#k7q2", limit: 1 }), env)).json() as { count: number; items: Array<{ channel: string }> };
    expect([asScout.count, asScout.items.map((i) => i.channel)]).toEqual([1, ["general"]]);
  });

  it("/internal/backlinks answers nothing for an agent whose operator is no longer an active member", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.lead.token, "chat.post", { c: "general", body: "see site#k7q2" });
    const ask = async () => (await (await internalBacklinks(req({ tenant: "acme", principal: w.scout.agent.identity.id, kind: "ticket", key: "site#k7q2" }), env)).json()) as { ok: boolean; count?: number };
    expect(await ask()).toMatchObject({ ok: true, count: 1 });
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE identity_id = ? AND tenant_id = ?").bind(w.lead.identity.id, w.acme.id).run();
    expect(await ask()).toEqual({ ok: false });
  });
});
