import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeCursors, encodeCursors } from "../src/chat/catchup";
import { inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { seedTenant } from "./helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

async function tool(token: string, args: Record<string, unknown>, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_catchup", arguments: args } }),
  });
  if (res.status !== 200) return { status: res.status, text: await res.text() };
  return { status: res.status, result: (await rpcBody(res)).result };
}

describe("catch-up cursor authorized-head boundary", () => {
  it("refuses explicit future cursors, preserving later messages and edits without read effects", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    for (const seq of [1, Number.MAX_SAFE_INTEGER]) {
      const r = await call(w.scout.token, "chat.catchup", { since: encodeCursors({ [ch.project_id]: seq }), advance: true });
      expect(r).toMatchObject({ status: 409, body: { error: "conflict", data: { channel: "general", head: 0 } } });
      expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    }
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout original" });
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    for (let i = 0; i < 3; i++) {
      const r = await tool(w.scout.longLived, { since: encodeCursors({ [ch.project_id]: source.head + 1 }) });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain("conflict");
      expect(r.result.content[0].text).not.toContain("Nothing new");
    }
    expect((await tool(w.scout.longLived, {})).result.structuredContent.for_you[0].msg_id).toBe(source.msg_id);
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout changed" });
    const revised = await ok(w.scout.token, "chat.catchup", { since: encodeCursors({ [ch.project_id]: source.head }) });
    expect(revised.for_you[0]).toMatchObject({ msg_id: source.msg_id, rev: 2 });
    const exact = await ok(w.scout.token, "chat.catchup", { since: encodeCursors({ [ch.project_id]: edit.head }) });
    expect(exact.for_you).toEqual([]);
    expect(decodeCursors(exact.next)[ch.project_id]).toBe(edit.head);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND identity_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id, w.scout.agent.identity.id).all();
    expect(events.results).toEqual([]);
  });

  it("validates all selected heads before any multi-channel advance and refuses legacy durable future cursors", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await channelWith(w, "ops");
    const general = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const ops = (await getChannelBySlug(env.HUB_DB, w.acme.id, "ops"))!;
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@dev pending" });
    const box = inboxStub(env, w.acme.id, w.dev.identity.id);
    const r = await call(w.dev.token, "chat.catchup", { since: encodeCursors({ [general.project_id]: 0, [ops.project_id]: 1 }), advance: true });
    expect(r).toMatchObject({ status: 409, body: { error: "conflict", data: { channel: "ops", head: 0 } } });
    expect(await box.cursors(w.acme.id, w.dev.identity.id)).toEqual({});
    // Internal fixture models a legacy watermark or restored conversation, not a public write bypass.
    await box.markRead(w.acme.id, w.dev.identity.id, ops.project_id, 99);
    const legacy = await call(w.dev.token, "chat.catchup", { advance: true });
    expect(legacy).toMatchObject({ status: 409, body: { error: "conflict", data: { channel: "ops", head: 0 } } });
    expect(await box.cursors(w.acme.id, w.dev.identity.id)).toEqual({ [ops.project_id]: 99 });
    // Selected scope validates only that channel. It must not mutate/repair the other watermark.
    const selected = await ok(w.dev.token, "chat.catchup", { scope: "general" });
    expect(selected.for_you[0].msg_id).toBe(source.msg_id);
    expect(decodeCursors(selected.next)[ops.project_id]).toBe(99);
    expect(await box.cursors(w.acme.id, w.dev.identity.id)).toEqual({ [ops.project_id]: 99 });
  });

  it("does not validate or disclose inaccessible cursor keys, including removed memberships and other tenants", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    await ok(w.lead.token, "chat.post", { c: "general", body: "private original" });
    const since = encodeCursors({ [ch.project_id]: Number.MAX_SAFE_INTEGER });
    const denied = (await tool(w.tidy.longLived, { since, scope: "general" })).result;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not_found");
    expect(denied.content[0].text).not.toContain("head");
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const revoked = (await tool(w.scout.longLived, { since, scope: "general" })).result;
    expect(revoked.content[0].text).toContain("not_found");
    expect(revoked.content[0].text).not.toContain("head");
    const unscoped = (await tool(w.scout.longLived, { since })).result.structuredContent;
    expect(decodeCursors(unscoped.next)).toEqual({});
    expect(unscoped.conversations).toEqual([]);
    expect(JSON.stringify(unscoped)).not.toContain("private original");
    await seedTenant("beta2");
    expect((await tool(w.scout.longLived, { since }, "beta2")).status).toBe(401);
  });

  it("keeps read-only OAuth principal binding and rejects future cursors without acknowledging attention", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const access = (await connectWithTokens(w.lead.token)).tokens.access_token;
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const invoke = async (args: Record<string, unknown>) => (await rpcBody(await mcpPost("acme", access, "tools/call", { name: "chat_catchup", arguments: args }))).result;
    const future = await invoke({ since: encodeCursors({ [ch.project_id]: 1 }), identity_id: w.scout.agent.identity.id });
    expect(future.isError).toBe(true);
    expect(future.content[0].text).toContain("conflict");
    const source = await ok(w.dev.token, "chat.post", { c: "general", body: "@lead original evidence" });
    const r = await invoke({ since: encodeCursors({ [ch.project_id]: 0 }), identity_id: w.scout.agent.identity.id });
    expect(r.structuredContent.for_you[0].msg_id).toBe(source.msg_id);
    expect((await invoke({ advance: true })).isError).toBe(true);
    expect(await inboxStub(env, w.acme.id, w.lead.identity.id).cursors(w.acme.id, w.lead.identity.id)).toEqual({});
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect((await ok(w.lead.token, "chat.inbox")).items).toHaveLength(1);
  });
});
