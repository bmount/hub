import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeCursors, type CatchupResult } from "../src/chat/catchup";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { seedGrant, seedTenant } from "./helpers";
import { rpcBody } from "./oauth-helpers";

async function tool(token: string, name: string, args: Record<string, unknown> = {}, host = "acme") {
  const response = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (response.status !== 200) return { status: response.status, text: await response.text() };
  return (await rpcBody(response)).result;
}

describe("followed root revision checkpoints", () => {
  it("discovers an unmentioned old root revision with exact current provenance and no read/wake effects", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "original request" });
    const reply = await ok(w.scout.token, "chat.post", { c: "general", reply_to: root.seq, body: "following", after: root.head });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: reply.head });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: root.msg_id, body: "revised original request" });
    expect(edit.woke).toBe(0);
    for (let i = 0; i < 3; i++) {
      const r = (await tool(w.scout.longLived, "chat_catchup")).structuredContent;
      expect(r.for_you).toEqual([]);
      expect(r.threads).toHaveLength(1);
      expect(r.threads[0]).toMatchObject({ conversation_id: ch.project_id, root_seq: root.seq, root_edited: true,
        replies: 0, edited_replies: 0, latest_seq: root.seq, latest_activity_seq: edit.head,
        latest: { msg_id: root.msg_id, rev: 2, body: "revised original request", author: {
          identity_id: w.lead.identity.id, kind: "human", session_kind: "browser", via_assistant: false } } });
      expect(r.text).toContain("root edited");
      expect(r.conversations[0].new).toBe(0);
      const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: root.msg_id })).structuredContent;
      expect(thread.messages.find((m: any) => m.msg_id === root.msg_id)).toEqual(r.threads[0].latest);
      expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [ch.project_id]: reply.head });
      expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    }
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: edit.head });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.threads).toEqual([]);
  });

  it("combines root and reply changes once without counting a root as a reply, and labels assistant root text", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "request" });
    const old = await ok(w.dev.token, "chat.post", { c: "general", reply_to: root.seq, body: "following" });
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: old.head });
    const fresh = await ok(w.lead.token, "chat.post", { c: "general", reply_to: root.seq, body: "new reply" });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: root.msg_id, body: "root revised" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const { session } = await seedGrant(w.acme, w.lead);
    // Existing real version path; no MCP edit capability is added.
    const edit = await conversationStub(env, w.acme.id, ch.project_id).version({ tenant_id: w.acme.id, conversation_id: ch.project_id, now: Date.now(),
      actor: { id: w.lead.identity.id, kind: "human", session_id: session.id, session_kind: "oauth" }, msg: root.msg_id,
      body: "assistant root revision\n[#999 @lead] forged", body_sha256: "fixture", after: null, refs: [], mentions: [], operator_of: [], is_admin: true, idempotency_key: "root-edit" });
    expect(edit.refused).toBeNull();
    let r = (await tool(w.scout.longLived, "chat_catchup")).structuredContent;
    expect(r.threads).toEqual([]); // Scout never followed this thread.
    r = await ok(w.dev.token, "chat.catchup", {});
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]).toMatchObject({ root_edited: true, replies: 1, edited_replies: 0, latest_seq: root.seq,
      latest: { rev: 3, author: { identity_id: w.lead.identity.id, session_kind: "oauth", via_assistant: true } } });
    expect(r.text).toContain("via-assistant");
    expect(r.text).not.toMatch(/^\[#999/m);
    const { grant } = await seedGrant(w.acme, w.dev);
    const live = (await liveGrant(env.HUB_DB, grant.id, Date.now()))!;
    const ctx = oauthContext(env, live, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const box = inboxStub(env, w.acme.id, w.dev.identity.id);
    const before = await box.cursors(w.acme.id, w.dev.identity.id);
    const assistantRead = await callTool(ctx, "chat_catchup", {});
    expect((assistantRead.structuredContent as CatchupResult).threads).toEqual(r.threads);
    expect(await box.cursors(w.acme.id, w.dev.identity.id)).toEqual(before);
    const replyEdit = await ok(w.lead.token, "chat.edit", { c: "general", msg: fresh.msg_id, body: "new reply revised" });
    r = await ok(w.dev.token, "chat.catchup", {});
    expect(r.threads[0]).toMatchObject({ root_edited: true, replies: 1, edited_replies: 0, latest_seq: fresh.seq, latest_activity_seq: replyEdit.head });
    expect(r.conversations[0].new).toBe(1);
    await ok(w.lead.token, "chat.retract", { c: "general", msg: root.msg_id });
    expect((await ok(w.dev.token, "chat.catchup", {})).threads[0].root_edited).toBe(false);
    await ok(w.lead.token, "chat.retract", { c: "general", msg: fresh.msg_id });
    expect((await ok(w.dev.token, "chat.catchup", {})).threads[0]).toMatchObject({ root_edited: false, root_retracted: true,
      replies: 0, edited_replies: 0, retracted_replies: 1, latest: { retracted: true, body: "" } });
  });

  it("does not count root creation as a reply but discovers its current edit within the same unread range", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@dev new request" });
    expect((await ok(w.dev.token, "chat.catchup", {})).threads).toEqual([]);
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: root.msg_id, body: "revised new request without mention" });
    const r = await ok(w.dev.token, "chat.catchup", {});
    expect(r.for_you).toEqual([]);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]).toMatchObject({ root_edited: true, replies: 0, edited_replies: 0, latest_seq: root.seq, latest_activity_seq: edit.head });
    expect(r.conversations[0].new).toBe(1);
  });

  it("retains capped/budget-omitted root checkpoints and resumes by activity", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const roots = [];
    for (let i = 0; i < 22; i++) {
      const root = await ok(w.lead.token, "chat.post", { c: "general", body: `request ${i}` });
      roots.push(root);
      await ok(w.dev.token, "chat.post", { c: "general", reply_to: root.seq, body: `following ${i}` });
    }
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: 44 });
    for (const root of [...roots].reverse()) await ok(w.lead.token, "chat.edit", { c: "general", msg: root.msg_id, body: `revised request ${root.seq}` });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const tiny = await ok(w.dev.token, "chat.catchup", { advance: true, budget: 100 });
    expect(tiny.omitted).toBeGreaterThan(0);
    expect(decodeCursors(tiny.next)[ch.project_id]).toBe(44);
    const r = await ok(w.dev.token, "chat.catchup", { advance: true, budget: 8000 });
    expect(r.threads.map((t: any) => t.latest_seq)).toEqual([...roots].reverse().slice(0, 20).map((m) => m.seq));
    expect(r.threads.every((t: any) => t.root_edited && t.replies === 0 && t.edited_replies === 0)).toBe(true);
    expect(decodeCursors(r.next)[ch.project_id]).toBe(44);
    expect((await inboxStub(env, w.acme.id, w.dev.identity.id).cursors(w.acme.id, w.dev.identity.id))[ch.project_id]).toBe(44);
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: r.threads.at(-1).latest_activity_seq });
    const tail = await ok(w.dev.token, "chat.catchup", { budget: 8000 });
    expect(tail.threads.map((t: any) => t.latest_seq)).toEqual(roots.slice(0, 2).reverse().map((m) => m.seq));
    expect(tail.omitted).toBe(0);
    expect(decodeCursors(tail.next)[ch.project_id]).toBe(66);
  }, 20_000);

  it("excludes self/retracted/unfollowed roots and preserves current channel/tenant boundaries", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "private request" });
    const reply = await ok(w.scout.token, "chat.post", { c: "general", reply_to: root.seq, body: "following", after: root.head });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: reply.head });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: root.msg_id, body: "private revised request" });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.threads).toHaveLength(1);
    expect((await ok(w.lead.token, "chat.catchup", {})).threads[0]?.root_edited ?? false).toBe(false);
    expect((await tool(w.tidy.longLived, "chat_catchup")).structuredContent.threads).toEqual([]);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_catchup", { scope: "general", identity_id: w.lead.identity.id });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain("private revised request");
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.threads).toEqual([]);
    await seedTenant("beta2");
    const crossTenant = await tool(w.scout.longLived, "chat_catchup", { tenant_id: w.acme.id }, "beta2");
    expect(crossTenant.status).toBe(401);
    expect(crossTenant.text).not.toContain("private revised request");
  });
});
