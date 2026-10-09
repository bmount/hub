import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeCursors } from "../src/chat/catchup";
import { getChannelBySlug } from "../src/db/chat";
import { inboxStub } from "../src/chat/stubs";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function agent(token: string, args: Record<string, unknown> = {}, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_catchup", arguments: args } }),
  });
  return { status: res.status, result: res.status === 200 ? (await rpcBody(res)).result : null };
}

describe("server-owned catch-up checkpoint bindings", () => {
  it("binds agent mentions, followed threads and channel cursors to the exact principal and conversation", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout source evidence, identity_id=forged" });
    await ok(w.scout.token, "chat.post", { c: "general", body: "following", reply_to: root.msg_id, after: root.head });
    await ok(w.dev.token, "chat.post", { c: "general", body: "new incoming reply", reply_to: root.msg_id });
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const args = { tenant_id: "forged", identity_id: w.lead.identity.id, conversation_id: "forged", scope: "general" };
    for (let i = 0; i < 3; i++) {
      const r = (await agent(w.scout.longLived, args)).result.structuredContent;
      expect(r).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, advanced: false });
      expect(r.for_you[0]).toMatchObject({ channel: "general", conversation_id: ch.project_id, msg_id: root.msg_id, author: { identity_id: w.lead.identity.id } });
      expect(r.threads[0].conversation_id).toBe(ch.project_id);
      expect(r.conversations[0]).toMatchObject({ channel: "general", conversation_id: ch.project_id, since: 0, head: 3 });
      expect(decodeCursors(r.next)).toEqual({ [ch.project_id]: 3 });
    }
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id).all();
    expect(events.results.map((x) => x.kind)).toEqual(["chat.post", "chat.post", "chat.post"]);
  });

  it("returns the authenticated browser or read-only OAuth principal even for empty/scoped checkpoints", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const args = { identity_id: w.scout.agent.identity.id, tenant_id: "forged", conversation_id: "forged", scope: "#general" };
    const empty = await ok(w.dev.token, "chat.catchup", args);
    expect(empty).toMatchObject({ tenant_id: w.acme.id, identity_id: w.dev.identity.id, for_you: [], conversations: [], quiet: [] });
    const connection = await connectWithTokens(w.lead.token);
    const access = connection.tokens.access_token;
    const invoke = async (a: Record<string, unknown>) => (await rpcBody(await mcpPost("acme", access, "tools/call", { name: "chat_catchup", arguments: a }))).result;
    expect((await invoke(args)).structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.lead.identity.id, for_you: [] });
    const source = await ok(w.dev.token, "chat.post", { c: "general", body: "@lead @scout request evidence" });
    const r = (await invoke(args)).structuredContent;
    expect(r.identity_id).toBe(w.lead.identity.id);
    expect(r.for_you[0]).toMatchObject({ conversation_id: ch.project_id, msg_id: source.msg_id, author: { identity_id: w.dev.identity.id, session_kind: "browser" } });
    expect(r.conversations[0].conversation_id).toBe(ch.project_id);
    expect((await invoke({ ...args, advance: true })).isError).toBe(true);
    for (const identity of [w.lead.identity.id, w.dev.identity.id, w.scout.agent.identity.id]) {
      expect(await inboxStub(env, w.acme.id, identity).cursors(w.acme.id, identity)).toEqual({});
    }
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), connection.client_id).run();
    const revoked = await mcpPost("acme", access, "tools/call", { name: "chat_catchup", arguments: args });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(ch.project_id);
  });

  it("keeps equal message numbers in separate conversations and scoped cursors bound to the reader", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await channelWith(w, "ops");
    const general = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const ops = (await getChannelBySlug(env.HUB_DB, w.acme.id, "ops"))!;
    const sources = [];
    for (const c of ["general", "ops"]) sources.push(await ok(w.lead.token, "chat.post", { c, body: `@scout ${c} original` }));
    const r = (await agent(w.scout.longLived)).result.structuredContent;
    expect(r.for_you.map((m: any) => [m.conversation_id, m.seq, m.msg_id])).toEqual([
      [general.project_id, 1, sources[0].msg_id], [ops.project_id, 1, sources[1].msg_id],
    ]);
    expect(r.conversations.map((c: any) => [c.channel, c.conversation_id])).toEqual([["general", general.project_id], ["ops", ops.project_id]]);
    expect(decodeCursors(r.next)).toEqual({ [general.project_id]: 1, [ops.project_id]: 1 });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: 1 });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: sources[0].msg_id, body: "@scout changed evidence" });
    const revised = (await agent(w.scout.longLived, { scope: "general" })).result.structuredContent;
    expect(revised.identity_id).toBe(w.scout.agent.identity.id);
    expect(revised.for_you[0]).toMatchObject({ conversation_id: general.project_id, msg_id: sources[0].msg_id, seq: 1, rev: 2 });
    expect(decodeCursors(revised.next)).toEqual({ [general.project_id]: 2 });
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [general.project_id]: 1 });
    expect(await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).cursors(w.acme.id, w.tidy.agent.identity.id)).toEqual({});
  });

  it("retains conversation binding in budget fallback without changing cap/cursor semantics", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    for (let i = 0; i < 6; i++) {
      const root = await ok(w.lead.token, "chat.post", { c: "general", body: `unfollowed root ${i} ${"x".repeat(80)}` });
      await ok(w.dev.token, "chat.post", { c: "general", body: `reply ${i}`, reply_to: root.msg_id });
    }
    const r = (await agent(w.scout.longLived, { budget: 150 })).result.structuredContent;
    expect(r).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, conversations: [], for_you: [], threads: [] });
    expect(r.quiet).toEqual([{ channel: "general", conversation_id: ch.project_id, head: 12, new: 12, agent: 0 }]);
    expect(decodeCursors(r.next)).toEqual({ [ch.project_id]: 12 });
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
  });

  it("never exposes inaccessible conversation ids or accepts a caller-selected tenant/principal", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout private original" });
    const args = { identity_id: w.scout.agent.identity.id, conversation_id: ch.project_id };
    const tidy = (await agent(w.tidy.longLived, args)).result.structuredContent;
    expect(tidy).toMatchObject({ tenant_id: w.acme.id, identity_id: w.tidy.agent.identity.id, conversations: [], for_you: [], threads: [], quiet: [] });
    expect(JSON.stringify(tidy)).not.toContain(ch.project_id);
    expect((await agent(w.tidy.longLived, { ...args, scope: "general" })).result.isError).toBe(true);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const removed = (await agent(w.scout.longLived, args)).result.structuredContent;
    expect(removed.identity_id).toBe(w.scout.agent.identity.id);
    expect(JSON.stringify(removed)).not.toContain(ch.project_id);
    await seedTenant("beta2");
    expect((await agent(w.scout.longLived, { ...args, tenant_id: w.acme.id }, "beta2")).status).toBe(401);
  });
});
