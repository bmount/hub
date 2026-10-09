import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function agent(token: string, args: Record<string, unknown>, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_read_status", arguments: args } }),
  });
  return { status: res.status, result: res.status === 200 ? (await rpcBody(res)).result : null };
}

describe("read-only saved channel cursor reconciliation", () => {
  it("reconciles an ambiguous mark-read outcome without replay, acknowledgements or processing claims", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect(await ok(w.scout.token, "chat.read_status", { c: "general" })).toMatchObject({
      tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, conversation_id: ch.project_id,
      channel: "general", head: 0, read_seq: null, ahead_of_head: false,
    });
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: 0 });
    expect((await ok(w.scout.token, "chat.read_status", { c: "general" })).read_seq).toBe(0);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout @tidy original evidence" });
    await ok(w.scout.token, "chat.thread", { c: "general", msg: source.msg_id });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: source.head }); // Imagine this response was lost.
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout revised evidence" });
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    for (let n = 0; n < 10; n++) {
      const r = (await agent(w.scout.longLived, { c: "general", identity_id: w.tidy.agent.identity.id, tenant_id: "forged", conversation_id: "forged", head: 999, seq: 999 })).result;
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id,
        conversation_id: ch.project_id, channel: "general", head: edit.head, read_seq: source.head, ahead_of_head: false });
      expect(Object.keys(r.structuredContent)).toEqual(["tenant_id", "identity_id", "conversation_id", "channel", "head", "read_seq", "ahead_of_head", "text"]);
      expect(r.content[0].text).toContain("not processing or execution proof");
      expect(JSON.stringify(r)).not.toContain(source.msg_id);
      expect(JSON.stringify(r)).not.toContain("revised evidence");
    }
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [ch.project_id]: source.head });
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect((await ok(w.scout.token, "chat.catchup")).for_you[0].rev).toBe(2);
    expect((await ok(w.tidy.token, "chat.read_status", { c: "general" })).read_seq).toBeNull();
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id).all();
    expect(events.results.map(x => x.kind)).toEqual(["chat.post"]);
    const audits = await env.HUB_DB.prepare("SELECT summary FROM event WHERE tenant_id = ? AND target_id = 'chat.read_status' AND kind = 'mcp.call'").bind(w.acme.id).all<{ summary: string }>();
    expect(audits.results).toHaveLength(10);
    expect(audits.results.every(x => x.summary === "chat.read_status ok {c, +5 other}")).toBe(true);
  });

  it("reports an out-of-head legacy cursor without repairing it or hiding unrelated channel state", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    await channelWith(w, "other");
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    await box.markRead(w.acme.id, w.scout.agent.identity.id, ch.project_id, 100); // Legacy/restore fixture, not public permission.
    for (let n = 0; n < 3; n++) {
      expect(await ok(w.scout.token, "chat.read_status", { c: "general" })).toMatchObject({ head: 0, read_seq: 100, ahead_of_head: true });
      expect(await ok(w.scout.token, "chat.read_status", { c: "other" })).toMatchObject({ head: 0, read_seq: null, ahead_of_head: false });
    }
    expect((await call(w.scout.token, "chat.catchup")).status).toBe(409);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [ch.project_id]: 100 });
    expect((await ok(w.scout.token, "chat.catchup", { since: "c1.e30" })).advanced).toBe(false);
  });

  it("reauthorizes the selected channel and never discloses removed or cross-tenant state", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout private source" });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: 1 });
    expect((await call(w.tidy.token, "chat.read_status", { c: "general" })).status).toBe(404);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = (await agent(w.scout.longLived, { c: "general" })).result;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not_found");
    expect(denied.structuredContent).toBeUndefined();
    expect(denied.content[0].text).not.toContain("head");
    await seedTenant("beta2");
    expect((await agent(w.scout.longLived, { c: "general" }, "beta2")).status).toBe(401);
    expect((await call(w.scout.token, "chat.read_status", {})).status).toBe(400);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).run();
    expect((await agent(w.scout.longLived, { c: "general" })).status).toBe(401);
  });

  it("allows read-only OAuth only for its human principal, including current archived-channel read access", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: "@lead @scout independent readers" });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: 1 });
    const reader = await connectWithTokens(w.lead.token);
    const invoke = (name = "chat_read_status") => mcpPost("acme", reader.tokens.access_token, "tools/call", { name, arguments: { c: "general", identity_id: w.scout.agent.identity.id, seq: 1 } });
    const r = (await rpcBody(await invoke())).result;
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, read_seq: null, head: 1 });
    expect((await rpcBody(await invoke("chat_mark_read"))).result.isError).toBe(true);
    await ok(w.lead.token, "chat.mark_read", { c: "general", seq: 0 });
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await rpcBody(await invoke())).result.structuredContent).toMatchObject({ read_seq: 0, head: 1 });
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), reader.client_id).run();
    expect((await invoke()).status).toBe(401);
  });
});
