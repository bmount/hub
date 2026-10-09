import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getChannelBySlug } from "../src/db/chat";
import { inboxStub } from "../src/chat/stubs";
import type { WakeItem } from "../src/chat/types";
import { call, channelWith, chatWorld, ok, until } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function agent(token: string, args: Record<string, unknown> = {}, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_inbox", arguments: args } }),
  });
  return { status: res.status, result: res.status === 200 ? (await rpcBody(res)).result : null };
}

const wake = (n: number, conversation_id: string, author_id: string, overrides: Partial<WakeItem> = {}): WakeItem => ({
  key: `fixture:${n}`, kind: "mention", conversation_id, seq: n, msg_id: `fixture-message-${n}`, thread_root: null,
  author_id, hop: 0, wake: true, created_at: Date.now(), ...overrides,
});

describe("bounded inbox scan checkpoints", () => {
  it("pages capped agent inboxes without confusing the global head with scanned or processed items", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    await box.deliver(w.acme.id, id, Array.from({ length: 105 }, (_, n) => wake(n + 1, ch.project_id, w.lead.identity.id)));
    const before = await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true });
    const args = { limit: 50, identity_id: w.lead.identity.id, tenant_id: "forged", next_after: 105, has_more: false };
    const first = (await agent(w.scout.longLived, args)).result.structuredContent;
    expect(first).toMatchObject({ tenant_id: w.acme.id, identity_id: id, head: 105, next_after: 50, has_more: true });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toMatchObject({ conversation_id: ch.project_id, item: 1, author_id: w.lead.identity.id });
    expect(first.text).toContain("next: after=50");
    expect(first.text).toContain("not a processed cursor");
    const second = (await agent(w.scout.longLived, { after: first.next_after, limit: 50 })).result.structuredContent;
    const third = (await agent(w.scout.longLived, { after: second.next_after, limit: 50 })).result.structuredContent;
    expect(second).toMatchObject({ head: 105, next_after: 100, has_more: true });
    expect(third).toMatchObject({ head: 105, next_after: 105, has_more: false });
    expect([...first.items, ...second.items, ...third.items].map((x: any) => x.item)).toEqual(Array.from({ length: 105 }, (_, n) => n + 1));
    expect((await agent(w.scout.longLived, args)).result.structuredContent).toEqual(first);
    expect(await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await box.cursors(w.acme.id, id)).toEqual({});
    expect((await agent(w.tidy.longLived, args)).result.structuredContent).toMatchObject({ identity_id: w.tidy.agent.identity.id, head: 0, items: [], next_after: 0, has_more: false });
  });

  it("continues through an entirely inaccessible page without leaking its channel or author evidence", async () => {
    const w = await chatWorld();
    await channelWith(w, "hidden");
    await channelWith(w, "general");
    const hidden = (await getChannelBySlug(env.HUB_DB, w.acme.id, "hidden"))!;
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    await ok(w.lead.token, "chat.post", { c: "hidden", body: "@scout forbidden original" });
    const visible = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout permitted original" });
    await ok(w.lead.token, "channel.remove_agent", { c: "hidden", agent: "scout" });
    const first = (await agent(w.scout.longLived, { limit: 1 })).result.structuredContent;
    expect(first).toMatchObject({ head: 2, items: [], next_after: 1, has_more: true });
    expect(JSON.stringify(first)).not.toContain(hidden.project_id);
    expect(JSON.stringify(first)).not.toContain("forbidden original");
    expect(first.text).not.toContain("#hidden");
    const next = (await agent(w.scout.longLived, { limit: 1, after: first.next_after })).result.structuredContent;
    expect(next).toMatchObject({ head: 2, next_after: 2, has_more: false });
    expect(next.items[0]).toMatchObject({ item: 2, msg_id: visible.msg_id, conversation_id: ch.project_id, author_id: w.lead.identity.id });
    expect(next.text).not.toContain("permitted original");
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await agent(w.scout.longLived, { after: 1, limit: 1 })).result.structuredContent).toMatchObject({ items: [], next_after: 2, has_more: false });
    await seedTenant("beta2");
    expect((await agent(w.scout.longLived, { identity_id: w.scout.agent.identity.id }, "beta2")).status).toBe(401);
  });

  it("preserves ack gaps and binds archived chat versus mail pointers without reading message bodies", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    await box.deliver(w.acme.id, id, [wake(1, ch.project_id, w.lead.identity.id), wake(2, "mail", w.dev.identity.id, { kind: "mail" }), wake(3, ch.project_id, w.lead.identity.id)]);
    await box.ack(w.acme.id, id, 1, Date.now());
    await ok(w.lead.token, "channel.archive", { c: "general" });
    const first = await ok(w.scout.token, "chat.inbox", { limit: 1 });
    expect(first).toMatchObject({ head: 3, next_after: 2, has_more: true });
    expect(first.items[0]).toMatchObject({ item: 2, kind: "mail", channel: "mail", conversation_id: null });
    const next = await ok(w.scout.token, "inbox.wait", { after: 2, limit: 1, wait_s: 0 });
    expect(next).toMatchObject({ head: 3, next_after: 3, has_more: false });
    expect(next.items[0]).toMatchObject({ item: 3, conversation_id: ch.project_id, channel: "general" });
    expect(await ok(w.scout.token, "chat.inbox", { after: 3 })).toMatchObject({ items: [], next_after: 3, has_more: false });
    expect((await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).items.map((x) => x.acked_at !== null)).toEqual([true, false, false]);
  });

  it("returns the same scan contract after a parked wait and preserves late arrivals", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    const waiting = call(w.scout.token, "inbox.wait", { after: 0, limit: 1, wait_s: 5 });
    await until(async () => (await box.waiting(w.acme.id, id)) === 1);
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout first" });
    const first = (await waiting).body.result;
    expect(first).toMatchObject({ head: 1, next_after: 1, has_more: false });
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout late arrival" });
    const late = await ok(w.scout.token, "chat.inbox", { after: first.next_after, limit: 1 });
    expect(late).toMatchObject({ head: 2, next_after: 2, has_more: false });
    expect(late.items[0].item).toBe(2);
    expect(await box.waiting(w.acme.id, id)).toBe(0);
  });

  it("binds read-only OAuth pages to the human principal and refuses revoked grants without page disclosure", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: "@lead @scout first original" });
    await ok(w.dev.token, "chat.post", { c: "general", body: "@lead @scout second original" });
    const connection = await connectWithTokens(w.lead.token);
    const invoke = async (args: Record<string, unknown>) => (await rpcBody(await mcpPost("acme", connection.tokens.access_token, "tools/call", { name: "chat_inbox", arguments: args }))).result;
    const first = (await invoke({ limit: 1, identity_id: w.scout.agent.identity.id })).structuredContent;
    expect(first).toMatchObject({ tenant_id: w.acme.id, identity_id: w.lead.identity.id, head: 2, next_after: 1, has_more: true });
    expect((await invoke({ after: first.next_after, limit: 1 })).structuredContent).toMatchObject({ next_after: 2, has_more: false });
    for (const id of [w.lead.identity.id, w.scout.agent.identity.id]) {
      const box = inboxStub(env, w.acme.id, id);
      expect(await box.cursors(w.acme.id, id)).toEqual({});
      expect((await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).items.every((x) => x.acked_at === null)).toBe(true);
    }
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id).all();
    expect(events.results.map((x) => x.kind)).toEqual(["chat.post", "chat.post"]);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), connection.client_id).run();
    const revoked = await mcpPost("acme", connection.tokens.access_token, "tools/call", { name: "chat_inbox", arguments: { after: 1 } });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain("next_after");
  });
});
