import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboxStub } from "../src/chat/stubs";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function agent(token: string, args: Record<string, unknown>, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox_ack", arguments: args } }),
  });
  return { status: res.status, result: res.status === 200 ? (await rpcBody(res)).result : null };
}

describe("explicit processed-item inbox acknowledgements", () => {
  it("clears only a processed visible source after a skipped denied page, with durable idempotent retries", async () => {
    const w = await chatWorld();
    await channelWith(w, "hidden");
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "hidden", body: "@scout skipped source" });
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout processed source" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout later source" });
    await ok(w.lead.token, "channel.remove_agent", { c: "hidden", agent: "scout" });
    const denied = await ok(w.scout.token, "chat.inbox", { limit: 1 });
    expect(denied).toMatchObject({ items: [], next_after: 1, has_more: true });
    const visible = await ok(w.scout.token, "chat.inbox", { after: denied.next_after, limit: 1 });
    const original = await ok(w.scout.token, "chat.thread", { c: "general", msg: visible.items[0].msg_id });
    expect(original.messages[0]).toMatchObject({ msg_id: source.msg_id, author: { identity_id: w.lead.identity.id } });
    expect(await ok(w.scout.token, "inbox.ack", { items: [visible.items[0].item] })).toEqual({ acked: 1 });
    expect((await agent(w.scout.longLived, { items: [2, 2, 999], identity_id: w.tidy.agent.identity.id, tenant_id: "forged" })).result.structuredContent).toEqual({ acked: 0 });
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect((await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).items.map(x => x.acked_at !== null)).toEqual([false, true, false]);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.highWater(w.acme.id, w.scout.agent.identity.id)).toBe(3);
    // An absent item is not a future watermark: a subsequent delivery remains open.
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout newest source" });
    expect((await ok(w.scout.token, "chat.inbox", { after: 2 })).items.map((x: any) => x.item)).toEqual([3, 4]);
    expect((await agent(w.scout.longLived, { items: [4, 3, 4] })).result.structuredContent).toEqual({ acked: 2 });
    expect((await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: false })).items.map(x => x.item_seq)).toEqual([1]);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id).all();
    expect(events.results.map(x => x.kind)).toEqual(Array(4).fill("chat.post"));
  });

  it("refuses malformed or ambiguous selectors before any acknowledgement, retaining legacy through mode", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout open source" });
    for (const args of [
      { items: [] }, { items: null }, { items: "1" }, { items: [1, "2"] }, { items: [1, 0] },
      { items: [1, -1] }, { items: [1, 1.5] }, { items: [1, Number.MAX_SAFE_INTEGER + 1] },
      { items: Array(101).fill(1) }, { items: [1], through: 0 }, { items: [1], through: null },
    ]) {
      expect((await call(w.scout.token, "inbox.ack", args)).status).toBe(400);
      expect((await agent(w.scout.longLived, args)).result.isError).toBe(true);
    }
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect((await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: false })).items).toHaveLength(1);
    expect(await ok(w.scout.token, "inbox.ack", { through: 0 })).toEqual({ acked: 0 });
    expect(await ok(w.scout.token, "inbox.ack", { through: 1 })).toEqual({ acked: 1 });
    expect(await ok(w.scout.token, "inbox.ack", { through: 1 })).toEqual({ acked: 0 });
  });

  it("selects item numbers, not source sequences, for bounded chat and mail attention in only the caller inbox", async () => {
    const w = await chatWorld();
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    const delivery = Array.from({ length: 100 }, (_, n) => ({
      key: `mail-${n}`, kind: "mail" as const, conversation_id: "mail", seq: 0, msg_id: `mail-source-${n}`,
      thread_root: null, hop: 0, author_id: w.lead.identity.id, wake: true, created_at: Date.now(),
    }));
    await box.deliver(w.acme.id, id, delivery);
    const other = inboxStub(env, w.acme.id, w.tidy.agent.identity.id);
    await other.deliver(w.acme.id, w.tidy.agent.identity.id, delivery.slice(0, 1));
    const first = await ok(w.scout.token, "chat.inbox", { limit: 100 });
    expect(first.items[0]).toMatchObject({ item: 1, seq: 0, conversation_id: null });
    expect(await ok(w.scout.token, "inbox.ack", { items: [Number.MAX_SAFE_INTEGER] })).toEqual({ acked: 0 });
    expect((await agent(w.scout.longLived, { items: first.items.map((x: any) => x.item), identity_id: w.tidy.agent.identity.id })).result.structuredContent).toEqual({ acked: 100 });
    expect((await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: false })).items).toEqual([]);
    expect((await other.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: false })).items).toHaveLength(1);
    expect(await box.highWater(w.acme.id, id)).toBe(100);
    expect(await box.cursors(w.acme.id, id)).toEqual({});
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, id).run();
    expect((await agent(w.scout.longLived, { items: [1] })).status).toBe(401);
  });

  it("binds OAuth acknowledgement to its human and write grant, never a claimed agent or tenant", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: "@lead @scout separate inboxes" });
    const reader = await connectWithTokens(w.lead.token);
    const writer = await connectWithTokens(w.lead.token, { scope: "read write" });
    const invoke = (token: string, args: Record<string, unknown>, slug = "acme") => mcpPost(slug, token, "tools/call", { name: "inbox_ack", arguments: args });
    expect((await rpcBody(await invoke(reader.tokens.access_token, { items: [1] }))).result.isError).toBe(true);
    expect((await rpcBody(await invoke(writer.tokens.access_token, { items: [1], identity_id: w.scout.agent.identity.id }))).result.structuredContent).toEqual({ acked: 1 });
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect((await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 10, include_acked: false })).items).toHaveLength(1);
    await seedTenant("beta2");
    expect((await agent(w.scout.longLived, { items: [1] }, "beta2")).status).toBe(401);
    expect((await invoke(writer.tokens.access_token, { items: [1] }, "beta2")).status).toBe(401);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), writer.client_id).run();
    expect((await invoke(writer.tokens.access_token, { items: [1] })).status).toBe(401);
    const audits = await env.HUB_DB.prepare("SELECT summary FROM event WHERE tenant_id = ? AND kind = 'mcp.call' AND target_id = 'inbox.ack'").bind(w.acme.id).all<{ summary: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]!.summary).toBe("inbox.ack ok {items, +1 other}");
    expect(audits.results[0]!.summary).not.toContain(w.scout.agent.identity.id);
  });
});
