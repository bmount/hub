import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getChannelBySlug } from "../src/db/chat";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(r.status).toBe(200);
  return (await rpcBody(r)).result;
}

// Combined local product acceptance, not operator persistence/process restart/live primary execution.
describe("integrated bounded chat reconciliation", () => {
  it("finds a nested original, reconciles a lost ordinary send, and inspects actual revision actors without resending", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "Long root context ".repeat(100) });
    const firstReply = await ok(w.dev.token, "chat.post", { c: "general", reply_to: root.seq, body: "Other member input ".repeat(100) });
    const source = await ok(w.lead.token, "chat.post", { c: "general", reply_to: firstReply.seq, body: "@scout nested original product input ".repeat(100) });
    const pointer = (await tool(w.scout.longLived, "chat_inbox", {})).structuredContent.items[0];
    expect(pointer).toMatchObject({ msg_id: source.msg_id, author_id: w.lead.identity.id });
    const page = (await tool(w.scout.longLived, "chat_thread", { c: pointer.channel, msg: pointer.msg_id, budget: 100 })).structuredContent;
    expect(page).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, conversation_id: pointer.conversation_id, next_after: firstReply.seq });
    expect(page.messages.map((m: any) => m.msg_id)).toEqual([root.msg_id, firstReply.msg_id]);
    const next = (await tool(w.scout.longLived, "chat_thread", { c: pointer.channel, msg: pointer.msg_id, budget: 100, after: page.next_after })).structuredContent;
    expect(next.messages.map((m: any) => m.msg_id)).toEqual([root.msg_id, source.msg_id]);
    expect(next.messages[1]).toMatchObject({ root_seq: root.seq, rev: 1, author: { identity_id: pointer.author_id, kind: "human", session_kind: "browser" } });
    expect(next.next_after).toBeNull();
    const intent = { body: "Original ordinary response, not execution proof", reply_to: source.msg_id };
    const key = "retained-ordinary-intent";
    const posted = (await tool(w.scout.longLived, "chat_post", { c: pointer.channel, ...intent, after: next.head, idempotency_key: key })).structuredContent;
    expect(posted.msg_id).toBeTruthy();
    // Simulate an interrupted outcome with its exact retained intent; never guess a payload/new key.
    const recovered = (await tool(w.scout.longLived, "chat_post_status", { c: pointer.channel, idempotency_key: key, intent })).structuredContent;
    expect(recovered).toMatchObject({ tenant_id: page.tenant_id, identity_id: page.identity_id, conversation_id: page.conversation_id, record: { committed: { msg_id: posted.msg_id, rev: 1 } }, intent_check: { matches: true, reason: "match" } });
    // An ordinary reply does not occupy a durable slot. Null is not permission to send again.
    expect((await tool(w.scout.longLived, "chat_response_status", { c: pointer.channel, msg: source.msg_id })).structuredContent.result).toBeNull();
    expect((await tool(w.scout.longLived, "chat_post_status", { c: pointer.channel, idempotency_key: key, intent: { ...intent, reply_to: source.seq } })).structuredContent.intent_check.matches).toBe(false);
    await ok(w.scout.token, "chat.edit", { c: pointer.channel, msg: posted.msg_id, body: "Later revised response", after: posted.head });
    await ok(w.lead.token, "chat.retract", { c: pointer.channel, msg: posted.msg_id });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, pointer.channel))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const attention = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const history = (await tool(w.scout.longLived, "chat_history", { c: pointer.channel, msg: posted.msg_id })).structuredContent;
    expect(history).toMatchObject({ identity_id: page.identity_id, conversation_id: page.conversation_id, current: { rev: 3, author_id: w.scout.agent.identity.id, retracted: true }, has_more: true, next_after_rev: 2 });
    expect(history.versions.map((v: any) => v.author.identity_id)).toEqual([w.scout.agent.identity.id, w.scout.agent.identity.id]);
    const last = (await tool(w.scout.longLived, "chat_history", { c: pointer.channel, msg: posted.msg_id, after_rev: history.next_after_rev })).structuredContent;
    expect(last).toMatchObject({ has_more: false, next_after_rev: null, versions: [{ rev: 3, body: "", retracted: true, author: { identity_id: w.lead.identity.id, session_kind: "browser" } }] });
    for (let i = 0; i < 3; i++) {
      const status = (await tool(w.scout.longLived, "chat_post_status", { c: pointer.channel, idempotency_key: key, intent })).structuredContent;
      expect(status).toMatchObject({ head: 6, record: { committed: recovered.record.committed, current: { rev: 3, retracted: true }, expires_at: recovered.record.expires_at }, intent_check: { matches: true } });
      const current = (await tool(w.scout.longLived, "chat_thread", { c: pointer.channel, msg: posted.msg_id, after: 3, budget: 100 })).structuredContent;
      expect(current).toMatchObject({ identity_id: page.identity_id, next_after: null, messages: [{ msg_id: root.msg_id }, { msg_id: posted.msg_id, body: "", retracted: true, response_to: null }] });
    }
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(6);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(attention);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND identity_id = ? AND kind = 'chat.post'").bind(w.acme.id, w.scout.agent.identity.id).all();
    expect(events.results).toHaveLength(1);
    await ok(w.lead.token, "channel.remove_agent", { c: pointer.channel, agent: "scout" });
    for (const [name, args] of [["chat_thread", { msg: source.msg_id }], ["chat_history", { msg: posted.msg_id }], ["chat_post_status", { idempotency_key: key, intent }]] as const) {
      const denied = await tool(w.scout.longLived, name, { c: pointer.channel, ...args });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toBeUndefined();
    }
  });

  it("refuses future channel-read checkpoints without pretending the evidence range is empty or acknowledging it", async () => {
    const w = await chatWorld(); await channelWith(w);
    const oauth = await connectWithTokens(w.dev.token, { scope: "read" });
    const args = { c: "general", after: Number.MAX_SAFE_INTEGER, identity_id: w.lead.identity.id, head: Number.MAX_SAFE_INTEGER };
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    for (let i = 0; i < 3; i++) {
      const api = await call(w.dev.token, "chat.read", args);
      expect(api).toMatchObject({ status: 409, body: { error: "conflict", data: { head: 0 } } });
      const agent = await tool(w.scout.longLived, "chat_read", args);
      expect(agent.isError).toBe(true);
      expect(agent.structuredContent).toBeUndefined();
      const human = (await rpcBody(await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_read", arguments: args }))).result;
      expect(human.isError).toBe(true);
      expect(human.structuredContent).toBeUndefined();
    }
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    const exactEmpty = (await tool(w.scout.longLived, "chat_read", { c: "general", after: 0 })).structuredContent;
    expect(exactEmpty).toMatchObject({ identity_id: w.scout.agent.identity.id, head: 0, messages: [] });
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "Native source remains discoverable @scout" });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "Current native revision @scout", after: source.head });
    const changed = (await tool(w.scout.longLived, "chat_read", { c: "general", after: source.seq })).structuredContent;
    expect(changed).toMatchObject({ head: 2, identity_id: exactEmpty.identity_id, messages: [{ msg_id: source.msg_id, rev: 2, author: { identity_id: w.lead.identity.id, session_kind: "browser" } }] });
    expect((await call(w.dev.token, "chat.read", { c: "general", after: 3 })).body).toMatchObject({ error: "conflict", data: { head: 2 } });
    expect((await tool(w.scout.longLived, "chat_read", { c: "general", after: changed.head })).structuredContent.messages).toEqual([]);
    await channelWith(w, "other");
    expect((await call(w.dev.token, "chat.read", { c: "other", after: changed.head })).body).toMatchObject({ error: "conflict", data: { head: 0 } });
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_read", args);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toBeUndefined();
    expect(JSON.stringify(denied)).not.toContain("current channel head");
    expect((await call(w.dev.token, "chat.read", { c: "missing", after: 3 })).body.data?.head).toBeUndefined();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), oauth.client_id).run();
    expect((await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_read", arguments: args })).status).toBe(401);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
  });

  it("binds empty reads and thread pages to the current reader, not forged author/connection fields", async () => {
    const w = await chatWorld(); await channelWith(w);
    const oauth = await connectWithTokens(w.dev.token, { scope: "read" });
    const forged = { c: "general", identity_id: w.lead.identity.id, tenant_id: "forged", conversation_id: "forged" };
    const empty = (await tool(w.scout.longLived, "chat_read", forged)).structuredContent;
    expect(empty).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, messages: [], head: 0 });
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "Native member source" });
    for (const name of ["chat_read", "chat_thread"] as const) {
      const args = { ...forged, msg: source.msg_id };
      const agent = (await tool(w.scout.longLived, name, args)).structuredContent;
      expect(agent).toMatchObject({ identity_id: w.scout.agent.identity.id, conversation_id: empty.conversation_id, messages: [{ author: { identity_id: w.lead.identity.id } }] });
      const human = (await rpcBody(await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name, arguments: args }))).result.structuredContent;
      expect(human).toMatchObject({ tenant_id: w.acme.id, identity_id: w.dev.identity.id, conversation_id: empty.conversation_id, messages: [{ author: { identity_id: w.lead.identity.id } }] });
    }
    expect((await ok(w.dev.token, "chat.read", forged)).identity_id).toBe(w.dev.identity.id);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), oauth.client_id).run();
    expect((await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: { c: "general", msg: source.msg_id } })).status).toBe(401);
    expect(await inboxStub(env, w.acme.id, w.dev.identity.id).cursors(w.acme.id, w.dev.identity.id)).toEqual({});
  });
});
