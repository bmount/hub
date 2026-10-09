import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import type { PostInput } from "../src/chat/types";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { cookieHeaders, seedTenant } from "./helpers";

async function tool(token: string, args: Record<string, unknown>) {
  const response = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_thread", arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await rpcBody(response)).result;
}

describe("bounded thread activity continuation", () => {
  it("keeps root context without starving a tiny-budget page, and resumes by reply activity rather than root/creation", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "root context ".repeat(100) });
    const a = await ok(w.lead.token, "chat.post", { c: "general", body: "old reply ".repeat(100), reply_to: root.seq });
    const b = await ok(w.dev.token, "chat.post", { c: "general", body: "second reply ".repeat(100), reply_to: a.seq });
    const c = await ok(w.dev.token, "chat.post", { c: "general", body: "third reply ".repeat(100), reply_to: root.seq });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: a.seq, body: "edited reply ".repeat(100) });
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: root.seq, body: "new root context ".repeat(100) });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const attention = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const pages = [];
    let after: number | null = null;
    for (let i = 0; i < 3; i++) {
      const r = await tool(w.scout.longLived, { c: "general", msg: root.seq, budget: 100, ...(after !== null ? { after } : {}) });
      expect(r.isError).toBeUndefined();
      pages.push(r.structuredContent);
      expect(r.structuredContent.messages[0]).toMatchObject({ msg_id: root.msg_id, author: { identity_id: w.lead.identity.id, session_kind: "browser" } });
      expect(r.structuredContent.messages).toHaveLength(2);
      after = r.structuredContent.next_after;
    }
    expect(pages.map(p => p.messages[1].seq)).toEqual([b.seq, c.seq, a.seq]);
    expect(pages.map(p => p.next_after)).toEqual([b.seq, c.seq, null]);
    expect(pages[2].messages[1]).toMatchObject({ rev: 2, body: "edited reply ".repeat(100) });
    const done = await tool(w.scout.longLived, { c: "general", msg: root.seq, budget: 100, after: edit.head });
    expect(done.structuredContent.messages.map((m: { seq: number }) => m.seq)).toEqual([root.seq]);
    expect(done.structuredContent.next_after).toBeNull();
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(attention);
  });

  it("starts before the 200-reply store cap instead of silently skipping old source evidence", async () => {
    const w = await chatWorld(); await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    const base: PostInput = { tenant_id: w.acme.id, conversation_id: ch.project_id, now: Date.now(), author: { id: w.lead.identity.id, kind: "human", session_id: w.lead.session.id, session_kind: "browser" }, policy: "open", body: "root", body_sha256: "root", after: null, reply_to: null, refs: [], mentions: [], wake_hop: null, thread_wake_hops: {}, idempotency_key: null, audience: { agent_members: [], operators: {}, muted_agents: [], agents_enabled: true } };
    const root = await conv.post(base); if (root.refused) throw new Error(root.refused);
    for (let i = 1; i <= 205; i++) {
      const r = await conv.post({ ...base, now: base.now + i * 61000, body: `reply-${i}`, body_sha256: `reply-${i}`, reply_to: root.msg_id });
      expect(r.refused).toBeNull();
    }
    const first = await tool(w.scout.longLived, { c: "general", msg: root.seq, budget: 8000 });
    expect(first.structuredContent.messages.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 201 }, (_, i) => i + 1));
    expect(first.structuredContent.next_after).toBe(201);
    const last = await tool(w.scout.longLived, { c: "general", msg: root.seq, budget: 8000, after: 201 });
    expect(last.structuredContent.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 202, 203, 204, 205, 206]);
    expect(last.structuredContent.next_after).toBeNull();
  }, 20000);

  it("refuses future thread activity cursors only after current read authorization, across API/MCP/read-only OAuth", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "source" });
    const args = { c: "general", msg: root.seq, after: Number.MAX_SAFE_INTEGER, budget: 100 };
    const api = await call(w.scout.token, "chat.thread", args);
    expect(api.status).toBe(409); expect(api.body.data).toEqual({ head: root.head });
    const agent = await tool(w.scout.longLived, args);
    expect(agent.isError).toBe(true); expect(agent.content[0].text).toContain("conflict");
    const oauth = await connectWithTokens(w.dev.token, { scope: "read" });
    const r = (await rpcBody(await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args }))).result;
    expect(r.isError).toBe(true); expect(r.content[0].text).toContain("conflict");
    const permitted = (await rpcBody(await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: { ...args, after: root.head } }))).result;
    expect(permitted.structuredContent.messages.map((m: { seq: number }) => m.seq)).toEqual([root.seq]);
    expect(permitted.structuredContent.next_after).toBeNull();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE identity_id = ? AND tenant_id = ?").bind(Date.now(), w.dev.identity.id, w.acme.id).run();
    expect((await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args })).status).toBe(401);
    expect((await call(w.scout.token, "chat.thread", { ...args, msg: 999 })).status).toBe(404);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await call(w.scout.token, "chat.thread", args)).status).toBe(404);
    const denied = await tool(w.scout.longLived, args);
    expect(denied.isError).toBe(true); expect(denied.content[0].text).not.toContain("head");
    await seedTenant("other");
    const cross = await SELF.fetch("https://other.pimwell.test/agent/mcp", { method: "POST", headers: { authorization: `Bearer ${w.scout.longLived}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "chat_thread", arguments: args } }) });
    expect(cross.status).toBe(401);
    expect(await cross.text()).not.toContain(root.msg_id);
  });

  it("continues body-free retractions, preserves root-first browser compatibility and never treats context as processed activity", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "private original root" });
    const a = await ok(w.dev.token, "chat.post", { c: "general", body: "private original reply", reply_to: root.seq });
    const b = await ok(w.dev.token, "chat.post", { c: "general", body: "surviving reply ".repeat(100), reply_to: root.seq });
    const withdrawal = await ok(w.dev.token, "chat.retract", { c: "general", msg: a.seq });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: root.seq });
    const first = await ok(w.lead.token, "chat.thread", { c: "general", msg: root.msg_id, budget: 100, after: root.seq });
    expect(first.messages.map((m: { seq: number }) => m.seq)).toEqual([root.seq, b.seq]);
    expect(first.messages[0]).toMatchObject({ body: "", retracted: true });
    expect(first.next_after).toBe(b.seq);
    const second = await ok(w.lead.token, "chat.thread", { c: "general", msg: root.seq, budget: 100, after: first.next_after });
    expect(second.messages.map((m: { seq: number }) => m.seq)).toEqual([root.seq, a.seq]);
    expect(second.messages[1]).toMatchObject({ body: "", retracted: true, rev: 2 });
    expect(second.next_after).toBeNull();
    expect(JSON.stringify([first, second])).not.toContain("private original");
    const page = await SELF.fetch(`https://acme.pimwell.test/c/general/t/${root.seq}?after=${b.seq}`, { headers: cookieHeaders(w.lead.token, "acme.pimwell.test") });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Original message"); expect(html).toContain("Replies (continued)");
    expect(html).not.toContain("private original");
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.lead.identity.id);
    expect(await box.cursors(w.acme.id, w.lead.identity.id)).toEqual({});
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(withdrawal.head + 1);
  });
});
