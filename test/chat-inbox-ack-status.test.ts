import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboxStub } from "../src/chat/stubs";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function agent(token: string, args: Record<string, unknown>, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox_ack_status", arguments: args } }),
  });
  return { status: res.status, result: res.status === 200 ? (await rpcBody(res)).result : null };
}

describe("read-only exact-item acknowledgement reconciliation", () => {
  it("reconciles a lost selective ack response without resending, clearing skipped items or exposing denied sources", async () => {
    const w = await chatWorld();
    await channelWith(w, "hidden");
    await channelWith(w);
    await ok(w.lead.token, "chat.post", { c: "hidden", body: "@scout private skipped text" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout processed original" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout later attention" });
    await ok(w.lead.token, "channel.remove_agent", { c: "hidden", agent: "scout" });
    const page = await ok(w.scout.token, "chat.inbox", { after: 1, limit: 1 });
    await ok(w.scout.token, "chat.thread", { c: "general", msg: page.items[0].msg_id });
    await ok(w.scout.token, "inbox.ack", { items: [2] }); // Pretend the response was lost; never replay to determine its outcome.
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const expected = { tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, items: [
      { item: 3, state: "open", acked_at: null }, { item: 2, state: "acked", acked_at: before.items[1]!.acked_at },
      { item: 1, state: "open", acked_at: null }, { item: 999, state: "unknown", acked_at: null },
    ] };
    for (let n = 0; n < 10; n++) {
      const r = (await agent(w.scout.longLived, { items: [3, 2, 1, 2, 999], identity_id: w.tidy.agent.identity.id, tenant_id: "forged" })).result;
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject(expected);
      expect(Object.keys(r.structuredContent)).toEqual(["tenant_id", "identity_id", "items", "text"]);
      expect(r.content[0].text).toContain("unknown");
      expect(JSON.stringify(r)).not.toContain("private skipped text");
      expect(JSON.stringify(r)).not.toContain(before.items[0]!.msg_id);
      expect(Object.keys(r.structuredContent.items[0])).toEqual(["item", "state", "acked_at"]);
    }
    expect(await ok(w.scout.token, "inbox.ack_status", { items: [2] })).toMatchObject({ items: [expected.items[1]] });
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id).all();
    expect(events.results.map(x => x.kind)).toEqual(Array(3).fill("chat.post"));
    const audits = await env.HUB_DB.prepare("SELECT summary FROM event WHERE tenant_id = ? AND kind = 'mcp.call' AND target_id = 'inbox.ack_status'").bind(w.acme.id).all<{ summary: string }>();
    expect(audits.results).toHaveLength(10);
    expect(audits.results.every(x => x.summary === "inbox.ack_status ok {items, +2 other}")).toBe(true);
  });

  it("keeps absent and pruned states unknown and accepts the full bounded selection including mail pointers", async () => {
    const w = await chatWorld();
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    await box.deliver(w.acme.id, id, Array.from({ length: 100 }, (_, n) => ({
      key: `mail-${n}`, kind: "mail" as const, conversation_id: "mail", seq: 0, msg_id: `mail-source-${n}`,
      thread_root: null, hop: 0, author_id: w.lead.identity.id, wake: true, created_at: Date.now(),
    })));
    await box.ackItems(w.acme.id, id, [2], Date.now() - 31 * 86_400_000);
    expect((await ok(w.scout.token, "inbox.ack_status", { items: [2] })).items[0].state).toBe("acked");
    await box.deliver(w.acme.id, id, []);
    const result = await ok(w.scout.token, "inbox.ack_status", { items: Array.from({ length: 100 }, (_, n) => n + 1) });
    expect(result.items).toHaveLength(100);
    expect(result.items[1]).toEqual({ item: 2, state: "unknown", acked_at: null });
    expect(result.items.filter((x: any) => x.state === "open")).toHaveLength(99);
    expect((await ok(w.scout.token, "inbox.ack_status", { items: [Number.MAX_SAFE_INTEGER] })).items).toEqual([{ item: Number.MAX_SAFE_INTEGER, state: "unknown", acked_at: null }]);
    expect((await ok(w.tidy.token, "inbox.ack_status", { items: [1] })).items[0].state).toBe("unknown");
    expect(await box.highWater(w.acme.id, id)).toBe(100);
  });

  it("rejects malformed selectors instead of returning partial or misleading states", async () => {
    const w = await chatWorld();
    for (const args of [ {}, { items: [] }, { items: null }, { items: "1" }, { items: [1, "2"] },
      { items: [1, 0] }, { items: [1, -1] }, { items: [1, 1.5] }, { items: [Number.MAX_SAFE_INTEGER + 1] },
      { items: Array(101).fill(1) }, { items: [1], through: 1 }, { items: [1], through: null },
    ]) {
      expect((await call(w.scout.token, "inbox.ack_status", args)).status).toBe(400);
      expect((await agent(w.scout.longLived, args)).result.isError).toBe(true);
    }
    expect((await ok(w.scout.token, "inbox.ack_status", { items: [1, 1] })).items).toEqual([{ item: 1, state: "unknown", acked_at: null }]);
  });

  it("allows read-only OAuth for its human namespace but refuses revoked grants, memberships and other tenants", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: "@lead @scout separate readers" });
    await ok(w.scout.token, "inbox.ack", { items: [1] });
    const reader = await connectWithTokens(w.lead.token);
    const invoke = (args: Record<string, unknown>, host = "acme") => mcpPost(host, reader.tokens.access_token, "tools/call", { name: "inbox_ack_status", arguments: args });
    const r = (await rpcBody(await invoke({ items: [1], identity_id: w.scout.agent.identity.id }))).result;
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, items: [{ item: 1, state: "open", acked_at: null }] });
    expect((await agent(w.scout.longLived, { items: [1] })).result.structuredContent.items[0].state).toBe("acked");
    await seedTenant("beta2");
    expect((await invoke({ items: [1] }, "beta2")).status).toBe(401);
    expect((await agent(w.scout.longLived, { items: [1] }, "beta2")).status).toBe(401);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), reader.client_id).run();
    expect((await invoke({ items: [1] })).status).toBe(401);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).run();
    expect((await agent(w.scout.longLived, { items: [1] })).status).toBe(401);
  });
});
