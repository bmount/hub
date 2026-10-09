import { env, runDurableObjectAlarm } from "cloudflare:test";
import { inDO } from "./do-helper";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import type { Conversation } from "../src/chat/conversationDO";
import type { Author, PostInput, PostOk, PostOutcome, VersionInput } from "../src/chat/types";

// A fresh tenant id per test: the pool isolates storage per file, so objects must not be shared between tests.
let T = "T1";
beforeEach(() => { T = `T${crypto.randomUUID()}`; });
const C = "C1";
const conv = () => conversationStub(env, T, C);
const human = (id: string): Author => ({ id, kind: "human", session_id: `S${id}`, session_kind: "browser" });
const agent = (id: string): Author => ({ id, kind: "agent", session_id: `S${id}`, session_kind: "agent_run" });
const AUDIENCE = { agent_members: ["A1", "A2", "A3"], operators: { A1: "H1", A2: "H2", A3: "H1" }, muted_agents: [] as string[], agents_enabled: true };

let clock = Date.now();
function input(author: Author, body: string, extra: Partial<PostInput> = {}): PostInput {
  clock += 1000;
  return {
    tenant_id: T, conversation_id: C, now: clock, author, policy: "open", body, body_sha256: `sha:${body}`, after: null, reply_to: null,
    refs: [], mentions: [], wake_hop: null, thread_wake_hops: {}, idempotency_key: null, audience: AUDIENCE, ...extra,
  };
}
/** Takes the RPC result as unknown: the stub's return type is the object's, wrapped by workers-types. */
function ok(result: unknown): PostOk {
  const o = result as PostOutcome;
  if (o.refused !== null) throw new Error(`refused: ${JSON.stringify(o)}`);
  return o;
}
function edit(actor: Author, msg: string, body: string | null, extra: Partial<VersionInput> = {}): VersionInput {
  clock += 1000;
  return {
    tenant_id: T, conversation_id: C, now: clock, actor, msg, body, body_sha256: body === null ? "" : `sha:${body}`, after: null, refs: [], mentions: [],
    operator_of: [], is_admin: false, idempotency_key: null, ...extra,
  };
}
// Tests that fail deliveries on purpose leave an alarm scheduled; it must not fire into a later test.
afterEach(async () => {
  await inDO(conv(), (_o, state) => state.storage.deleteAlarm());
});
const items = async (id: string) => (await inboxStub(env, T, id).list(T, id, { after: 0, limit: 100, include_acked: true })).items;

describe("Conversation: messages and versions", () => {
  it("appends messages with per-conversation seqs and reads the newest page", async () => {
    const a = ok(await conv().post(input(human("H1"), "hello")));
    const b = ok(await conv().post(input(human("H2"), "second")));
    expect([a.seq, b.seq, b.head, a.hop, a.rev]).toEqual([1, 2, 2, 0, 1]);
    const page = await conv().read({ tenant_id: T, conversation_id: C, after: null, before: null, thread: null, limit: 50 });
    expect(page.messages.map((m) => [m.seq, m.body, m.author_id])).toEqual([[1, "hello", "H1"], [2, "second", "H2"]]);
    expect(await conv().head(T, C)).toBe(2);
  });

  it("threads replies one level deep under the root, whichever message is replied to", async () => {
    const root = ok(await conv().post(input(human("H1"), "root")));
    const r1 = ok(await conv().post(input(human("H2"), "reply one", { reply_to: String(root.seq) })));
    ok(await conv().post(input(human("H1"), "reply two", { reply_to: r1.msg_id })));
    const top = await conv().read({ tenant_id: T, conversation_id: C, after: null, before: null, thread: null, limit: 50 });
    expect(top.messages.map((m) => [m.seq, m.reply_count, m.last_reply_seq])).toEqual([[1, 2, 3]]);
    const thread = await conv().read({ tenant_id: T, conversation_id: C, after: null, before: null, thread: String(r1.seq), limit: 50 });
    expect([thread.root!.seq, ...thread.messages.map((m) => [m.seq, m.root_seq])]).toEqual([1, [2, 1], [3, 1]]);
    expect((await conv().post(input(human("H1"), "x", { reply_to: "99" }))).refused).toBe("not_found");
  });

  it("returns what changed after a cursor, including edits of older messages", async () => {
    ok(await conv().post(input(human("H1"), "one")));
    ok(await conv().post(input(human("H1"), "two")));
    ok(await conv().version(edit(human("H1"), "1", "one, edited")));
    const page = await conv().read({ tenant_id: T, conversation_id: C, after: 2, before: null, thread: null, limit: 50 });
    expect(page.messages.map((m) => [m.seq, m.body, m.edited, m.rev])).toEqual([[1, "one, edited", true, 2]]);
  });

  it("orders and limits a read after a cursor by what it filters on, so its cursor skips and repeats nothing", async () => {
    ok(await conv().post(input(human("H1"), "one")));
    ok(await conv().post(input(human("H1"), "two")));
    ok(await conv().post(input(human("H1"), "three")));
    ok(await conv().version(edit(human("H1"), "1", "one, edited")));
    const q = (after: number) => conv().read({ tenant_id: T, conversation_id: C, after, before: null, thread: null, limit: 2 });
    const first = await q(0);
    expect(first.messages.map((m) => m.body)).toEqual(["two", "three"]);
    expect([first.has_more, first.cursors]).toEqual([true, { 2: 2, 3: 3 }]);
    const second = await q(first.cursors[3]!);
    expect(second.messages.map((m) => [m.seq, m.body])).toEqual([[1, "one, edited"]]);
    expect(second.has_more).toBe(false);
  });

  it("replays an idempotent post instead of posting twice", async () => {
    const first = ok(await conv().post(input(human("H1"), "once", { idempotency_key: "k1" })));
    const again = ok(await conv().post(input(human("H1"), "once", { idempotency_key: "k1" })));
    expect(again).toEqual({ ...first, replayed: true });
    expect(await conv().replay(T, C, "H1", "post", "k1")).toEqual({ ...first, replayed: true });
    expect(await conv().head(T, C)).toBe(1);
  });

  it.each(["channel_muted", "agent_muted", "disabled"])("checks supplied %s controls before ordinary replay inside the transaction", async (control) => {
    const p = input(agent("A1"), "once with a wake", { idempotency_key: "controls", mentions: [{ identity_id: "A2", kind: "agent" }] });
    const first = ok(await conv().post(p));
    const blocked = { ...p, policy: control === "channel_muted" ? "muted" as const : p.policy,
      audience: { ...AUDIENCE, agents_enabled: control !== "disabled", muted_agents: control === "agent_muted" ? ["A1"] : [] } };
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => conv().post(blocked)));
    expect(outcomes.map((o) => o.refused)).toEqual(["forbidden", "forbidden", "forbidden", "forbidden"]);
    expect(await conv().head(T, C)).toBe(first.head);
    expect(await items("A2")).toHaveLength(1);
    expect(ok(await conv().post(p))).toEqual({ ...first, replayed: true });
    expect(await items("A2")).toHaveLength(1);
  });

  it("refuses a stale view with the missed messages; own and system messages do not count", async () => {
    ok(await conv().post(input(human("H1"), "mine")));
    expect((await conv().post(input(human("H1"), "mine again", { after: 0 }))).refused).toBeNull();
    ok(await conv().post(input(human("H2"), "theirs")));
    const r = await conv().post(input(human("H1"), "late", { after: 2 }));
    expect(r.refused).toBe("stale_view");
    if (r.refused === "stale_view") expect([r.head, r.missed.map((m) => m.body)]).toEqual([3, ["theirs"]]);
    expect((await conv().post(input(human("H1"), "caught up", { after: 3 }))).refused).toBeNull();
  });

  it("refuses the same text from the same identity within ten minutes", async () => {
    ok(await conv().post(input(human("H1"), "same")));
    expect((await conv().post(input(human("H1"), "same"))).refused).toBe("duplicate");
    expect((await conv().post(input(human("H2"), "same"))).refused).toBeNull();
    expect((await conv().post(input(human("H1"), "same", { now: clock + 11 * 60_000 }))).refused).toBeNull();
  });

  it("lets only the author edit; lets the operator or an admin retract an agent's message, never a human's", async () => {
    const h = ok(await conv().post(input(human("H2"), "human words")));
    const a = ok(await conv().post(input(agent("A1"), "agent words")));
    expect((await conv().version(edit(human("H1"), String(h.seq), "changed", { is_admin: true }))).refused).toBe("forbidden");
    expect((await conv().version(edit(human("H1"), String(h.seq), null, { is_admin: true }))).refused).toBe("forbidden");
    expect((await conv().version(edit(human("H1"), String(a.seq), "rewritten", { operator_of: ["A1"] }))).refused).toBe("forbidden");
    expect((await conv().version(edit(human("H2"), String(a.seq), null))).refused).toBe("forbidden");
    const r = ok(await conv().version(edit(human("H1"), String(a.seq), null, { operator_of: ["A1"] })));
    expect(r.rev).toBe(2);
    const m = (await conv().getMessage(T, C, String(a.seq)))!;
    expect([m.retracted, m.body, m.author_id]).toEqual([true, "", "A1"]);
    expect((await conv().version(edit(agent("A1"), String(a.seq), "back"))).refused).toBe("conflict");
    const hist = (await conv().history(T, C, a.msg_id))!;
    expect(hist.versions.map((v) => [v.rev, v.author_id, v.retracted])).toEqual([[1, "A1", false], [2, "H1", true]]);
  });

  it("caps a message at 50 versions", async () => {
    const m = ok(await conv().post(input(human("H1"), "v1")));
    for (let i = 2; i <= 50; i++) ok(await conv().version(edit(human("H1"), String(m.seq), `v${i}`)));
    expect((await conv().version(edit(human("H1"), String(m.seq), "v51"))).refused).toBe("edit_cap");
  });

  it("applies the version cap to edits only: a message at rev 50 can still be retracted (B-I2)", async () => {
    const m = ok(await conv().post(input(human("H1"), "v1")));
    for (let i = 2; i <= 50; i++) ok(await conv().version(edit(human("H1"), String(m.seq), `v${i}`)));
    expect((await conv().version(edit(human("H1"), String(m.seq), "v51"))).refused).toBe("edit_cap");
    const r = ok(await conv().version(edit(human("H1"), String(m.seq), null)));
    expect(r.rev).toBe(51);
    expect((await conv().getMessage(T, C, String(m.seq)))!.retracted).toBe(true);
  });
});

describe("Conversation: wakes and loop limits", () => {
  it("wakes mentioned agents and notifies mentioned humans, never the author", async () => {
    const r = ok(await conv().post(input(human("H1"), "@a1 @h2 @h1", { mentions: [{ identity_id: "A1", kind: "agent" }, { identity_id: "H2", kind: "human" }, { identity_id: "H1", kind: "human" }] })));
    expect(r.woke.sort()).toEqual(["A1", "H2"]);
    expect((await items("A1")).map((i) => [i.kind, i.seq, i.wake, i.key])).toEqual([["mention", 1, true, `${C}:1:A1`]]);
    expect((await items("H2")).map((i) => [i.kind, i.wake])).toEqual([["mention", false]]);
    expect(await items("H1")).toEqual([]);
  });

  it("wakes thread subscribers on a reply; suppresses agents that left, are muted, or are switched off", async () => {
    const root = ok(await conv().post(input(human("H1"), "root", { mentions: [{ identity_id: "A1", kind: "agent" }, { identity_id: "A2", kind: "agent" }] })));
    ok(await conv().post(input(agent("A3"), "joining", { reply_to: String(root.seq) })));
    const audience = { ...AUDIENCE, agent_members: ["A1", "A3"], muted_agents: ["A3"] };
    const r = ok(await conv().post(input(human("H2"), "a reply", { reply_to: String(root.seq), audience })));
    expect(r.woke.sort()).toEqual(["A1", "H1"]);
    expect(r.suppressed.sort((x, y) => x.identity_id.localeCompare(y.identity_id))).toEqual([
      { identity_id: "A2", reason: "not_member" }, { identity_id: "A3", reason: "muted" },
    ]);
    const off = ok(await conv().post(input(human("H2"), "another", { reply_to: String(root.seq), audience: { ...AUDIENCE, agents_enabled: false } })));
    expect(off.woke).toEqual(["H1"]);
  });

  it("counts hops through replies and stops waking agents at hop 3, while humans still get items", async () => {
    const m0 = ok(await conv().post(input(human("H1"), "@a1", { mentions: [{ identity_id: "A1", kind: "agent" }] })));
    const m1 = ok(await conv().post(input(agent("A1"), "@a2", { reply_to: String(m0.seq), mentions: [{ identity_id: "A2", kind: "agent" }] })));
    const m2 = ok(await conv().post(input(agent("A2"), "@a1", { reply_to: String(m1.seq), mentions: [{ identity_id: "A1", kind: "agent" }] })));
    const m3 = ok(await conv().post(input(agent("A1"), "@a2 @h2", { reply_to: String(m2.seq), mentions: [{ identity_id: "A2", kind: "agent" }, { identity_id: "H2", kind: "human" }] })));
    expect([m0.hop, m1.hop, m2.hop, m3.hop]).toEqual([0, 1, 2, 3]);
    expect(m3.suppressed).toEqual([{ identity_id: "A2", reason: "hop_limit" }]);
    expect(m3.woke).toEqual(expect.arrayContaining(["H2", "H1"]));
    expect((await items("A2")).map((i) => i.seq)).toEqual([2]);
    expect((await conv().getMessage(T, C, String(m3.seq)))!.hop_limited).toBe(true);
    const m4 = ok(await conv().post(input(human("H1"), "human again", { reply_to: String(m3.seq) })));
    expect(m4.hop).toBe(0);
  });

  it("uses the open wake's hop as the cause of a top-level agent post", async () => {
    const r = ok(await conv().post(input(agent("A1"), "prompted", { wake_hop: 1 })));
    expect(r.hop).toBe(2);
  });

  it("refuses the ninth consecutive agent post in a scope with needs_human and one system message; a human resets", async () => {
    // Three agents in turn, so the pair breaker (two agents alternating) stays out of this test.
    for (let i = 0; i < 8; i++) ok(await conv().post(input(agent(["A1", "A2", "A3"][i % 3]!), `agent ${i}`)));
    expect((await conv().post(input(agent("A1"), "ninth"))).refused).toBe("needs_human");
    expect((await conv().post(input(agent("A3"), "tenth"))).refused).toBe("needs_human");
    const page = await conv().read({ tenant_id: T, conversation_id: C, after: null, before: null, thread: null, limit: 50 });
    expect(page.messages.filter((m) => m.kind === "system").length).toBe(1);
    ok(await conv().post(input(human("H1"), "go on")));
    expect((await conv().post(input(agent("A1"), "ninth, now allowed"))).refused).toBeNull();
  });

  it("trips the pair breaker after more than four alternations: system message, operator items, wakes paused", async () => {
    const mention = (id: string) => ({ mentions: [{ identity_id: id, kind: "agent" as const }] });
    let last: PostOk | null = null;
    for (let i = 0; i < 6; i++) last = ok(await conv().post(input(agent(i % 2 === 0 ? "A1" : "A2"), `turn ${i}`, mention(i % 2 === 0 ? "A2" : "A1"))));
    expect(last!.loop_tripped).toEqual({ a: "A1", b: "A2" });
    expect(last!.suppressed).toEqual([{ identity_id: "A1", reason: "pair_block" }]);
    expect((await items("H1")).map((i) => i.kind)).toEqual(["loop_tripped"]);
    expect((await items("H2")).map((i) => i.kind)).toEqual(["loop_tripped"]);
    const next = ok(await conv().post(input(agent("A1"), "still talking", { mentions: [{ identity_id: "A2", kind: "agent" }, { identity_id: "A3", kind: "agent" }] })));
    expect(next.loop_tripped).toBeNull();
    expect(next.woke).toEqual(["A3"]);
    expect(next.suppressed).toEqual([{ identity_id: "A2", reason: "pair_block" }]);
  });

  it("holds all agents in one conversation to 30 posts a minute", async () => {
    const roots: string[] = [];
    for (let i = 0; i < 4; i++) roots.push(String(ok(await conv().post(input(human("H1"), `root ${i}`))).seq));
    const t0 = clock;
    let n = 0;
    for (const root of roots) for (let i = 0; i < 8 && n < 30; i++, n++) ok(await conv().post(input(agent("A1"), `r${n}`, { reply_to: root, now: t0 + n })));
    const r = await conv().post(input(agent("A2"), "one more", { reply_to: roots[3]!, now: t0 + 31 }));
    expect(r.refused).toBe("rate");
  });

  it("takes agent posts under mention_only only in threads that mention the agent", async () => {
    const root = ok(await conv().post(input(human("H1"), "@a1 please", { mentions: [{ identity_id: "A1", kind: "agent" }] })));
    const other = ok(await conv().post(input(human("H1"), "no mention")));
    expect((await conv().post(input(agent("A1"), "top", { policy: "mention_only" }))).refused).toBe("forbidden");
    expect((await conv().post(input(agent("A1"), "wrong thread", { policy: "mention_only", reply_to: String(other.seq) }))).refused).toBe("forbidden");
    expect((await conv().post(input(agent("A1"), "on it", { policy: "mention_only", reply_to: String(root.seq) }))).refused).toBeNull();
  });
});

describe("Conversation: index, retries, binding", () => {
  it("writes msg_index and the latest version's refs to D1", async () => {
    const m = ok(await conv().post(input(human("H1"), "see site#k7q2", { refs: [{ kind: "ticket", key: "site#k7q2", title: "Pin parser" }] })));
    const idx = await env.HUB_DB.prepare("SELECT seq, rev, state FROM msg_index WHERE conversation_id = ? ORDER BY seq").bind(C).all();
    expect(idx.results).toEqual([{ seq: 1, rev: 1, state: "live" }]);
    const refs = () => env.HUB_DB.prepare("SELECT target_kind, target_key, rev FROM msg_ref WHERE conversation_id = ?").bind(C).all();
    expect((await refs()).results).toEqual([{ target_kind: "ticket", target_key: "site#k7q2", rev: 1 }]);
    ok(await conv().version(edit(human("H1"), String(m.seq), "now site#ab12", { refs: [{ kind: "ticket", key: "site#ab12", title: null }] })));
    expect((await refs()).results).toEqual([{ target_kind: "ticket", target_key: "site#ab12", rev: 2 }]);
    ok(await conv().version(edit(human("H1"), String(m.seq), null)));
    expect((await refs()).results).toEqual([]);
  });

  it("retries a stranded delivery from the alarm without duplicating the item", async () => {
    ok(await conv().post(input(human("H1"), "@a1", { mentions: [{ identity_id: "A1", kind: "agent" }] })));
    const stranded = { key: `${C}:1:A1`, kind: "mention", conversation_id: C, seq: 1, msg_id: "M", thread_root: null, hop: 0, author_id: "H1", wake: true, created_at: clock };
    await inDO(conv(), async (_o, state) => {
      state.storage.sql.exec("INSERT INTO inbox_outbox (key, identity_id, item_json) VALUES (?, 'A1', ?)", stranded.key, JSON.stringify(stranded));
      state.storage.sql.exec("INSERT INTO index_outbox (seq) VALUES (1)");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(conv())).toBe(true);
    const left = await inDO(conv(), (_o, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM inbox_outbox) + (SELECT COUNT(*) FROM index_outbox) AS n").one().n);
    expect(left).toBe(0);
    expect((await items("A1")).length).toBe(1);
  });

  it("refuses a request for another tenant", async () => {
    ok(await conv().post(input(human("H1"), "hello")));
    // C-1: a throw must not cross RPC in tests (isolated storage), so observe it inside the object.
    await inDO(conv(), async (o: Conversation) => {
      await expect(o.head("T2", C)).rejects.toThrow(/another tenant/);
    });
  });
});

describe("Conversation: fix wave (B-I3, C-4, idempotency, outbox)", () => {
  const refs = () => env.HUB_DB.prepare("SELECT target_key, rev FROM msg_ref WHERE conversation_id = ?").bind(C).all();
  const A_REF = [{ kind: "ticket" as const, key: "site#k7q2", title: null }];
  const B_REF = [{ kind: "ticket" as const, key: "site#ab12", title: null }];

  it("leaves only the latest version's refs when a post and an edit drain at the same time (B-I3)", async () => {
    const posting = conv().post(input(human("H1"), "see site#k7q2", { refs: A_REF }));
    const editing = conv().version(edit(human("H1"), "1", "now site#ab12", { refs: B_REF }));
    ok(await posting);
    ok(await editing);
    expect((await refs()).results).toEqual([{ target_key: "site#ab12", rev: 2 }]);
  });

  it("does not index an older version's refs when its flush arrives after a newer one (B-I3)", async () => {
    ok(await conv().post(input(human("H1"), "see site#k7q2", { refs: A_REF })));
    ok(await conv().version(edit(human("H1"), "1", "now site#ab12", { refs: B_REF })));
    expect((await refs()).results).toEqual([{ target_key: "site#ab12", rev: 2 }]);
    // A late flush of seq 1 (rev 1), as an interleaved drain would have sent it.
    await inDO(conv(), async (o: Conversation, state) => {
      state.storage.sql.exec("INSERT INTO index_outbox (seq) VALUES (1)");
      await o.alarm();
    });
    expect((await refs()).results).toEqual([{ target_key: "site#ab12", rev: 2 }]);
  });

  it("counts the hop of the newest open wake in the thread, not just the replied-to message (C-4)", async () => {
    const root = ok(await conv().post(input(human("H1"), "root @a1 @a2", { mentions: [{ identity_id: "A1", kind: "agent" }, { identity_id: "A2", kind: "agent" }] })));
    const reply = async (author: Author, thread_wake_hops: Record<string, number>) =>
      ok(await conv().post(input(author, `reply ${clock}`, { reply_to: String(root.seq), thread_wake_hops })));
    expect(root.hop).toBe(0);
    expect((await reply(agent("A1"), {})).hop).toBe(1);
    expect((await reply(agent("A2"), { [root.msg_id]: 1 })).hop).toBe(2);
    expect((await reply(agent("A1"), { [root.msg_id]: 2 })).hop).toBe(3);
    // The wake of another thread does not count here.
    expect((await reply(agent("A3"), { OTHER: 2 })).hop).toBe(1);
    expect((await reply(human("H2"), { [root.msg_id]: 2 })).hop).toBe(0);
  });

  it("namespaces idempotency keys by operation and expires them after 24 hours", async () => {
    const first = ok(await conv().post(input(human("H1"), "once", { idempotency_key: "k" })));
    const edited = ok(await conv().version(edit(human("H1"), String(first.seq), "twice", { idempotency_key: "k" })));
    expect([edited.replayed, edited.rev]).toEqual([false, 2]);
    expect(ok(await conv().version(edit(human("H1"), String(first.seq), "thrice", { idempotency_key: "k" }))).replayed).toBe(true);
    const gone = ok(await conv().version(edit(human("H1"), String(first.seq), null, { idempotency_key: "k" })));
    expect([gone.replayed, gone.rev]).toEqual([false, 3]);
    expect(await conv().replay(T, C, "H1", "post", "k")).toEqual({ ...first, replayed: true });
    expect(await conv().replay(T, C, "H1", "edit", "k")).toMatchObject({ rev: 2, replayed: true });
    const later = ok(await conv().post(input(human("H1"), "once", { idempotency_key: "k", now: clock + 25 * 3_600_000 })));
    expect([later.replayed, later.seq]).toEqual([false, 4]);
  });

  it("refuses an agent post inside the object when the kill switch, a mute, or a muted channel says so", async () => {
    const off = await conv().post(input(agent("A1"), "x", { audience: { ...AUDIENCE, agents_enabled: false } }));
    expect(off).toMatchObject({ refused: "forbidden", detail: expect.stringContaining("switched off") });
    const muted = await conv().post(input(agent("A1"), "x", { audience: { ...AUDIENCE, muted_agents: ["A1"] } }));
    expect(muted).toMatchObject({ refused: "forbidden", detail: expect.stringContaining("muted") });
    expect((await conv().post(input(agent("A1"), "x", { policy: "muted" }))).refused).toBe("forbidden");
    expect((await conv().post(input(human("H1"), "x", { policy: "muted", audience: { ...AUDIENCE, agents_enabled: false } }))).refused).toBeNull();
    expect((await conv().post(input(agent("A2"), "fine", { audience: { ...AUDIENCE, muted_agents: ["A1"] } }))).refused).toBeNull();
  });

  const outbox = (item: Record<string, unknown>, key: string, identity: string) => ({ key, identity, json: JSON.stringify(item) });
  const wake = (key: string) => ({ key, kind: "mention", conversation_id: C, seq: 1, msg_id: "M", thread_root: null, hop: 0, author_id: "H1", wake: true, created_at: clock });

  it("never drops an index row: it survives more than 20 failures and lands when D1 recovers", async () => {
    await env.HUB_DB.exec("CREATE TRIGGER fail_msg_index BEFORE INSERT ON msg_index BEGIN SELECT RAISE(ABORT, 'd1 down'); END");
    try {
      ok(await conv().post(input(human("H1"), "see site#k7q2", { refs: A_REF })));
      const row = () => inDO(conv(), (_o, state) =>
        state.storage.sql.exec<{ attempts: number; next_at: number }>("SELECT attempts, next_at FROM index_outbox").toArray());
      expect((await row())[0]!.attempts).toBe(1);
      for (let i = 0; i < 22; i++) {
        await inDO(conv(), async (o: Conversation, state) => {
          state.storage.sql.exec("UPDATE index_outbox SET next_at = 0");
          await o.alarm();
        });
      }
      const [stuck] = await row();
      expect(stuck!.attempts).toBe(23);
      // The delay stays capped at 10 minutes however many attempts there were.
      expect(stuck!.next_at).toBeLessThanOrEqual(Date.now() + 600_000);
    } finally {
      await env.HUB_DB.exec("DROP TRIGGER fail_msg_index");
    }
    await inDO(conv(), async (o: Conversation, state) => {
      state.storage.sql.exec("UPDATE index_outbox SET next_at = 0");
      await o.alarm();
    });
    expect((await refs()).results).toEqual([{ target_key: "site#k7q2", rev: 1 }]);
    expect(await inDO(conv(), (_o, state) => state.storage.sql.exec("SELECT 1 FROM index_outbox").toArray().length)).toBe(0);
  });

  it("backs off a failing row, isolates it from the others, and drops it after the attempt cap", async () => {
    ok(await conv().post(input(human("H1"), "seed")));
    const good = outbox(wake(`${C}:1:A1`), `${C}:1:A1`, "A1");
    await inDO(conv(), async (o: Conversation, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO inbox_outbox (key, identity_id, item_json) VALUES ('poison', 'A2', '{not json')");
      sql.exec("INSERT INTO inbox_outbox (key, identity_id, item_json) VALUES (?, ?, ?)", good.key, good.identity, good.json);
      await o.alarm();
    });
    expect((await items("A1")).length).toBe(1);
    const row = () => inDO(conv(), (_o, state) =>
      state.storage.sql.exec<{ attempts: number; next_at: number }>("SELECT attempts, next_at FROM inbox_outbox WHERE key = 'poison'").toArray());
    const [first] = await row();
    expect(first!.attempts).toBe(1);
    expect(first!.next_at).toBeGreaterThan(Date.now() + 1000);
    // Not due yet: another drain leaves it alone.
    await inDO(conv(), (o: Conversation) => o.alarm());
    expect((await row())[0]!.attempts).toBe(1);
    await inDO(conv(), async (o: Conversation, state) => {
      state.storage.sql.exec("UPDATE inbox_outbox SET attempts = 19, next_at = 0 WHERE key = 'poison'");
      await o.alarm();
    });
    expect(await row()).toEqual([]);
  });
});
