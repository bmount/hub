import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { inDO } from "./do-helper";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

const cursor = (m: any, activity_seq = m.seq) => ({ msg_id: m.msg_id, seq: m.seq, activity_seq });

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await rpcBody(response)).result;
}

describe("shown forward activity cursors, separate from context/target/global head", () => {
  it("retains final edited/retracted reply activity even with null continuation, without adopting root/target or unrelated activity", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "root context ".repeat(100) });
    const a = await ok(w.dev.token, "chat.post", { c: "general", body: "private reply", reply_to: root.seq });
    const b = await ok(w.lead.token, "chat.post", { c: "general", body: "nested target ".repeat(100), reply_to: a.seq });
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: b.seq, body: "revised source ".repeat(100) });
    const retract = await ok(w.dev.token, "chat.retract", { c: "general", msg: a.seq });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: root.seq, body: "new root context ".repeat(100) });
    const unrelated = await ok(w.lead.token, "chat.post", { c: "general", body: "unrelated newest root" });
    const args = { c: "general", msg: a.msg_id, budget: 100, activity_cursors: [cursor(root, unrelated.head)] };
    const first = (await tool(w.scout.longLived, "chat_thread", args)).structuredContent;
    expect(first).toMatchObject({ head: unrelated.head, next_after: edit.head, activity_cursors: [cursor(b, edit.head)] });
    expect(first.messages.map((m: any) => m.seq)).toEqual([root.seq, b.seq]);
    expect(first.target).toMatchObject({ msg_id: a.msg_id, body: "", retracted: true });
    const last = await ok(w.scout.token, "chat.thread", { ...args, after: first.next_after });
    expect(last.next_after).toBeNull();
    expect(last.activity_cursors).toEqual([cursor(a, retract.head)]);
    expect(last.messages[1]).toMatchObject({ body: "", retracted: true });
    expect(JSON.stringify([first, last])).not.toContain("private reply");
    const exhausted = await ok(w.scout.token, "chat.thread", { ...args, after: retract.head });
    expect(exhausted.messages.map((m: any) => m.seq)).toEqual([root.seq]);
    expect(exhausted.target.msg_id).toBe(a.msg_id);
    expect(exhausted.activity_cursors).toEqual([]);
    expect(exhausted.next_after).toBeNull();
  });

  it("exposes collapsed-root scan positions rather than root revision or reply creation, only for budget-shown forward messages", async () => {
    const w = await chatWorld(); await channelWith(w);
    const a = await ok(w.lead.token, "chat.post", { c: "general", body: "root A ".repeat(100) });
    const b = await ok(w.dev.token, "chat.post", { c: "general", body: "root B ".repeat(100) });
    const reply = await ok(w.dev.token, "chat.post", { c: "general", body: "hidden nested original", reply_to: a.seq });
    const edit = await ok(w.dev.token, "chat.edit", { c: "general", msg: reply.seq, body: "changed nested source" });
    const args = { c: "general", after: 0, budget: 100, cursors: { [a.seq]: 999 }, identity_id: w.dev.identity.id };
    const first = (await tool(w.scout.longLived, "chat_read", args)).structuredContent;
    expect(first.identity_id).toBe(w.scout.agent.identity.id);
    expect(first.messages.map((m: any) => m.seq)).toEqual([b.seq]);
    expect(first.activity_cursors).toEqual([cursor(b)]);
    expect(first.next_after).toBe(b.seq);
    const last = await ok(w.scout.token, "chat.read", { ...args, after: b.seq });
    expect(last.messages[0]).toMatchObject({ msg_id: a.msg_id, rev: 1, last_reply_seq: reply.seq });
    expect(last.activity_cursors).toEqual([cursor(a, edit.head)]);
    expect(last.next_after).toBeNull();
    expect(JSON.stringify(last)).not.toContain("changed nested source");
    // A collapsed root's scan cursor is not proof that its unshown replies were processed.
    const thread = await ok(w.scout.token, "chat.thread", { c: "general", msg: reply.msg_id });
    expect(thread.activity_cursors).toEqual([cursor(reply, edit.head)]);
    expect((await ok(w.scout.token, "chat.read", { c: "general" })).activity_cursors).toEqual([]);
    expect((await ok(w.scout.token, "chat.read", { c: "general", before: b.seq })).activity_cursors).toEqual([]);
    expect((await ok(w.scout.token, "chat.read", { c: "general", after: edit.head })).activity_cursors).toEqual([]);
  });

  it("does not expose store-omitted positions, and reconstructs ordered activity from persisted owner-bound state without writes", async () => {
    const w = await chatWorld(); await channelWith(w);
    const a = await ok(w.lead.token, "chat.post", { c: "general", body: "A" });
    const b = await ok(w.dev.token, "chat.post", { c: "general", body: "B" });
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: a.seq, body: "revised A" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    const first = await ok(w.scout.token, "chat.read", { c: "general", after: 0, limit: 1 });
    expect(first.activity_cursors).toEqual([cursor(b)]); expect(first.next_after).toBe(b.seq);
    const last = await ok(w.scout.token, "chat.read", { c: "general", after: first.next_after, limit: 1 });
    expect(last.activity_cursors).toEqual([cursor(a, edit.head)]); expect(last.next_after).toBeNull();
    await inDO(conv, async (_object, state) => {
      const fresh = new Conversation(state, env);
      const before = state.storage.sql.exec("SELECT total_changes() AS n").one().n;
      const q = { tenant_id: w.acme.id, conversation_id: ch.project_id, thread: null, after: 0, before: null, limit: 1 };
      const page = await fresh.read(q);
      expect(page.cursors).toEqual({ [b.seq]: b.seq }); expect(page.has_more).toBe(true);
      expect((await fresh.read({ ...q, after: b.seq })).cursors).toEqual({ [a.seq]: edit.head });
      await expect(fresh.read({ ...q, tenant_id: "wrong" })).rejects.toThrow("another tenant or owner");
      await expect(fresh.read({ ...q, conversation_id: "wrong" })).rejects.toThrow("another tenant or owner");
      expect(state.storage.sql.exec("SELECT total_changes() AS n").one().n).toBe(before);
    });
  });

  it("binds API/agent/read-only OAuth to current reader/channel, refuses revoked/removed/cross-tenant reads and changes no attention or cursors", async () => {
    const w = await chatWorld(); await channelWith(w); await channelWith(w, "other");
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "context" });
    const source = await ok(w.dev.token, "chat.post", { c: "general", body: "@scout source", reply_to: root.seq });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const attention = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const presence = await ok(w.lead.token, "chat.presence", { c: "general" });
    const args = { c: "general", msg: source.msg_id, identity_id: w.lead.identity.id, conversation_id: "forged", tenant_id: "forged", activity_cursors: [cursor(root, 999)] };
    for (let i = 0; i < 10; i++) {
      const r = (await tool(w.scout.longLived, "chat_thread", args)).structuredContent;
      expect(r).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, conversation_id: ch.project_id, activity_cursors: [cursor(source)] });
    }
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(attention);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(source.head);
    expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries).toEqual(presence.entries);
    const events = (await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all<{ kind: string; summary: string }>()).results;
    expect(events.filter(e => e.kind === "chat.post")).toHaveLength(0);
    expect(events.filter(e => e.kind === "mcp.call" && e.summary.startsWith("chat.thread"))).toHaveLength(10);
    expect(events.map(e => e.summary).join("\n")).not.toContain(source.msg_id);
    expect(events.map(e => e.summary).join("\n")).not.toContain("@scout source");
    const oauth = await connectWithTokens(w.lead.token, { scope: "read" });
    const r = (await rpcBody(await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args }))).result;
    expect(r.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, activity_cursors: [cursor(source)] });
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), oauth.client_id).run();
    expect((await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args })).status).toBe(401);
    expect((await call(w.scout.token, "chat.thread", { ...args, c: "other" })).status).toBe(404);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await tool(w.scout.longLived, "chat_thread", args)).structuredContent.activity_cursors).toEqual([cursor(source)]);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_thread", args);
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain(source.msg_id);
    await seedTenant("beta2");
    const cross = await SELF.fetch("https://beta2.pimwell.test/agent/mcp", { method: "POST", headers: { authorization: `Bearer ${w.scout.longLived}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_thread", arguments: args } }) });
    expect(cross.status).toBe(401); expect(await cross.text()).not.toContain(source.msg_id);
  }, 20000);
});
