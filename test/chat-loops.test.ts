import { env } from "cloudflare:test";
import { inDO } from "./do-helper";
import { describe, expect, it } from "vitest";
import type { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug, setAgentMute, setAgentPolicy, setAgentsEnabled } from "../src/db/chat";
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
      // With no recent wake as the cause every post has hop 1, so the hop limit never fires and the pair breaker must.
      await box.ack(w.acme.id, id, (await box.head(w.acme.id, id)), Date.now());
      // And the wake is older than the 10-minute window (ruling C-4), so it no longer counts as the cause.
      await inDO(box, (_o, state) => { state.storage.sql.exec("UPDATE item SET created_at = 0"); });
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

  it("trips again after an unmute: 21 more refusals mute the agent and write a second tripwire event (C-I1)", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const head = (await ok(w.scout.token, "chat.post", { c: "general", body: "same", after: 0 })).head;
    const refuse = async () => { for (let i = 0; i < 21; i++) expect([409, 429]).toContain((await call(w.scout.token, "chat.post", { c: "general", body: "same", after: head })).status); };
    await refuse();
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "new", after: head })).body.error).toBe("muted");
    await ok(w.lead.token, "chat.agent_unmute", { agent: "scout" });
    await refuse();
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "new", after: head })).body.error).toBe("muted");
    expect((await env.HUB_DB.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'chat.tripwire'").first<{ n: number }>())!.n).toBe(2);
    expect((await inboxOf(w, w.lead.identity.id)).map((i) => i.kind)).toEqual(["tripwire", "tripwire"]);
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

describe("loop limits and wakes: fix wave", () => {
  it("agents replying to a human root still reach the hop limit (C-4)", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout @tidy please look" });
    const a = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy on it", after: root.head, reply_to: root.seq });
    // Both reply to the human root, whose own hop is 0: the open wake in the thread carries the chain's hop.
    const b = await ok(w.tidy.token, "chat.post", { c: "general", body: "@scout done here", after: a.head, reply_to: root.seq });
    const c = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy and more", after: b.head, reply_to: root.seq });
    expect([root.hop, a.hop, b.hop, c.hop]).toEqual([0, 1, 2, 3]);
    // Only the human who started the thread is told; tidy is not woken a fourth time.
    expect(c.woke).toBe(1);
    expect((await inboxOf(w, w.tidy.agent.identity.id)).filter((i) => i.wake).map((i) => i.seq)).toEqual([1, 2]);
    const ev = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'chat.wake_suppressed'").all<{ summary: string }>();
    expect(ev.results.map((e) => e.summary)).toEqual(["1 wakes suppressed at hop 3 in #general"]);
  });

  it("acking a wake does not reset the chain: the hop limit is still reached (C-4 gap)", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ackAll = async (id: string) => { const box = inboxStub(env, w.acme.id, id); await box.ack(w.acme.id, id, await box.head(w.acme.id, id), Date.now()); };
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout @tidy please look" });
    await ackAll(w.scout.agent.identity.id);
    const a = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy on it", after: root.head, reply_to: root.seq });
    await ackAll(w.tidy.agent.identity.id);
    const b = await ok(w.tidy.token, "chat.post", { c: "general", body: "@scout done here", after: a.head, reply_to: root.seq });
    await ackAll(w.scout.agent.identity.id);
    const c = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy and more", after: b.head, reply_to: root.seq });
    expect([a.hop, b.hop, c.hop]).toEqual([1, 2, 3]);
    expect((await inboxOf(w, w.tidy.agent.identity.id)).filter((i) => i.wake).map((i) => i.seq)).toEqual([1, 2]);
  });

  it("skips wakes at delivery for a muted agent, the kill switch, and a muted channel; notifications still arrive", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    await conv.head(w.acme.id, ch.project_id);
    const scoutId = w.scout.agent.identity.id;
    const leadId = w.lead.identity.id;
    let n = 0;
    // Queue one wake for scout and one plain notification for lead, as a post that raced a mute would have, then drain.
    const queue = async () => {
      n++;
      const base = { kind: "mention", conversation_id: ch.project_id, seq: n, msg_id: `M${n}`, thread_root: null, hop: 0, author_id: leadId, created_at: Date.now() };
      await inDO(conv, async (o: Conversation, state) => {
        for (const [id, wake] of [[scoutId, true], [leadId, false]] as const) {
          const key = `${ch.project_id}:${n}:${id}`;
          state.storage.sql.exec("INSERT INTO inbox_outbox (key, identity_id, item_json) VALUES (?, ?, ?)", key, id, JSON.stringify({ ...base, key, wake }));
        }
        await o.alarm();
      });
    };
    const got = async (id: string) => (await inboxStub(env, w.acme.id, id).list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).items.map((i) => i.seq);
    const left = () => inDO(conv, (_o, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM inbox_outbox").one().n);

    await queue();
    expect([await got(scoutId), await got(leadId)]).toEqual([[1], [1]]);

    await setAgentMute(env.HUB_DB, w.acme.id, scoutId, Date.now() + 60_000, leadId, "test");
    await queue();
    expect([await got(scoutId), await got(leadId), await left()]).toEqual([[1], [1, 2], 0]);
    await setAgentMute(env.HUB_DB, w.acme.id, scoutId, null, leadId, null);

    await setAgentsEnabled(env.HUB_DB, w.acme.id, false, leadId, "drill", Date.now());
    await queue();
    expect([await got(scoutId), await got(leadId), await left()]).toEqual([[1], [1, 2, 3], 0]);
    await setAgentsEnabled(env.HUB_DB, w.acme.id, true, leadId, null, Date.now());

    await setAgentPolicy(env.HUB_DB, w.acme.id, ch.project_id, "muted");
    await queue();
    expect([await got(scoutId), await got(leadId), await left()]).toEqual([[1], [1, 2, 3, 4], 0]);

    await setAgentPolicy(env.HUB_DB, w.acme.id, ch.project_id, "open");
    await queue();
    expect(await got(scoutId)).toEqual([1, 5]);
  });
});
