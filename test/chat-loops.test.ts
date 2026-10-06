import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboxStub } from "../src/chat/stubs";
import { seedAgent } from "./helpers";
import { call, channelWith, chatWorld, ok, type World } from "./chat-helpers";

const inboxOf = async (w: World, id: string) => (await inboxStub(env, w.acme.id, id).list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).items;

describe("loop limits end to end", () => {
  it("stops waking agents at hop 3 and records the suppression", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const m0 = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout can you check this?" });
    const m1 = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy please verify", after: m0.head, reply_to: m0.seq });
    const m2 = await ok(w.tidy.token, "chat.post", { c: "general", body: "@scout verified, over to you", after: m1.head, reply_to: m1.seq });
    const m3 = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy thanks, one more?", after: m2.head, reply_to: m2.seq });
    expect([m0.hop, m1.hop, m2.hop, m3.hop]).toEqual([0, 1, 2, 3]);
    expect((await inboxOf(w, w.tidy.agent.identity.id)).map((i) => i.seq)).toEqual([2]);
    const ev = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'chat.wake_suppressed'").all<{ summary: string }>();
    expect(ev.results.map((e) => e.summary)).toEqual(["1 wakes suppressed at hop 3 in #general"]);
  });

  it("acking agents are still stopped by the pair breaker", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const turns = [{ agent: w.scout, other: "tidy" }, { agent: w.tidy, other: "scout" }];
    let head = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let last: any = null;
    for (let i = 0; i < 6; i++) {
      const { agent, other } = turns[i % 2]!;
      const id = agent.agent.identity.id;
      const box = inboxStub(env, w.acme.id, id);
      // Acking first means no open wake is the cause, so every post has hop 1 and the hop limit never fires.
      await box.ack(w.acme.id, id, (await box.head(w.acme.id, id)), Date.now());
      last = await ok(agent.token, "chat.post", { c: "general", body: `@${other} turn ${i}`, after: head });
      head = last.head;
      expect(last.hop).toBe(1);
    }
    expect(last.woke).toBe(0);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'chat.loop_tripped'").first<{ n: number }>())!.n).toBe(1);
    expect((await inboxOf(w, w.lead.identity.id)).map((i) => i.kind)).toEqual(["loop_tripped"]);
    expect((await inboxOf(w, w.dev.identity.id)).map((i) => i.kind)).toEqual(["loop_tripped"]);
    expect((await inboxOf(w, w.scout.agent.identity.id)).filter((i) => i.wake).map((i) => i.seq)).toEqual([2, 4]);
    expect((await ok(w.tidy.token, "chat.post", { c: "general", body: "@scout still there?", after: head })).woke).toBe(0);
  });

  it("pauses agent-only runs at 8 messages until a human posts", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const nib = await seedAgent(w.acme, w.lead.identity, "nib");
    await ok(w.lead.token, "channel.add_agent", { c: "general", agent: "nib" });
    const turn = [w.scout, w.tidy, nib];
    let head = 0;
    for (let i = 0; i < 8; i++) head = (await ok(turn[i % 3]!.token, "chat.post", { c: "general", body: `step ${i}`, after: head })).head;
    const r = await call(nib.token, "chat.post", { c: "general", body: "step 8", after: head });
    expect([r.status, r.body.error]).toEqual([409, "needs_human"]);
    const human = await ok(w.lead.token, "chat.post", { c: "general", body: "carry on" });
    expect((await ok(nib.token, "chat.post", { c: "general", body: "step 8", after: human.head })).seq).toBeGreaterThan(human.seq);
  });

  it("mutes an agent after more than 20 refused posts in an hour and tells its operator", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const head = (await ok(w.scout.token, "chat.post", { c: "general", body: "same", after: 0 })).head;
    for (let i = 0; i < 21; i++) expect([409, 429]).toContain((await call(w.scout.token, "chat.post", { c: "general", body: "same", after: head })).status);
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "new", after: head })).body.error).toBe("muted");
    expect((await inboxOf(w, w.lead.identity.id)).map((i) => i.kind)).toEqual(["tripwire"]);
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'chat.tripwire'").first<{ n: number }>())!.n).toBe(1);
  });

  it("never wakes an agent removed from the channel through an old thread subscription", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@tidy look" });
    await ok(w.dev.token, "channel.remove_agent", { c: "general", agent: "tidy" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "anyone?", reply_to: root.seq });
    expect((await inboxOf(w, w.tidy.agent.identity.id)).map((i) => i.seq)).toEqual([1]);
  });
});
