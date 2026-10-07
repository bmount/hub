import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Conversation } from "../src/chat/conversationDO";
import type { Inbox } from "../src/chat/inboxDO";
import { decodeCursors, encodeCursors } from "../src/chat/catchup";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import type { Author, PostInput, PostOk, PostOutcome, VersionInput } from "../src/chat/types";
import { getChannelBySlug, setAgentPolicy } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";

// Messaging phase 1 final fix wave.

const T = "T9";
const C = "C9";
const conv = () => conversationStub(env, T, C);
const human = (id: string): Author => ({ id, kind: "human", session_id: `S${id}`, session_kind: "browser" });
const agent = (id: string): Author => ({ id, kind: "agent", session_id: `S${id}`, session_kind: "agent_run" });
const AUDIENCE = { agent_members: ["A1", "A2"], operators: { A1: "H1", A2: "H1" }, muted_agents: [] as string[], agents_enabled: true };
let clock = Date.now();
function input(author: Author, body: string, extra: Partial<PostInput> = {}): PostInput {
  clock += 1000;
  return {
    tenant_id: T, conversation_id: C, now: clock, author, policy: "open", body, body_sha256: `sha:${body}`, after: null, reply_to: null,
    refs: [], mentions: [], wake_hop: null, thread_wake_hops: {}, idempotency_key: null, audience: AUDIENCE, ...extra,
  };
}
function edit(actor: Author, msg: string, body: string | null, extra: Partial<VersionInput> = {}): VersionInput {
  clock += 1000;
  return { tenant_id: T, conversation_id: C, now: clock, actor, msg, body, body_sha256: body === null ? "" : `sha:${body}`, after: null, refs: [], mentions: [], operator_of: [], is_admin: false, idempotency_key: null, ...extra };
}
function posted(result: unknown): PostOk {
  const o = result as PostOutcome;
  if (o.refused !== null) throw new Error(`refused: ${JSON.stringify(o)}`);
  return o;
}
const sql = <T>(f: (q: SqlStorage) => T) => runInDurableObject(conv(), (_o: Conversation, state) => f(state.storage.sql));

// A test that leaves an alarm scheduled must not let it fire into a later test.
afterEach(async () => {
  await runInDurableObject(conv(), (_o: Conversation, state) => state.storage.deleteAlarm());
});

describe("stale-view bypass", () => {
  it("refuses an after past the head with the head and a short page of what is there", async () => {
    for (let i = 0; i < 8; i++) posted(await conv().post(input(human("H1"), `m${i}`)));
    const r = await conv().post(input(agent("A1"), "skipping the read", { after: 1_000_000 }));
    expect(r.refused).toBe("stale_view");
    if (r.refused === "stale_view") expect([r.head, r.missed.map((m) => m.body)]).toEqual([8, ["m3", "m4", "m5", "m6", "m7"]]);
    // Nothing was posted, and an edit carries the same check.
    expect(await conv().head(T, C)).toBe(8);
    const mine = posted(await conv().post(input(agent("A1"), "mine", { after: 8 })));
    expect((await conv().version(edit(agent("A1"), String(mine.seq), "mine, edited", { after: 99 }))).refused).toBe("stale_view");
    expect((await conv().version(edit(agent("A1"), String(mine.seq), "mine, edited", { after: mine.head }))).refused).toBeNull();
  });

  it("answers 409 stale_view over the API with the real head", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "hello" });
    const r = await call(w.scout.token, "chat.post", { c: "general", body: "late", after: 999_999 });
    expect([r.status, r.body.error, r.body.data.head]).toEqual([409, "stale_view", 1]);
  });
});

describe("hop across the conversation (C-7)", () => {
  it("does not reset to hop 1 for a top-level post after a wake in a thread", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout @tidy please look" });
    const a = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy on it", after: root.head, reply_to: root.seq });
    const b = await ok(w.tidy.token, "chat.post", { c: "general", body: "@scout done here", after: a.head, reply_to: root.seq });
    expect([a.hop, b.hop]).toEqual([1, 2]);
    // scout was woken in the thread at hop 2; a top-level mention of tidy continues the chain.
    const top = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy new topic", after: b.head });
    expect([top.hop, top.woke]).toEqual([3, 0]);
    expect(top.suppressed).toEqual([{ identity_id: w.tidy.agent.identity.id, reason: "hop_limit" }]);
  });
});

describe("catch-up cap accounting", () => {
  it("marks a channel incomplete, counts the cut, and keeps its cursor when there are more than 20 mentions", async () => {
    const w = await chatWorld();
    await channelWith(w);
    for (let i = 0; i < 22; i++) await ok(w.lead.token, "chat.post", { c: "general", body: `@dev look at item ${i}` });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const r = await ok(w.dev.token, "chat.catchup", { advance: true, budget: 8000 });
    expect(r.for_you).toHaveLength(20);
    expect(r.omitted).toBeGreaterThanOrEqual(1);
    expect(decodeCursors(r.next)[ch.project_id]).toBeUndefined();
    expect((await inboxStub(env, w.acme.id, w.dev.identity.id).cursors(w.acme.id, w.dev.identity.id))[ch.project_id]).toBeUndefined();
  });

  it("drops cursors for channels the reader cannot read from the next cursor", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "hi" });
    const ghost = "01JB2Q3R4S5T6V7W8X9YZABCDE";
    const r = await ok(w.dev.token, "chat.catchup", { since: encodeCursors({ [ghost]: 7 }) });
    expect(Object.keys(decodeCursors(r.next))).not.toContain(ghost);
  });
});

describe("muted-policy wakes", () => {
  it("reports a mentioned agent as suppressed (muted) in a muted channel, and wakes nobody", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    await setAgentPolicy(env.HUB_DB, w.acme.id, ch.project_id, "muted");
    const r = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout and @dev ping" });
    expect(r.woke).toBe(1);
    expect(r.suppressed).toEqual([{ identity_id: w.scout.agent.identity.id, reason: "muted" }]);
    expect((await inboxStub(env, w.acme.id, w.scout.agent.identity.id).list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 10, include_acked: true })).items).toEqual([]);
  });
});

describe("agent retraction (C-8) and rate counting", () => {
  it("counts only first versions toward the conversation's agent rate", async () => {
    const first = posted(await conv().post(input(agent("A1"), "base")));
    for (let i = 0; i < 40; i++) posted(await conv().version(edit(agent("A1"), String(first.seq), `edit ${i}`)));
    posted(await conv().post(input(agent("A2"), "another")));
    posted(await conv().post(input(agent("A1"), "and one more")));
  });

  it("leaves retracted messages out of the digest counts", async () => {
    const root = posted(await conv().post(input(human("H1"), "root")));
    const r1 = posted(await conv().post(input(human("H2"), "reply", { reply_to: String(root.seq) })));
    posted(await conv().post(input(human("H2"), "reply two", { reply_to: String(root.seq) })));
    const before = await conv().digest({ tenant_id: T, conversation_id: C, since: 0, me: "H3", max_items: 20 });
    expect([before.new_messages, before.threads[0]!.replies]).toEqual([3, 2]);
    posted(await conv().version(edit(human("H2"), String(r1.seq), null)));
    const after = await conv().digest({ tenant_id: T, conversation_id: C, since: 0, me: "H3", max_items: 20 });
    expect([after.new_messages, after.threads[0]!.replies]).toEqual([2, 1]);
  });
});

describe("outbox (C-9) and alarms", () => {
  // An Inbox bound to another owner throws on every delivery (bindOnce's invariant guard); the Conversation sees the failure and queues a retry.
  const poisoned = (key: string, wake: boolean) =>
    JSON.stringify({ key, kind: "mention", conversation_id: C, seq: 1, msg_id: "M", thread_root: null, hop: 0, author_id: "H1", wake, created_at: clock });
  const breakInbox = (id: string) => runInDurableObject(inboxStub(env, T, id), (_o: Inbox, state) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('tenant_id', 'other'), ('owner_id', 'other')");
  });

  it("gives up on a failing wake after 20 attempts but keeps retrying a human's notification, with capped backoff", async () => {
    posted(await conv().post(input(human("H1"), "seed")));
    await breakInbox("A1");
    await breakInbox("H2");
    await sql((q) => {
      q.exec("INSERT INTO inbox_outbox (key, identity_id, item_json, attempts) VALUES ('w', 'A1', ?, 19)", poisoned("w", true));
      q.exec("INSERT INTO inbox_outbox (key, identity_id, item_json, attempts) VALUES ('n', 'H2', ?, 19)", poisoned("n", false));
    });
    await runInDurableObject(conv(), (o: Conversation) => o.alarm());
    const rows = await sql((q) => q.exec<{ key: string; attempts: number; next_at: number }>("SELECT key, attempts, next_at FROM inbox_outbox").toArray());
    expect(rows.map((r) => [r.key, r.attempts])).toEqual([["n", 20]]);
    for (let i = 0; i < 3; i++) {
      await runInDurableObject(conv(), async (o: Conversation, state) => {
        state.storage.sql.exec("UPDATE inbox_outbox SET next_at = 0");
        await o.alarm();
      });
    }
    const [n] = await sql((q) => q.exec<{ attempts: number; next_at: number }>("SELECT attempts, next_at FROM inbox_outbox WHERE key = 'n'").toArray());
    expect(n!.attempts).toBe(23);
    expect(n!.next_at).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it("pulls the alarm earlier when a sooner retry is due", async () => {
    posted(await conv().post(input(human("H1"), "seed")));
    await sql((q) => q.exec("INSERT INTO inbox_outbox (key, identity_id, item_json) VALUES ('bad', 'A1', '{not json')"));
    await runInDurableObject(conv(), (_o: Conversation, state) => state.storage.setAlarm(Date.now() + 3_600_000));
    await runInDurableObject(conv(), (o: Conversation) => o.alarm());
    const at = await runInDurableObject(conv(), (_o: Conversation, state) => state.storage.getAlarm());
    expect(at).not.toBeNull();
    expect(at!).toBeLessThan(Date.now() + 60_000);
  });

  it("keeps an index on acked_at for the inbox prune", async () => {
    const names = await runInDurableObject(inboxStub(env, T, "I9"), (_o: Inbox, state) =>
      state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'item'").toArray().map((r) => r.name));
    expect(names).toContain("item_acked");
  });
});
