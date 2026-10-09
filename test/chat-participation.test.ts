import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getChannelBySlug } from "../src/db/chat";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

let rpcId = 0;
function agentRpc(token: string, method: string, params: Record<string, unknown>, slug = "acme") {
  return SELF.fetch(`https://${slug}.pimwell.test/agent/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await agentRpc(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  return (await rpcBody(response)).result;
}
const post = { c: "general", body: "checkpoint completed", after: 0, idempotency_key: "checkpoint-1" };

describe("authenticated MCP chat participation", () => {
  it("exposes scoped writes and replays a persisted post across requests without another message/wake", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const list = (await rpcBody(await agentRpc(w.scout.longLived, "tools/list", {}))).result.tools;
    const names = list.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["chat_post", "chat_mark_read", "inbox_ack"]));
    expect(names).not.toContain("channel_add_agent");
    const definition = list.find((t: { name: string }) => t.name === "chat_post");
    expect(definition.inputSchema.required).toEqual(["c", "body", "after", "idempotency_key"]);
    const args = { ...post, body: "@dev private checkpoint completed", author_id: w.lead.identity.id, tenant_id: "forged", session_id: "forged" };
    const first = await tool(w.scout.longLived, "chat_post", args);
    expect(first.isError).toBeUndefined();
    for (let i = 0; i < 8; i++) {
      const retry = await tool(w.scout.longLived, "chat_post", args);
      expect(retry.structuredContent).toMatchObject({ msg_id: first.structuredContent.msg_id, seq: 1, replayed: true });
    }
    const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: 1 })).structuredContent;
    expect(thread).toMatchObject({ tenant_id: w.acme.id, head: 1 });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].author).toMatchObject({ identity_id: w.scout.agent.identity.id, kind: "agent", via_assistant: false });
    const inbox = await inboxStub(env, w.acme.id, w.dev.identity.id).list(w.acme.id, w.dev.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(inbox.items).toHaveLength(1);
    const audit = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'mcp.call' AND target_id = 'chat.post'").all<{ summary: string }>();
    expect(audit.results.length).toBe(9);
    for (const e of audit.results) {
      expect(e.summary).toContain("body");
      expect(e.summary).not.toMatch(/private|checkpoint|forged|@dev/);
    }
  });

  it("routes a durable reply to exact source evidence and reconciles new keys without message/wake/rate/audit duplication", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout original product request" });
    const args = { ...post, body: "@tidy tested increment", after: source.head, response_to: { msg_id: source.msg_id, rev: 1, author_id: w.lead.identity.id } };
    const first = await tool(w.scout.longLived, "chat_post", args);
    expect(first.isError).toBeUndefined();
    for (let i = 0; i < 35; i++) {
      const retry = await tool(w.scout.longLived, "chat_post", { ...args, idempotency_key: `retry-${i}` });
      expect(retry.structuredContent).toMatchObject({ msg_id: first.structuredContent.msg_id, replayed: true });
    }
    const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id })).structuredContent;
    expect(thread.head).toBe(2);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1].root_seq).toBe(source.seq);
    const events = await env.HUB_DB.prepare("SELECT target_id FROM event WHERE tenant_id = ? AND kind = 'chat.post' AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all();
    expect(events.results).toHaveLength(1);
    const inbox = await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(inbox.items).toHaveLength(1);
    const changed = await tool(w.scout.longLived, "chat_post", { ...args, body: "different response" });
    expect(changed.content[0].text).toContain("conflict");
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    expect((await tool(w.scout.longLived, "chat_post", args)).content[0].text).toContain("muted");
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await tool(w.scout.longLived, "chat_post", args)).content[0].text).toContain("not_found");
  });

  it("posts authenticated progress and result in one source thread with independent durable replay", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout product request" });
    const evidence = { msg_id: source.msg_id, rev: 1, author_id: w.lead.identity.id };
    const progressArgs = { ...post, after: source.head, body: "@tidy testing increment", response_to: { ...evidence, stage: "progress" } };
    const progress = await tool(w.scout.longLived, "chat_post", progressArgs);
    expect(progress.isError).toBeUndefined();
    const resultArgs = { ...post, after: progress.structuredContent.head, body: "@tidy tested result", response_to: { ...evidence, stage: "result" } };
    const result = await tool(w.scout.longLived, "chat_post", resultArgs);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.msg_id).not.toBe(progress.structuredContent.msg_id);
    for (const [args, committed] of [[progressArgs, progress], [resultArgs, result]] as const) {
      const retry = await tool(w.scout.longLived, "chat_post", { ...args, idempotency_key: "new-key" });
      expect(retry.structuredContent).toMatchObject({ msg_id: committed.structuredContent.msg_id, replayed: true });
      expect((await tool(w.scout.longLived, "chat_post", { ...args, body: "different" })).content[0].text).toContain("conflict");
    }
    const defaultResult = await tool(w.scout.longLived, "chat_post", { ...resultArgs, response_to: evidence });
    expect(defaultResult.structuredContent).toMatchObject({ msg_id: result.structuredContent.msg_id, replayed: true });
    const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id })).structuredContent;
    expect(thread.head).toBe(3);
    expect(thread.messages).toHaveLength(3);
    for (const reply of thread.messages.slice(1)) {
      expect(reply.root_seq).toBe(source.seq);
      expect(reply.author).toMatchObject({ identity_id: w.scout.agent.identity.id, kind: "agent", via_assistant: false });
    }
    const inbox = await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(inbox.items).toHaveLength(2);
    const events = await env.HUB_DB.prepare("SELECT target_id FROM event WHERE tenant_id = ? AND kind = 'chat.post' AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all();
    expect(events.results).toHaveLength(2);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    for (const args of [progressArgs, resultArgs]) expect((await tool(w.scout.longLived, "chat_post", args)).content[0].text).toContain("not_found");
  });

  it("refuses malformed, forged, changed or cross-channel source evidence before writing", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await channelWith(w, "other");
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "original request" });
    const evidence = { msg_id: source.msg_id, rev: 1, author_id: w.lead.identity.id };
    for (const response_to of [null, [], "general/1", { ...evidence, msg_id: 1 }, { ...evidence, rev: "1" }, { ...evidence, rev: 0 }, { ...evidence, author_id: "handle" }, { ...evidence, authority: "admin" }, ...[null, "", "other", 1, {}, []].map((stage) => ({ ...evidence, stage }))]) {
      expect((await tool(w.scout.longLived, "chat_post", { ...post, after: 1, response_to })).content[0].text).toContain("bad_request");
    }
    expect((await tool(w.scout.longLived, "chat_post", { ...post, after: 1, response_to: evidence, reply_to: source.msg_id })).content[0].text).toContain("bad_request");
    for (const response_to of [{ ...evidence, author_id: w.dev.identity.id }, { ...evidence, rev: 2 }]) {
      expect((await tool(w.scout.longLived, "chat_post", { ...post, after: 1, response_to })).content[0].text).toContain("conflict");
    }
    expect((await tool(w.scout.longLived, "chat_post", { ...post, c: "other", response_to: evidence })).content[0].text).toContain("not_found");
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "changed request" });
    expect((await tool(w.scout.longLived, "chat_post", { ...post, after: 2, response_to: evidence })).content[0].text).toContain("conflict");
    expect((await tool(w.scout.longLived, "chat_read", { c: "general" })).structuredContent.head).toBe(2);
  });

  it("requires a stable key and a read head, and refuses stale views before posting", async () => {
    const w = await chatWorld();
    await channelWith(w);
    for (const args of [{ c: "general", body: "x", after: 0 }, { ...post, idempotency_key: "" }, { c: "general", body: "x", idempotency_key: "key" }]) {
      const res = await tool(w.scout.longLived, "chat_post", args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("bad_request");
    }
    await ok(w.lead.token, "chat.post", { c: "general", body: "new primary context" });
    const stale = await tool(w.scout.longLived, "chat_post", post);
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain("stale_view");
    const read = (await tool(w.scout.longLived, "chat_read", { c: "general" })).structuredContent;
    expect((await tool(w.scout.longLived, "chat_post", { ...post, after: read.head })).structuredContent.seq).toBe(2);
  });

  it("retains channel membership/tenant isolation even for replay and cursor updates", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    for (const [name, args] of [["chat_post", post], ["chat_mark_read", { c: "general", seq: 1 }], ["chat_thread", { c: "general", msg: 1 }]] as const) {
      const res = await tool(w.tidy.longLived, name, args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not_found");
    }
    expect((await tool(w.scout.longLived, "chat_post", post)).isError).toBeUndefined();
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await tool(w.scout.longLived, "chat_post", post)).content[0].text).toContain("not_found");
    await seedTenant("beta2");
    expect((await agentRpc(w.scout.longLived, "tools/list", {}, "beta2")).status).toBe(401);
  });

  it.each(["muted", "mention_only", "disabled", "archived"])("does not bypass %s channel/agent policy", async (policy) => {
    const w = await chatWorld();
    await channelWith(w);
    if (policy === "muted" || policy === "mention_only") await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy });
    if (policy === "disabled") await ok(w.lead.token, "chat.agents_disable");
    if (policy === "archived") await ok(w.lead.token, "channel.archive", { c: "general" });
    const refused = await tool(w.scout.longLived, "chat_post", post);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain({ muted: "muted", mention_only: "forbidden", disabled: "agents_disabled", archived: "conflict" }[policy]!);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(0);
  });

  it("moves only the caller's durable cursors and acknowledges only its inbox; reads remain read-only", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout @tidy review this" });
    const inbox = (await tool(w.scout.longLived, "chat_inbox")).structuredContent;
    expect(inbox).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id });
    expect(inbox.items[0]).toMatchObject({ author_id: w.lead.identity.id });
    await tool(w.scout.longLived, "chat_read", { c: "general" });
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    await tool(w.scout.longLived, "chat_mark_read", { c: "general", seq: 1, identity_id: w.tidy.agent.identity.id });
    await tool(w.scout.longLived, "chat_mark_read", { c: "general", seq: 0 });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [ch.project_id]: 1 });
    await tool(w.scout.longLived, "inbox_ack", { through: inbox.items[0].item, identity_id: w.tidy.agent.identity.id });
    expect((await tool(w.scout.longLived, "chat_inbox")).structuredContent.items).toEqual([]);
    expect((await tool(w.tidy.longLived, "chat_inbox")).structuredContent.items).toHaveLength(1);
    expect(await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).cursors(w.acme.id, w.tidy.agent.identity.id)).toEqual({});
  });

  it("keeps OAuth read-only grants read-only and distinguishes assistant-written primary text", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const read = (await connectWithTokens(w.lead.token)).tokens.access_token;
    for (const name of ["chat_post", "chat_mark_read", "inbox_ack"]) {
      const res = (await rpcBody(await mcpPost("acme", read, "tools/call", { name, arguments: post }))).result;
      expect(res.isError).toBe(true);
    }
    const write = (await connectWithTokens(w.lead.token, { scope: "read write" })).tokens.access_token;
    const res = (await rpcBody(await mcpPost("acme", write, "tools/call", { name: "chat_post", arguments: { ...post, body: "@scout evidence only, not unconditional authority" } }))).result;
    expect(res.isError).toBeUndefined();
    // Stored provenance wins even if the live session row changes later.
    const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: 1 })).structuredContent;
    const session = thread.messages[0].author.session_id;
    await env.HUB_DB.prepare("UPDATE session SET kind = 'browser', revoked_at = ? WHERE id = ?").bind(Date.now(), session).run();
    const catchup = (await tool(w.scout.longLived, "chat_catchup")).structuredContent;
    expect(catchup.tenant_id).toBe(w.acme.id);
    expect(catchup.for_you[0].author).toMatchObject({ identity_id: w.lead.identity.id, kind: "human", via_assistant: true });
    expect(catchup.advanced).toBe(false);
  });
});
