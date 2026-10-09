import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import type { Author, PostInput, PostOk, PostOutcome, ResponseIntent, VersionInput } from "../src/chat/types";
import { inDO } from "./do-helper";

let tenant = "";
beforeEach(() => { tenant = `T${crypto.randomUUID()}`; });
const channel = "C1";
const conv = () => conversationStub(env, tenant, channel);
const author = (id: string): Author => ({ id, kind: id === "H" ? "human" : "agent", session_id: `S${id}`, session_kind: id === "H" ? "browser" : "agent_run" });
const audience = { agent_members: ["A", "B"], operators: {}, muted_agents: [], agents_enabled: true };
function post(id: string, body: string, extra: Partial<PostInput> = {}): PostInput {
  return { tenant_id: tenant, conversation_id: channel, now: Date.now(), author: author(id), policy: "open", body, body_sha256: `sha:${body}`, after: null, reply_to: null,
    refs: [], mentions: [], wake_hop: null, thread_wake_hops: {}, idempotency_key: null, audience, ...extra };
}
function ok(r: PostOutcome): PostOk {
  expect(r.refused).toBeNull();
  return r as PostOk;
}
async function setup() {
  const source = ok(await conv().post(post("H", "original request")));
  const response: ResponseIntent = { source: { msg_id: source.msg_id, rev: 1, author_id: "H" }, fingerprint: "sha:answer" };
  const input = post("A", "answer", { reply_to: source.msg_id, after: source.head, response, idempotency_key: "key", mentions: [{ identity_id: "B", kind: "agent" }] });
  return { source, response, input };
}
function version(id: string, msg: string, body: string | null): VersionInput {
  return { tenant_id: tenant, conversation_id: channel, now: Date.now(), actor: author(id), msg, body, body_sha256: `sha:${body}`, after: null, refs: [], mentions: [], operator_of: [], is_admin: false, idempotency_key: null };
}

describe("durable source-bound chat responses", () => {
  it("commits independent bounded progress/result slots and replays each across keys, sessions and restart", async () => {
    const { input, response, source } = await setup();
    const progress = { ...input, body: "testing", body_sha256: "sha:testing", response: { ...response, stage: "progress" as const, fingerprint: "sha:testing" } };
    const attempts = await Promise.all(Array.from({ length: 4 }, (_, i) => conv().post({ ...progress, author: { ...progress.author, session_id: `progress-${i}` }, idempotency_key: `progress-${i}` })));
    const first = ok(attempts.find((r) => r.refused === null && !r.replayed)!);
    expect(attempts.filter((r) => r.refused === null && !r.replayed)).toHaveLength(1);
    const result = ok(await conv().post({ ...input, after: first.head, response: { ...response, stage: "result" } }));
    expect(result.msg_id).not.toBe(first.msg_id);
    const later = Date.now() + 48 * 3_600_000;
    for (const [intent, committed] of [[progress.response, first], [response, result]] as const) {
      expect(await inDO(conv(), async (_object, state) => new Conversation(state, env).responseReplay(tenant, channel, "A", intent))).toEqual({ ...committed, replayed: true });
    }
    expect(ok(await conv().post({ ...progress, now: later, idempotency_key: "retry" }))).toEqual({ ...first, replayed: true });
    expect(ok(await conv().post({ ...input, now: later, idempotency_key: "retry" }))).toEqual({ ...result, replayed: true });
    expect((await conv().getMessage(tenant, channel, result.msg_id))!.thread_root).toBe(source.msg_id);
    expect(await conv().head(tenant, channel)).toBe(3);
    const inbox = await inboxStub(env, tenant, "B").list(tenant, "B", { after: 0, limit: 100, include_acked: true });
    expect(inbox.items).toHaveLength(2);
    expect((await conv().post({ ...progress, response: { ...progress.response, fingerprint: "changed" } })).refused).toBe("conflict");
    expect((await conv().post({ ...input, response: { ...response, stage: "result", fingerprint: "changed" } })).refused).toBe("conflict");
  });

  it("reconciles legacy records as result, without permitting arbitrary stage namespaces", async () => {
    const { input, response } = await setup();
    const legacy = ok(await conv().post(input));
    expect(ok(await conv().post({ ...input, response: { ...response, stage: "result" } }))).toEqual({ ...legacy, replayed: true });
    const invalid = { ...response, stage: "arbitrary" } as unknown as ResponseIntent;
    expect((await conv().responseReplay(tenant, channel, "A", invalid))!.refused).toBe("conflict");
    expect((await conv().post({ ...input, response: invalid })).refused).toBe("conflict");
    expect(await conv().head(tenant, channel)).toBe(2);
  });

  it("checks current source evidence and gates for each new slot without resurrecting retracted progress", async () => {
    const { input, response, source } = await setup();
    const progress = { ...input, response: { ...response, stage: "progress" as const } };
    const first = ok(await conv().post(progress));
    ok(await conv().version(version("H", source.msg_id, "changed request")));
    expect((await conv().post({ ...input, after: 3 })).refused).toBe("conflict");
    ok(await conv().version(version("A", first.msg_id, null)));
    expect(ok(await conv().post(progress))).toEqual({ ...first, replayed: true });
    expect((await conv().getMessage(tenant, channel, first.msg_id))!.retracted).toBe(true);
    for (const stage of ["progress", "result"] as const) {
      expect((await conv().post({ ...input, policy: "muted", response: { ...response, stage } })).refused).toBe("forbidden");
    }
    expect(await conv().head(tenant, channel)).toBe(4);
  });

  it("atomically posts one response and wake across concurrent keys/sessions and retries beyond 24 hours", async () => {
    const { input, response } = await setup();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => conv().post({ ...input, author: { ...input.author, session_id: `S${i}` }, idempotency_key: `k${i}` })));
    const first = ok(results.find((r) => r.refused === null && !r.replayed)!);
    expect(results.filter((r) => r.refused === null && !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.refused === null && r.msg_id === first.msg_id)).toBe(true);
    // An ordinary write triggers expired-idem pruning, not durable response deletion.
    const later = Date.now() + 48 * 3_600_000;
    ok(await conv().post(post("H", "later unrelated checkpoint", { now: later, idempotency_key: "later" })));
    expect(ok(await conv().post({ ...input, now: later, idempotency_key: "new" }))).toEqual({ ...first, replayed: true });
    // Fresh object instance over the same SQL storage proves this is not in-memory deduplication.
    expect(await inDO(conv(), async (_object, state) => new Conversation(state, env).responseReplay(tenant, channel, "A", response))).toEqual({ ...first, replayed: true });
    expect(await conv().head(tenant, channel)).toBe(3);
    const inbox = await inboxStub(env, tenant, "B").list(tenant, "B", { after: 0, limit: 100, include_acked: true });
    expect(inbox.items).toHaveLength(1);
  });

  it("fails closed on mismatched source author/revision, missing source and changed retry content", async () => {
    const { input, response } = await setup();
    for (const source of [{ ...response.source, author_id: "forged" }, { ...response.source, rev: 2 }]) {
      expect((await conv().post({ ...input, response: { ...response, source } })).refused).toBe("conflict");
    }
    expect((await conv().post({ ...input, reply_to: "missing", response: { ...response, source: { ...response.source, msg_id: "missing" } } })).refused).toBe("not_found");
    expect((await conv().post({ ...input, reply_to: null })).refused).toBe("conflict");
    expect((await conv().post({ ...input, after: null })).refused).toBe("conflict");
    const first = ok(await conv().post(input));
    expect((await conv().post({ ...input, body: "changed", response: { ...response, fingerprint: "sha:changed" } })).refused).toBe("conflict");
    expect((await conv().post({ ...input, response: { ...response, source: { ...response.source, rev: 2 } } })).refused).toBe("conflict");
    expect(await conv().head(tenant, channel)).toBe(first.head);
  });

  it("does not respond to changed/retracted sources, but reconciles already committed responses without resurrection", async () => {
    const { input, source, response } = await setup();
    ok(await conv().version(version("H", source.msg_id, "edited request")));
    expect((await conv().post(input)).refused).toBe("conflict");
    const revised = { ...input, after: 2, response: { ...response, source: { ...response.source, rev: 2 } } };
    const first = ok(await conv().post(revised));
    ok(await conv().version(version("H", source.msg_id, null)));
    ok(await conv().version(version("A", first.msg_id, null)));
    expect(ok(await conv().post(revised))).toEqual({ ...first, replayed: true });
    expect((await conv().getMessage(tenant, channel, first.msg_id))!.retracted).toBe(true);
    const other = { ...revised, author: author("B"), after: 5 };
    expect((await conv().post(other)).refused).toBe("conflict");
    expect(await conv().head(tenant, channel)).toBe(5);
  });

  it("keeps caller/channel/tenant namespaces and ordinary replay keys separate", async () => {
    const { input, source } = await setup();
    const ordinary = ok(await conv().post(post("A", "ordinary", { idempotency_key: "key" })));
    const first = ok(await conv().post(input));
    expect(first.msg_id).not.toBe(ordinary.msg_id);
    const second = ok(await conv().post({ ...input, author: author("B"), body: "B answer", body_sha256: "sha:B", after: first.head, response: { ...input.response!, fingerprint: "sha:B" } }));
    expect(second.msg_id).not.toBe(first.msg_id);
    const other = conversationStub(env, tenant, "C2");
    expect((await other.responseReplay(tenant, "C2", "A", input.response!))!.refused).toBe("not_found");
    await inDO(conv(), async (object) => {
      await expect((object as Conversation).responseReplay("wrong", channel, "A", input.response!)).rejects.toThrow("another tenant or owner");
    });
    expect((await conv().getMessage(tenant, channel, first.msg_id))!.thread_root).toBe(source.msg_id);
  });

  it("preserves stale views, mention-only policy and disabled/muted agent controls", async () => {
    const { input } = await setup();
    expect((await conv().post({ ...input, after: 0 })).refused).toBe("stale_view");
    expect((await conv().post({ ...input, policy: "mention_only" })).refused).toBe("forbidden");
    const first = ok(await conv().post(input));
    for (const extra of [{ policy: "muted" as const }, { audience: { ...audience, agents_enabled: false } }, { audience: { ...audience, muted_agents: ["A"] } }]) {
      expect((await conv().post({ ...input, ...extra })).refused).toBe("forbidden");
    }
    expect(await conv().head(tenant, channel)).toBe(first.head);
  });
});
