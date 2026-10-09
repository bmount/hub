import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboxStub } from "../src/chat/stubs";
import { call, channelWith, chatWorld, ok, until } from "./chat-helpers";

const OID = "3f9a2c1" + "0".repeat(33);

describe("reading a channel", () => {
  it("pages the newest messages, back with before, forward with after; author and body in separate keys", async () => {
    const w = await chatWorld();
    await channelWith(w);
    for (let i = 1; i <= 5; i++) await ok(w.lead.token, "chat.post", { c: "general", body: `m${i}` });
    const page = await ok(w.scout.token, "chat.read", { c: "general", limit: 3 });
    expect(page.messages.map((m: { seq: number }) => m.seq)).toEqual([3, 4, 5]);
    expect([page.head, page.next_before, page.next_after]).toEqual([5, 3, null]);
    expect(page.messages[0].author).toEqual({ identity_id: w.lead.identity.id, handle: "lead", display_name: "lead", kind: "human", operator: null, session_id: w.lead.session.id, run: null, via_assistant: false });
    expect(page.messages[0].body).toBe("m3");
    expect(page.text).toContain("older: pass before=3");
    const older = await ok(w.scout.token, "chat.read", { c: "general", before: 3 });
    expect([older.messages.map((m: { seq: number }) => m.seq), older.next_before]).toEqual([[1, 2], null]);
    const newer = await ok(w.scout.token, "chat.read", { c: "general", after: 3 });
    expect([newer.messages.map((m: { seq: number }) => m.seq), newer.next_after]).toEqual([[4, 5], null]);
  });

  it("shows a thread whole, the requested message in full and the others cut", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "root" });
    const long = "x".repeat(700);
    const r1 = await ok(w.dev.token, "chat.post", { c: "general", body: long, reply_to: root.seq });
    await ok(w.lead.token, "chat.post", { c: "general", body: "second", reply_to: root.seq });
    const t = await ok(w.scout.token, "chat.thread", { c: "general", msg: r1.seq });
    expect(t.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
    expect(t.text).toContain(long);
    const top = await ok(w.scout.token, "chat.thread", { c: "general", msg: "#1" });
    expect(top.text).not.toContain(long);
    expect(top.text).toContain("(+100 chars, chat.thread c=general msg=2)");
    expect((await call(w.scout.token, "chat.thread", { c: "general", msg: 99 })).status).toBe(404);
    const flat = await ok(w.scout.token, "chat.read", { c: "general" });
    expect(flat.messages.map((m: { seq: number; reply_count: number }) => [m.seq, m.reply_count])).toEqual([[1, 2]]);
  });

  it("lists every version of a message", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: "first" });
    await ok(w.dev.token, "chat.edit", { c: "general", msg: 1, body: "second" });
    const h = await ok(w.lead.token, "chat.history", { c: "general", msg: 1 });
    expect(h.versions.map((v: { rev: number; body: string }) => [v.rev, v.body])).toEqual([[1, "first"], [2, "second"]]);
    expect(h.text.split("\n").filter((l: string) => l.startsWith("[#"))).toHaveLength(2);
  });
});

describe("the inbox", () => {
  it("lists open items without message text, acks them, and long-polls", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout secret plans" });
    const box = await ok(w.scout.token, "chat.inbox");
    expect(box.items.map((i: { kind: string; channel: string; seq: number; author: string; wake: boolean }) => [i.kind, i.channel, i.seq, i.author, i.wake])).toEqual([["mention", "general", 1, "lead", true]]);
    expect(box.text).toMatch(/\[#general #1 \d\d:\d\d mention by @lead hop0 wake item=1\]/);
    expect(box.text).not.toContain("secret plans");
    expect((await ok(w.scout.token, "inbox.ack", { through: box.head })).acked).toBe(1);
    expect((await ok(w.scout.token, "chat.inbox")).items).toEqual([]);
    const t0 = Date.now();
    expect((await ok(w.scout.token, "inbox.wait", { after: box.head, wait_s: 1 })).items).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    const waiting = call(w.scout.token, "inbox.wait", { after: box.head, wait_s: 10 });
    // Post only once the poll is parked, so the wake (not an immediate read) is what answers it.
    const sid = w.scout.agent.identity.id;
    await until(async () => (await inboxStub(env, w.acme.id, sid).waiting(w.acme.id, sid)) === 1, "the long poll to park");
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout again" });
    const got = await waiting;
    expect(got.body.result.items.map((i: { seq: number }) => i.seq)).toEqual([2]);
  });

  it("keeps a read cursor per channel, shown by chat.conversations", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "one" });
    expect((await ok(w.scout.token, "chat.mark_read", { c: "general", seq: 1 })).read_seq).toBe(1);
    expect((await ok(w.scout.token, "chat.conversations")).conversations[0]).toMatchObject({ channel: "general", head: 1, read_seq: 1 });
  });

  it("stops showing a channel to an agent removed from it: reads, inbox, backlinks", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "@tidy see site#k7q2" });
    expect((await ok(w.tidy.token, "chat.inbox")).items).toHaveLength(1);
    await ok(w.dev.token, "channel.remove_agent", { c: "general", agent: "tidy" });
    expect((await call(w.tidy.token, "chat.read", { c: "general" })).status).toBe(404);
    expect((await ok(w.tidy.token, "chat.inbox")).items).toEqual([]);
    expect((await ok(w.tidy.token, "ref.backlinks", { kind: "ticket", key: "site#k7q2" })).items).toEqual([]);
  });
});

describe("backlinks", () => {
  it("find where a ticket, a commit, or a message was discussed, filtered to what the caller can read", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.lead.token, "channel.create", { slug: "ops" });
    await ok(w.lead.token, "chat.post", { c: "general", body: `fixed in site@${OID}, see site#k7q2` });
    await ok(w.dev.token, "chat.post", { c: "ops", body: "ops on site#k7q2" });
    const forLead = await ok(w.lead.token, "ref.backlinks", { kind: "ticket", key: "site#k7q2" });
    expect(forLead.items.map((i: { channel: string }) => i.channel).sort()).toEqual(["general", "ops"]);
    const forScout = await ok(w.scout.token, "ref.backlinks", { kind: "ticket", key: "site#k7q2" });
    expect(forScout.items.map((i: { channel: string; seq: number; author: string }) => [i.channel, i.seq, i.author])).toEqual([["general", 1, "lead"]]);
    expect(forScout.text).toMatch(/^\[#general #1 \d\d:\d\d @lead\]$/m);
    expect((await ok(w.scout.token, "ref.backlinks", { kind: "commit", key: "site@3f9a2c1" })).items).toHaveLength(1);
    await ok(w.dev.token, "chat.post", { c: "general", body: "see msg:general/1" });
    expect((await ok(w.lead.token, "ref.backlinks", { kind: "msg", key: "general/1" })).items.map((i: { seq: number }) => i.seq)).toEqual([2]);
    expect((await ok(w.lead.token, "ref.backlinks", { kind: "ticket", key: "bad key" })).target).toBeNull();
    await ok(w.lead.token, "chat.retract", { c: "general", msg: 1 });
    expect((await ok(w.lead.token, "ref.backlinks", { kind: "ticket", key: "site#k7q2" })).items.map((i: { channel: string }) => i.channel)).toEqual(["ops"]);
  });
});
