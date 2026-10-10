import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { inDO } from "./do-helper";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await rpcBody(response)).result;
}

describe("exact current message artifact activity, not a thread scan/processed cursor", () => {
  it("binds edited mentions and followed latest text to original ids and actual revision activity, not the newest channel head", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout root" });
    const reply = await ok(w.dev.token, "chat.post", { c: "general", body: "@scout original reply", reply_to: root.seq });
    await ok(w.scout.token, "chat.post", { c: "general", body: "Following this synthetic thread", reply_to: root.seq, after: reply.head });
    const edit = await ok(w.dev.token, "chat.edit", { c: "general", msg: reply.seq, body: "@scout revised reply; activity_seq=999" });
    const later = await ok(w.lead.token, "chat.post", { c: "general", body: "unrelated newer root" });
    const args = { scope: "general", budget: 8000, activity_seq: 999, identity_id: w.dev.identity.id };
    const catchup = (await tool(w.scout.longLived, "chat_catchup", args)).structuredContent;
    expect(catchup).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id });
    expect(catchup.for_you.map((m: any) => [m.msg_id, m.seq, m.rev, m.activity_seq])).toEqual([
      [root.msg_id, root.seq, 1, root.seq], [reply.msg_id, reply.seq, 2, edit.head],
    ]);
    expect(catchup.threads[0]).toMatchObject({ root_seq: root.seq, latest_activity_seq: edit.head,
      latest: { msg_id: reply.msg_id, seq: reply.seq, rev: 2, activity_seq: edit.head } });
    const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: reply.msg_id, after: edit.head, activity_seq: 999 })).structuredContent;
    expect(thread).toMatchObject({ head: later.head, activity_cursors: [], next_after: null,
      target: { msg_id: reply.msg_id, activity_seq: edit.head, author: { identity_id: w.dev.identity.id } } });
    expect(thread.messages[0]).toMatchObject({ msg_id: root.msg_id, activity_seq: root.seq });
    const { channel: _channel, conversation_id: _conversation, ...mention } = catchup.for_you[1];
    expect(thread.target).toEqual(mention);
    const history = await ok(w.scout.token, "chat.history", { c: "general", msg: reply.seq });
    expect(history.versions.at(-1).seq).toBe(thread.target.activity_seq);
    expect((await tool(w.scout.longLived, "chat_catchup", args)).structuredContent).toEqual(catchup);
  });

  it("keeps root artifact activity distinct from whole-thread ordering and preserves body-free retraction activity", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "root context" });
    const reply = await ok(w.dev.token, "chat.post", { c: "general", body: "private reply", reply_to: root.seq });
    const rootEdit = await ok(w.lead.token, "chat.edit", { c: "general", msg: root.seq, body: "revised root" });
    const retract = await ok(w.dev.token, "chat.retract", { c: "general", msg: reply.seq });
    const forward = await ok(w.scout.token, "chat.read", { c: "general", after: 0 });
    expect(forward.messages[0]).toMatchObject({ seq: root.seq, rev: 2, activity_seq: rootEdit.head });
    expect(forward.activity_cursors).toEqual([{ msg_id: root.msg_id, seq: root.seq, activity_seq: retract.head }]);
    const newest = (await tool(w.scout.longLived, "chat_read", { c: "general" })).structuredContent;
    expect(newest.messages[0]).toEqual(forward.messages[0]); expect(newest.activity_cursors).toEqual([]);
    const thread = await ok(w.scout.token, "chat.thread", { c: "general", msg: reply.seq, after: retract.head });
    expect(thread.target).toMatchObject({ seq: reply.seq, rev: 2, activity_seq: retract.head, body: "", retracted: true, refs: [] });
    expect(thread.activity_cursors).toEqual([]); expect(thread.next_after).toBeNull();
    expect(JSON.stringify([forward, newest, thread])).not.toContain("private reply");
    expect((await ok(w.scout.token, "chat.history", { c: "general", msg: reply.seq })).versions.at(-1).seq).toBe(retract.head);
  });

  it("reads persisted artifact sequence in a fresh owner-bound object, ignoring metadata claims and leaving unknown provenance unknown", async () => {
    const w = await chatWorld(); await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "original" });
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.seq, body: "changed" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    await inDO(conv, async (_object, state) => {
      state.storage.sql.exec("UPDATE artifact SET meta_json = json_set(meta_json, '$.activity_seq', 999), session_kind = '' WHERE msg_id = ?", source.msg_id);
      const fresh = new Conversation(state, env);
      const before = state.storage.sql.exec("SELECT total_changes() AS n").one().n;
      const q = { tenant_id: w.acme.id, conversation_id: ch.project_id, thread: source.msg_id, after: edit.head, before: null, limit: 1 };
      const page = await fresh.read(q);
      expect(page.target).toMatchObject({ seq: source.seq, activity_seq: edit.head, rev: 2 });
      expect((await fresh.digest({ tenant_id: w.acme.id, conversation_id: ch.project_id, since: 0, me: w.scout.agent.identity.id, max_items: 20 })).head).toBe(edit.head);
      await expect(fresh.read({ ...q, tenant_id: "wrong" })).rejects.toThrow("another tenant or owner");
      await expect(fresh.read({ ...q, conversation_id: "wrong" })).rejects.toThrow("another tenant or owner");
      expect(state.storage.sql.exec("SELECT total_changes() AS n").one().n).toBe(before);
    });
    const r = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id })).structuredContent;
    expect(r.target).toMatchObject({ activity_seq: edit.head, author: { session_kind: "unknown", via_assistant: false } });
  });

  it("respects API/agent/read-only OAuth and current channel/tenant boundaries without acknowledgements, cursor changes or posts", async () => {
    const w = await chatWorld(); await channelWith(w); await channelWith(w, "other");
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout private source" });
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.seq, body: "@scout revised source" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const args = { c: "general", msg: source.msg_id, tenant_id: "forged", conversation_id: "forged", activity_seq: 999 };
    for (let i = 0; i < 10; i++) expect((await tool(w.scout.longLived, "chat_thread", args)).structuredContent.target.activity_seq).toBe(edit.head);
    const oauth = await connectWithTokens(w.lead.token, { scope: "read" });
    const r = (await rpcBody(await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args }))).result;
    expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.lead.identity.id, conversation_id: ch.project_id, target: { activity_seq: edit.head } });
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(edit.head);
    expect((await call(w.scout.token, "chat.thread", { ...args, c: "other" })).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), oauth.client_id).run();
    expect((await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args })).status).toBe(401);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await tool(w.scout.longLived, "chat_thread", args)).structuredContent.target.activity_seq).toBe(edit.head);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_thread", args);
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain(source.msg_id);
    await seedTenant("beta2");
    const cross = await SELF.fetch("https://beta2.pimwell.test/agent/mcp", { method: "POST", headers: { authorization: `Bearer ${w.scout.longLived}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_thread", arguments: args } }) });
    expect(cross.status).toBe(401); expect(await cross.text()).not.toContain(source.msg_id);
  });
});
