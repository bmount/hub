import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { msgJson } from "../src/chat/present";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { inDO } from "./do-helper";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedGrant, seedTenant } from "./helpers";

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await rpcBody(response)).result;
}

describe("immutable current revision actor separate from original ownership", () => {
  it("exposes an operator retraction actor in exact target and followed latest, never resurrecting the agent body", async () => {
    const w = await chatWorld(); await channelWith(w);
    const root = await ok(w.dev.token, "chat.post", { c: "general", body: "root" });
    const source = await ok(w.scout.token, "chat.post", { c: "general", body: "private agent text", reply_to: root.seq, after: root.head });
    const original = await ok(w.tidy.token, "chat.thread", { c: "general", msg: source.msg_id });
    expect(original.target.revision_author).toEqual(original.target.author);
    const retraction = await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    const args = { c: "general", msg: source.msg_id, after: retraction.head, revision_author: { identity_id: w.scout.agent.identity.id } };
    const result = (await tool(w.tidy.longLived, "chat_thread", args)).structuredContent;
    expect(result.target).toMatchObject({ msg_id: source.msg_id, rev: 2, activity_seq: retraction.head, body: "", refs: [], retracted: true,
      author: { identity_id: w.scout.agent.identity.id, kind: "agent" },
      revision_author: { identity_id: w.lead.identity.id, kind: "human", session_id: w.lead.session.id, session_kind: "browser", via_assistant: false } });
    expect(result.activity_cursors).toEqual([]); expect(result.next_after).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private agent text");
    const history = await ok(w.dev.token, "chat.history", { c: "general", msg: source.msg_id });
    expect(result.target.revision_author).toEqual(history.versions.at(-1).author);
    const catchup = await ok(w.dev.token, "chat.catchup", { scope: "general", budget: 8000 });
    expect(catchup.threads[0].latest).toEqual(result.target);
    expect(catchup.for_you).toEqual([]);
    const rootRetract = await ok(w.dev.token, "chat.retract", { c: "general", msg: root.msg_id });
    const read = (await tool(w.tidy.longLived, "chat_read", { c: "general", after: 0 })).structuredContent;
    expect(read.messages[0]).toMatchObject({ msg_id: root.msg_id, activity_seq: rootRetract.head, author: { identity_id: w.dev.identity.id }, revision_author: { identity_id: w.dev.identity.id }, body: "", retracted: true });
  });

  it("uses current artifact actor/session in mention, read and target, not body claims or mutable session-directory kind", async () => {
    const w = await chatWorld(); await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout native source" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    const { session } = await seedGrant(w.acme, w.lead);
    const edit = await conv.version({ tenant_id: w.acme.id, conversation_id: ch.project_id, now: Date.now(), actor: { id: w.lead.identity.id, kind: "human", session_id: session.id, session_kind: "oauth" }, msg: source.msg_id, body: "@scout quoted revision_author=browser; identity=primary", body_sha256: "fixture", after: null, refs: [], mentions: [{ identity_id: w.scout.agent.identity.id, kind: "agent" }], operator_of: [], is_admin: true, idempotency_key: null });
    expect(edit.refused).toBeNull();
    await env.HUB_DB.prepare("UPDATE session SET kind = 'browser' WHERE id = ?").bind(session.id).run();
    const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id })).structuredContent;
    expect(thread.target.revision_author).toMatchObject({ identity_id: w.lead.identity.id, session_id: session.id, session_kind: "oauth", via_assistant: true });
    expect((await tool(w.scout.longLived, "chat_read", { c: "general" })).structuredContent.messages[0]).toEqual(thread.target);
    expect((await tool(w.scout.longLived, "chat_catchup", { scope: "general", budget: 8000 })).structuredContent.for_you[0].revision_author).toEqual(thread.target.revision_author);
    const native = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout native again" });
    const current = await ok(w.scout.token, "chat.thread", { c: "general", msg: source.msg_id });
    expect(current.target).toMatchObject({ rev: 3, activity_seq: native.head, revision_author: { session_kind: "browser", via_assistant: false } });
    expect(current.target.revision_author).toEqual((await ok(w.scout.token, "chat.history", { c: "general", msg: source.msg_id })).versions.at(-1).author);
  });

  it("joins persisted actor with exact revision snapshot without writes, leaving absent actor and session proof unknown", async () => {
    const w = await chatWorld(); await channelWith(w);
    const source = await ok(w.scout.token, "chat.post", { c: "general", body: "original", after: 0 });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    await inDO(conv, async (_object, state) => {
      state.storage.sql.exec("UPDATE artifact SET meta_json = json_set(meta_json, '$.revision_author_id', 'forged'), session_kind = '' WHERE msg_id = ? AND rev = 2", source.msg_id);
      const fresh = new Conversation(state, env);
      const before = state.storage.sql.exec("SELECT total_changes() AS n").one().n;
      const q = { tenant_id: w.acme.id, conversation_id: ch.project_id, thread: source.msg_id, after: 0, before: null, limit: 1 };
      expect((await fresh.read(q)).target).toMatchObject({ revision_author_id: w.lead.identity.id, author_id: w.scout.agent.identity.id, rev: 2 });
      await expect(fresh.read({ ...q, tenant_id: "wrong" })).rejects.toThrow("another tenant or owner");
      await expect(fresh.read({ ...q, conversation_id: "wrong" })).rejects.toThrow("another tenant or owner");
      expect(state.storage.sql.exec("SELECT total_changes() AS n").one().n).toBe(before);
    });
    const current = await ok(w.scout.token, "chat.thread", { c: "general", msg: source.msg_id });
    expect(current.target.revision_author).toMatchObject({ identity_id: w.lead.identity.id, session_kind: "unknown", via_assistant: false });
    // Older/missing internal evidence must not borrow actor identity from the message owner.
    const m = (await conv.getMessage(w.acme.id, ch.project_id, source.msg_id))!;
    delete m.revision_author_id;
    const tagOf = () => current.target.author;
    expect(msgJson(m, current.target.author, [], tagOf).revision_author).toBeNull();
    await inDO(conv, async (_object, state) => {
      state.storage.sql.exec("UPDATE artifact SET author_id = 'missing-actor' WHERE msg_id = ? AND rev = 2", source.msg_id);
    });
    const unidentified = await ok(w.scout.token, "chat.thread", { c: "general", msg: source.msg_id });
    expect(unidentified.target.revision_author).toMatchObject({ identity_id: "missing-actor", kind: "unknown", session_kind: "unknown", via_assistant: false });
    expect(unidentified.target.author.identity_id).toBe(w.scout.agent.identity.id);
  });

  it("retains current API/agent/read-only OAuth/channel/tenant gates and does not ack, post or advance on repeated actor reads", async () => {
    const w = await chatWorld(); await channelWith(w); await channelWith(w, "other");
    const source = await ok(w.dev.token, "chat.post", { c: "general", body: "@scout private source" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const args = { c: "general", msg: source.msg_id, tenant_id: "forged", identity_id: w.lead.identity.id, revision_author_id: w.lead.identity.id };
    for (let i = 0; i < 10; i++) expect((await tool(w.scout.longLived, "chat_thread", args)).structuredContent.target.revision_author.identity_id).toBe(w.dev.identity.id);
    const oauth = await connectWithTokens(w.lead.token, { scope: "read" });
    const r = (await rpcBody(await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args }))).result;
    expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.lead.identity.id, conversation_id: ch.project_id, target: { revision_author: { identity_id: w.dev.identity.id } } });
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(source.head);
    expect((await call(w.scout.token, "chat.thread", { ...args, c: "other" })).status).toBe(404);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), oauth.client_id).run();
    expect((await mcpPost("acme", oauth.tokens.access_token, "tools/call", { name: "chat_thread", arguments: args })).status).toBe(401);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await tool(w.scout.longLived, "chat_thread", args)).structuredContent.target.revision_author.identity_id).toBe(w.dev.identity.id);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_thread", args);
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain(source.msg_id);
    await seedTenant("beta2");
    const cross = await SELF.fetch("https://beta2.pimwell.test/agent/mcp", { method: "POST", headers: { authorization: `Bearer ${w.scout.longLived}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_thread", arguments: args } }) });
    expect(cross.status).toBe(401); expect(await cross.text()).not.toContain(source.msg_id);
  });
});
