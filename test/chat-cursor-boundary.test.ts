import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getChannelBySlug } from "../src/db/chat";
import { inboxStub } from "../src/chat/stubs";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown>, slug = "acme") {
  const res = await SELF.fetch(`https://${slug}.pimwell.test/agent/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: res.status, result: (await rpcBody(res)).result };
}

describe("durable read cursor channel-head boundary", () => {
  it("refuses future API cursors without clamping, leaving later messages discoverable", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    for (const seq of [1, Number.MAX_SAFE_INTEGER]) {
      const r = await call(w.scout.token, "chat.mark_read", { c: "general", seq });
      expect(r).toMatchObject({ status: 409, body: { error: "conflict", data: { head: 0 } } });
      expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    }
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout original request" });
    const refused = await call(w.scout.token, "chat.mark_read", { c: "general", seq: source.head + 1 });
    expect(refused).toMatchObject({ status: 409, body: { data: { head: source.head } } });
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect((await ok(w.scout.token, "chat.catchup")).for_you.map((m: { msg_id: string }) => m.msg_id)).toEqual([source.msg_id]);
    expect((await ok(w.scout.token, "chat.mark_read", { c: "general", seq: source.head })).read_seq).toBe(source.head);
    expect((await ok(w.scout.token, "chat.mark_read", { c: "general", seq: 0 })).read_seq).toBe(source.head);
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout revised request" });
    expect(edit.head).toBeGreaterThan(source.head);
    expect((await ok(w.scout.token, "chat.catchup")).for_you[0]).toMatchObject({ msg_id: source.msg_id, rev: 2 });
    // An activity head can be an edit sequence, not a message number or inbox head.
    expect((await ok(w.scout.token, "chat.mark_read", { c: "general", seq: edit.head })).read_seq).toBe(edit.head);
    const later = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout later request" });
    expect((await ok(w.scout.token, "chat.catchup")).for_you[0].msg_id).toBe(later.msg_id);
  });

  it("enforces the boundary through real agent MCP, caller-only monotonic writes and replay", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout @tidy checkpoint" });
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    for (let i = 0; i < 3; i++) {
      const r = await tool(w.scout.longLived, "chat_mark_read", { c: "general", seq: Number.MAX_SAFE_INTEGER, identity_id: w.tidy.agent.identity.id, head: Number.MAX_SAFE_INTEGER });
      expect(r.status).toBe(200);
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain("conflict");
      expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    }
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const seen = (await tool(w.scout.longLived, "chat_read", { c: "general" })).result.structuredContent;
    for (const seq of [seen.head, seen.head, 0]) {
      const r = await tool(w.scout.longLived, "chat_mark_read", { c: "general", seq, identity_id: w.tidy.agent.identity.id });
      expect(r.result.structuredContent.read_seq).toBe(source.head);
    }
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [ch.project_id]: source.head });
    expect(await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).cursors(w.acme.id, w.tidy.agent.identity.id)).toEqual({});
    // No acknowledgement, post, presence, or duplicate wake accompanies refusal or cursor writes.
    expect((await tool(w.scout.longLived, "chat_inbox", {})).result.structuredContent.items).toHaveLength(1);
    expect((await tool(w.tidy.longLived, "chat_inbox", {})).result.structuredContent.items).toHaveLength(1);
    expect((await tool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id })).result.structuredContent.head).toBe(source.head);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND identity_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id, w.scout.agent.identity.id).all();
    expect(events.results).toEqual([]);
  });

  it("uses the requested authorized channel head and never reveals a denied channel head", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await channelWith(w, "other", ["scout"]);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout channel-specific activity" });
    expect((await call(w.scout.token, "chat.mark_read", { c: "other", seq: source.head })).body).toMatchObject({ error: "conflict", data: { head: 0 } });
    const denied = await call(w.tidy.token, "chat.mark_read", { c: "general", seq: Number.MAX_SAFE_INTEGER });
    expect(denied.status).toBe(404);
    expect(denied.body.data).toBeUndefined();
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const revoked = (await tool(w.scout.longLived, "chat_mark_read", { c: "general", seq: Number.MAX_SAFE_INTEGER })).result;
    expect(revoked.content[0].text).toContain("not_found");
    expect(revoked.content[0].text).not.toContain("head");
    await seedTenant("beta2");
    expect((await tool(w.scout.longLived, "chat_mark_read", { c: "general", seq: 0 }, "beta2")).status).toBe(401);
  });

  it("retains OAuth write scope and principal binding, refusing future human cursors", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const read = (await connectWithTokens(w.lead.token)).tokens.access_token;
    const write = (await connectWithTokens(w.lead.token, { scope: "read write" })).tokens.access_token;
    const args = { c: "general", seq: 1, identity_id: w.scout.agent.identity.id };
    const invoke = async (token: string, seq = 1) => (await rpcBody(await mcpPost("acme", token, "tools/call", { name: "chat_mark_read", arguments: { ...args, seq } }))).result;
    expect((await invoke(read)).isError).toBe(true);
    expect((await invoke(write)).content[0].text).toContain("conflict");
    const source = await ok(w.dev.token, "chat.post", { c: "general", body: "native human activity" });
    expect((await invoke(write, source.head)).structuredContent.read_seq).toBe(source.head);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    expect(await inboxStub(env, w.acme.id, w.lead.identity.id).cursors(w.acme.id, w.lead.identity.id)).toEqual({ [ch.project_id]: source.head });
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
  });
});
