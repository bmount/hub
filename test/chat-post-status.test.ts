import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { LIMITS } from "../src/chat/rules";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { inDO } from "./do-helper";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

let rpcId = 0;
async function rpc(token: string, method: string, params: Record<string, unknown>, slug = "acme") {
  return SELF.fetch(`https://${slug}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  return (await rpcBody(r)).result;
}
async function setup() {
  const w = await chatWorld();
  await channelWith(w);
  const args = { c: "general", body: "@tidy private checkpoint", after: 0, idempotency_key: "private-key" };
  const first = (await tool(w.scout.longLived, "chat_post", args)).structuredContent;
  const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
  const conv = conversationStub(env, w.acme.id, ch.project_id);
  return { w, args, first, ch, conv };
}

describe("ordinary chat-post read-only reconciliation", () => {
  it("exposes read-only discovery, original/current evidence and no private values or posting effects", async () => {
    const { w, args, first, ch, conv } = await setup();
    const definitions = (await rpcBody(await rpc(w.scout.longLived, "tools/list", {}))).result.tools;
    const definition = definitions.find((t: { name: string }) => t.name === "chat_post_status");
    expect(definition.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(definition.inputSchema.required).toEqual(["c", "idempotency_key"]);
    const box = inboxStub(env, w.acme.id, w.tidy.agent.identity.id);
    const before = await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    for (let i = 0; i < 35; i++) {
      const r = await tool(w.scout.longLived, "chat_post_status", { ...args, identity_id: w.tidy.agent.identity.id, tenant_id: "forged" });
      expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, conversation_id: ch.project_id, identity_id: w.scout.agent.identity.id, head: 1,
        record: { committed: { msg_id: first.msg_id, seq: first.seq, rev: 1 }, current: { rev: 1, retracted: false }, intent_bound: true } });
      expect(r.structuredContent.record.expires_at - r.structuredContent.observed_at).toBeGreaterThan(LIMITS.IDEM_TTL_MS - 60_000);
      expect(JSON.stringify(r)).not.toMatch(/private|forged|fingerprint|woke|suppressed/);
      expect(r.content[0].text).toContain("not payload verification");
    }
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(1);
    expect(await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    const events = await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all<{ kind: string; summary: string }>();
    expect(events.results.filter((e) => e.kind === "chat.post")).toHaveLength(1);
    for (const e of events.results) expect(e.summary).not.toMatch(/private|forged|fingerprint/);
    await ok(w.scout.token, "chat.edit", { c: "general", msg: first.msg_id, body: "edited text", after: first.head });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: first.msg_id });
    expect((await tool(w.scout.longLived, "chat_post_status", args)).structuredContent).toMatchObject({ head: 3, record: { committed: { rev: 1 }, current: { rev: 3, retracted: true } } });
    expect((await tool(w.scout.longLived, "chat_post", { ...args, after: 3 })).structuredContent).toMatchObject({ msg_id: first.msg_id, rev: 1, replayed: true });
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(3);
    expect((await tool(w.scout.longLived, "chat_post", { ...args, body: "fresh post after lookups", after: 3, idempotency_key: "fresh" })).isError).toBeUndefined();
  });

  it("namespaces by authenticated caller/channel/post operation and never claims missing means unsent", async () => {
    const { w, args, first } = await setup();
    await channelWith(w, "other");
    for (const [token, c] of [[w.tidy.longLived, "general"], [w.scout.longLived, "other"]] as const) {
      const r = await tool(token, "chat_post_status", { ...args, c, identity_id: w.scout.agent.identity.id });
      expect(r.structuredContent.record).toBeNull();
      expect(r.content[0].text).toContain("absence does not prove nothing was sent");
    }
    await ok(w.scout.token, "chat.edit", { c: "general", msg: first.msg_id, body: "edit with own key", after: 1, idempotency_key: "edit-only" });
    expect((await tool(w.scout.longLived, "chat_post_status", { ...args, idempotency_key: "edit-only" })).structuredContent.record).toBeNull();
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "native source" });
    const response = await tool(w.scout.longLived, "chat_post", { ...args, body: "source-bound result", after: source.head, idempotency_key: "durable-only", response_to: { msg_id: source.msg_id, rev: 1, author_id: w.lead.identity.id } });
    expect(response.isError).toBeUndefined();
    expect((await tool(w.scout.longLived, "chat_post_status", { ...args, idempotency_key: "durable-only" })).structuredContent.record).toBeNull();
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).structuredContent.result.committed.msg_id).toBe(response.structuredContent.msg_id);
  });

  it("retains snapshot/expiry across a fresh object, reports legacy unbound records and unavailable messages honestly", async () => {
    const { w, args, first, ch, conv } = await setup();
    await inDO(conv, async (_o, state) => {
      const fresh = new Conversation(state, env);
      const original = await fresh.postStatus(w.acme.id, ch.project_id, w.scout.agent.identity.id, args.idempotency_key);
      expect(original.record?.committed.msg_id).toBe(first.msg_id);
      const row = state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM idem WHERE key = ?", "post:private-key").toArray()[0]!;
      state.storage.sql.exec("UPDATE idem SET result_json = ? WHERE key = ?", JSON.stringify(JSON.parse(row.result_json).result), "post:private-key");
      expect((await fresh.postStatus(w.acme.id, ch.project_id, w.scout.agent.identity.id, args.idempotency_key)).record?.intent_bound).toBe(false);
      // Simulate missing current artifact, not a real product data mutation.
      state.storage.sql.exec("DELETE FROM msg WHERE msg_id = ?", first.msg_id);
      expect((await fresh.postStatus(w.acme.id, ch.project_id, w.scout.agent.identity.id, args.idempotency_key)).record?.current).toBeNull();
      state.storage.sql.exec("UPDATE idem SET created_at = ? WHERE key = ?", Date.now() - LIMITS.IDEM_TTL_MS, "post:private-key");
      expect((await fresh.postStatus(w.acme.id, ch.project_id, w.scout.agent.identity.id, args.idempotency_key)).record).toBeNull();
      expect(state.storage.sql.exec("SELECT * FROM idem").toArray()).toHaveLength(1); // Lookup does not prune.
    });
  });

  it("allows authorized reads under posting controls but denies removed membership and cross-tenant access", async () => {
    const { w, args } = await setup();
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    await ok(w.lead.token, "chat.agents_disable");
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await tool(w.scout.longLived, "chat_post_status", args)).structuredContent.record).not.toBeNull();
    expect((await tool(w.scout.longLived, "chat_post", args)).isError).toBe(true);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_post_status", args);
    expect(denied.content[0].text).toContain("not_found");
    expect(denied.structuredContent).toBeUndefined();
    await seedTenant("beta2");
    expect((await rpc(w.scout.longLived, "tools/call", { name: "chat_post_status", arguments: args }, "beta2")).status).toBe(401);
  });

  it("preserves exact whitespace and maximum-length keys, while unkeyed posts remain untracked", async () => {
    const { w, args, first } = await setup();
    for (const key of [" private-key ", " ", "k".repeat(64)]) {
      const sent = await ok(w.lead.token, "chat.post", { c: "general", body: `native keyed checkpoint ${key.length}`, idempotency_key: key });
      const status = await ok(w.lead.token, "chat.post_status", { c: "general", idempotency_key: key });
      expect(status.record.committed.msg_id).toBe(sent.msg_id);
      expect(status.record.committed.msg_id).not.toBe(first.msg_id);
    }
    expect((await ok(w.lead.token, "chat.post_status", args)).record).toBeNull();
    const unkeyed = await ok(w.lead.token, "chat.post", { c: "general", body: "unkeyed native checkpoint" });
    expect((await ok(w.lead.token, "chat.post_status", { c: "general", idempotency_key: unkeyed.msg_id })).record).toBeNull();
  });

  it("binds read-only OAuth to its human principal and refuses malformed keys/revoked grants", async () => {
    const { w, args, first } = await setup();
    const native = await ok(w.lead.token, "chat.post", { ...args, body: "human checkpoint", after: first.head });
    const connection = await connectWithTokens(w.lead.token);
    const token = connection.tokens.access_token;
    const r = (await rpcBody(await mcpPost("acme", token, "tools/call", { name: "chat_post_status", arguments: { ...args, identity_id: w.scout.agent.identity.id } }))).result;
    expect(r.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, record: { committed: { msg_id: native.msg_id } } });
    expect((await rpcBody(await mcpPost("acme", token, "tools/call", { name: "chat_post", arguments: args }))).result.isError).toBe(true);
    for (const key of [undefined, null, "", 12, {}, [], "a".repeat(65)]) {
      expect((await call(w.lead.token, "chat.post_status", { c: "general", idempotency_key: key })).body.error).toBe("bad_request");
    }
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), connection.client_id).run();
    expect((await mcpPost("acme", token, "tools/call", { name: "chat_post_status", arguments: args })).status).toBe(401);
  });
});
