import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import type { PostInput, PostOk, PostOutcome } from "../src/chat/types";
import { getChannelBySlug } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { inDO } from "./do-helper";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

let rpcId = 0;
async function tool(token: string, args: Record<string, unknown>) {
  const r = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "chat_post", arguments: args } }),
  });
  expect(r.status).toBe(200);
  return (await rpcBody(r)).result;
}
async function setup() {
  const w = await chatWorld();
  await channelWith(w);
  const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout original request" });
  const args = { c: "general", body: "@tidy private original checkpoint", after: source.head, reply_to: source.msg_id, idempotency_key: "private-intent-key" };
  const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
  return { w, source, args, conv: conversationStub(env, w.acme.id, ch.project_id), ch };
}

describe("ordinary post intent-bound replay", () => {
  it("refuses changed body/target/refs before rates and never accepts a caller-forged fingerprint", async () => {
    const { w, source, args, conv, ch } = await setup();
    const first = (await tool(w.scout.longLived, args)).structuredContent;
    for (let i = 0; i < 35; i++) {
      const changed = await tool(w.scout.longLived, { ...args, body: "private different checkpoint", intent_fingerprint: "forged" });
      expect(changed.isError).toBe(true);
      expect(changed.content[0].text).toContain("conflict");
      expect(JSON.stringify(changed)).not.toMatch(/private|fingerprint|forged/);
    }
    for (const change of [{ reply_to: undefined }, { reply_to: first.msg_id }, { reply_to: source.seq }, { refs: [{ kind: "session", key: "01AAAAAAAAAAAAAAAAAAAAAAAA" }] }]) {
      expect((await tool(w.scout.longLived, { ...args, ...change })).content[0].text).toContain("conflict");
    }
    const retry = await tool(w.scout.longLived, { ...args, after: first.head, intent_fingerprint: "ignored" });
    expect(retry.structuredContent).toMatchObject({ msg_id: first.msg_id, replayed: true });
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(2);
    const wakes = await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(wakes.items).toHaveLength(1);
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    const events = await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all<{ kind: string; summary: string }>();
    expect(events.results.filter((e) => e.kind === "chat.post")).toHaveLength(1);
    for (const e of events.results) expect(e.summary).not.toMatch(/private|forged|fingerprint/);
    expect((await tool(w.scout.longLived, { ...args, body: "fresh checkpoint", after: first.head, idempotency_key: "fresh" })).isError).toBeUndefined();
  });

  it("binds browser API and OAuth retries to their own principals and preserves current controls", async () => {
    const { w, args } = await setup();
    const native = await ok(w.lead.token, "chat.post", args);
    expect((await call(w.lead.token, "chat.post", { ...args, body: "changed browser intent" })).body.error).toBe("conflict");
    expect(await ok(w.lead.token, "chat.post", { ...args, after: native.head })).toMatchObject({ msg_id: native.msg_id, replayed: true });
    const token = (await connectWithTokens(w.dev.token, { scope: "read write" })).tokens.access_token;
    const oauthArgs = { ...args, body: "assistant checkpoint", after: native.head };
    const send = async (a: Record<string, unknown>) => (await rpcBody(await mcpPost("acme", token, "tools/call", { name: "chat_post", arguments: a }))).result;
    const oauth = await send(oauthArgs);
    expect(oauth.isError).toBeUndefined();
    expect(oauth.structuredContent.msg_id).not.toBe(native.msg_id);
    expect((await send({ ...oauthArgs, reply_to: undefined })).content[0].text).toContain("conflict");
    expect((await send(oauthArgs)).structuredContent).toMatchObject({ msg_id: oauth.structuredContent.msg_id, replayed: true });
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await call(w.lead.token, "chat.post", { ...args, body: "changed" })).body.detail).toBe("channel is archived");
    expect((await send(oauthArgs)).content[0].text).toContain("channel is archived");
  });

  it("replays original intent after edits/retractions and object restart without resurrecting text", async () => {
    const { w, args, conv, ch } = await setup();
    const first = (await tool(w.scout.longLived, args)).structuredContent;
    await ok(w.scout.token, "chat.edit", { c: "general", msg: first.msg_id, body: "edited checkpoint", after: first.head });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: first.msg_id });
    // Fresh class over persisted SQL, not an in-memory replay map.
    expect(await inDO(conv, async (_o, state) => {
      const object = new Conversation(state, env);
      const row = state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM idem WHERE key = ?", `post:${args.idempotency_key}`).toArray()[0]!;
      const stored = JSON.parse(row.result_json);
      expect(stored.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(row.result_json).not.toContain(args.body);
      return object.postReplay(w.acme.id, ch.project_id, w.scout.agent.identity.id, args.idempotency_key, stored.fingerprint);
    })).toMatchObject({ msg_id: first.msg_id, rev: 1, replayed: true });
    expect((await tool(w.scout.longLived, args)).structuredContent).toMatchObject({ msg_id: first.msg_id, rev: 1, replayed: true });
    expect((await tool(w.scout.longLived, { ...args, body: "edited checkpoint" })).content[0].text).toContain("conflict");
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(4);
  });

  it("refuses unbound legacy records instead of guessing and leaves reconciliation read-only", async () => {
    const { w, args, conv } = await setup();
    const first = (await tool(w.scout.longLived, args)).structuredContent;
    await inDO(conv, (_o, state) => {
      const row = state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM idem WHERE key = ?", `post:${args.idempotency_key}`).toArray()[0]!;
      state.storage.sql.exec("UPDATE idem SET result_json = ? WHERE key = ?", JSON.stringify(JSON.parse(row.result_json).result ?? JSON.parse(row.result_json)), `post:${args.idempotency_key}`);
    });
    for (const body of [args.body, "different legacy guess"]) {
      const r = await tool(w.scout.longLived, { ...args, body });
      expect(r.content[0].text).toContain("conflict");
      expect(r.content[0].text).toContain("reconcile");
    }
    const thread = await ok(w.lead.token, "chat.thread", { c: "general", msg: first.msg_id });
    expect(thread.head).toBe(2);
    expect(thread.messages).toHaveLength(2);
  });

  it("binds unresolved explicit refs before resolution and refuses their removal on retry", async () => {
    const { w, args } = await setup();
    const refs = [{ kind: "session", key: "01AAAAAAAAAAAAAAAAAAAAAAAA" }, { kind: "session", key: "01BBBBBBBBBBBBBBBBBBBBBBBB" }];
    const first = await tool(w.scout.longLived, { ...args, refs });
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent.unresolved).toHaveLength(2);
    expect((await tool(w.scout.longLived, { ...args, refs })).structuredContent).toMatchObject({ msg_id: first.structuredContent.msg_id, replayed: true });
    expect((await tool(w.scout.longLived, { ...args, refs: [...refs].reverse() })).content[0].text).toContain("conflict");
    expect((await tool(w.scout.longLived, args)).content[0].text).toContain("conflict");
  });

  it("keeps keys channel-local and denies revoked membership before replay lookup", async () => {
    const { w, args } = await setup();
    const first = (await tool(w.scout.longLived, args)).structuredContent;
    await channelWith(w, "other");
    const other = await tool(w.scout.longLived, { ...args, c: "other", body: "other channel checkpoint", reply_to: undefined, after: 0 });
    expect(other.isError).toBeUndefined();
    expect(other.structuredContent.msg_id).not.toBe(first.msg_id);
    expect((await tool(w.scout.longLived, args)).structuredContent).toMatchObject({ msg_id: first.msg_id, replayed: true });
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    for (const body of [args.body, "changed denied intent"]) {
      const denied = await tool(w.scout.longLived, { ...args, body });
      expect(denied.content[0].text).toContain("not_found");
      expect(JSON.stringify(denied)).not.toContain(first.msg_id);
      expect(JSON.stringify(denied)).not.toContain("post intent");
    }
  });

  it("atomically rejects simultaneous same-key different intents at the Conversation boundary", async () => {
    const tenant = `T${crypto.randomUUID()}`, channel = "C";
    const conv = conversationStub(env, tenant, channel);
    const p: PostInput = { tenant_id: tenant, conversation_id: channel, now: Date.now(), author: { id: "H", kind: "human", session_id: "S", session_kind: "browser" }, policy: "open", body: "first", body_sha256: "hash-first", after: null, reply_to: null, refs: [], mentions: [], wake_hop: null, thread_wake_hops: {}, idempotency_key: "key", audience: { agent_members: [], operators: {}, muted_agents: [], agents_enabled: true } };
    const outcomes = await Promise.all([conv.post(p), conv.post({ ...p, body: "second", body_sha256: "hash-second" })]) as PostOutcome[];
    expect(outcomes.filter((o) => o.refused === null)).toHaveLength(1);
    expect(outcomes.filter((o) => o.refused === "conflict")).toHaveLength(1);
    const first = outcomes.find((o) => o.refused === null) as PostOk;
    const original = (await conv.read({ tenant_id: tenant, conversation_id: channel, after: null, before: null, thread: null, limit: 10 })).messages[0]!.body;
    const retry = { ...p, body: original, body_sha256: `hash-${original}`, author: { ...p.author, session_id: "new-run" } };
    expect(await conv.post(retry)).toEqual({ ...first, replayed: true });
    expect(await conv.head(tenant, channel)).toBe(1);
    // Ordinary records still expire; this does not make unbound sends permanently safe to replay.
    expect((await conv.post({ ...retry, now: p.now + 25 * 3_600_000 })).refused).toBeNull();
    expect(await conv.head(tenant, channel)).toBe(2);
  });
});
