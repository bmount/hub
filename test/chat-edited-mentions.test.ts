import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeCursors } from "../src/chat/catchup";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { seedGrant, seedTenant } from "./helpers";
import { rpcBody } from "./oauth-helpers";

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await rpcBody(response)).result;
}

describe("checkpoint discovery of current edited mentions", () => {
  it("discovers an added mention behind the durable cursor, without treating edits as new posts or wakes", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "original unaddressed text" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: source.head });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.for_you).toEqual([]);
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout newly addressed product evidence" });
    expect(edit.woke).toBe(0);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(before.items).toEqual([]);
    for (let i = 0; i < 3; i++) {
      const r = (await tool(w.scout.longLived, "chat_catchup")).structuredContent;
      expect(r.tenant_id).toBe(w.acme.id);
      expect(r.for_you).toHaveLength(1);
      expect(r.for_you[0]).toMatchObject({ channel: "general", seq: source.seq, msg_id: source.msg_id, rev: 2,
        body: "@scout newly addressed product evidence", author: { identity_id: w.lead.identity.id, kind: "human", session_kind: "browser" } });
      expect(r.conversations[0]).toMatchObject({ new: 0, agent: 0, head: edit.head });
      expect(r.advanced).toBe(false);
      expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [ch.project_id]: source.head });
      expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
      expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).structuredContent.result).toBeNull();
    }
    // Explicit processing removes this revision from catchup, but a further revision is discoverable again.
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: edit.head });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.for_you).toEqual([]);
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout revised evidence" });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.for_you[0].rev).toBe(3);
  });

  it("returns the latest OAuth provenance, excludes removed mentions, retractions and self-authored text", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "thread root" });
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "older reply", reply_to: root.seq });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: source.head });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    const { session } = await seedGrant(w.acme, w.lead);
    // Real version path; MCP does not expose chat.edit. Source ownership is not execution authority.
    const edit = await conv.version({ tenant_id: w.acme.id, conversation_id: ch.project_id, now: Date.now(),
      actor: { id: w.lead.identity.id, kind: "human", session_id: session.id, session_kind: "oauth" },
      msg: source.msg_id, body: "@scout assistant revision", body_sha256: "fixture", after: source.head, refs: [],
      mentions: [{ identity_id: w.scout.agent.identity.id, kind: "agent" }], operator_of: [], is_admin: true, idempotency_key: "edited-mention" });
    expect(edit.refused).toBeNull();
    const r = (await tool(w.scout.longLived, "chat_catchup")).structuredContent;
    expect(r.for_you[0]).toMatchObject({ msg_id: source.msg_id, root_seq: root.seq, rev: 2, author: {
      identity_id: w.lead.identity.id, session_kind: "oauth", via_assistant: true,
    } });
    expect(r.text).toContain("via-assistant");
    const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id })).structuredContent;
    expect(thread.messages.find((m: any) => m.msg_id === source.msg_id)).toEqual(expect.objectContaining({ rev: 2, author: r.for_you[0].author }));
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "mention removed" });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.for_you).toEqual([]);
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout restored mention" });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.for_you).toEqual([]);
    // Self-authored mentions do not become requests to the author.
    const mine = await ok(w.lead.token, "chat.post", { c: "general", body: "mine" });
    await ok(w.lead.token, "chat.mark_read", { c: "general", seq: mine.head });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: mine.msg_id, body: "@lead self-addressed" });
    expect((await ok(w.lead.token, "chat.catchup", {})).for_you).toEqual([]);
  });

  it("keeps a cursor before capped edited mentions, orders by edit activity and resumes from the explicit cursor", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const sources = [];
    for (let i = 0; i < 22; i++) sources.push(await ok(w.lead.token, "chat.post", { c: "general", body: `old message ${i}` }));
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: 22 });
    // Reverse creation order: a cap must select the oldest unprocessed activities, not oldest messages.
    for (const source of [...sources].reverse()) await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: `@dev edited ${source.seq}` });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const r = await ok(w.dev.token, "chat.catchup", { advance: true, budget: 8000 });
    expect(r.for_you.map((m: any) => m.seq)).toEqual([...sources].reverse().slice(0, 20).map((s) => s.seq));
    expect(r.for_you.map((m: any) => m.activity_seq)).toEqual(Array.from({ length: 20 }, (_, i) => 23 + i));
    expect(r.omitted).toBeGreaterThanOrEqual(1);
    expect(r.conversations[0].new).toBe(0);
    expect(decodeCursors(r.next)[ch.project_id]).toBe(22);
    expect((await inboxStub(env, w.acme.id, w.dev.identity.id).cursors(w.acme.id, w.dev.identity.id))[ch.project_id]).toBe(22);
    // A caller that actually processed the first 20 activities explicitly advances to their activity seq.
    const lastShownActivity = r.for_you.at(-1).activity_seq;
    expect(lastShownActivity).toBe(42);
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: lastShownActivity });
    const tail = await ok(w.dev.token, "chat.catchup", { budget: 8000 });
    expect(tail.for_you.map((m: any) => m.seq)).toEqual([2, 1]);
    expect(tail.for_you.map((m: any) => m.activity_seq)).toEqual([43, 44]);
    expect(tail.omitted).toBe(0);
    expect(decodeCursors(tail.next)[ch.project_id]).toBe(44);
  }, 20_000);

  it("keeps edited mention discovery behind current channel and tenant authorization", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "old" });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: source.head });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout private revised evidence" });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.for_you).toHaveLength(1);
    expect((await tool(w.tidy.longLived, "chat_catchup")).structuredContent.for_you).toEqual([]);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_catchup", { scope: "general", tenant_id: w.acme.id });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not_found");
    expect(JSON.stringify(denied)).not.toContain("private revised evidence");
    await seedTenant("beta2");
    const otherTenant = await SELF.fetch("https://beta2.pimwell.test/agent/mcp", {
      method: "POST", headers: { authorization: `Bearer ${w.scout.longLived}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_catchup", arguments: { tenant_id: w.acme.id } } }),
    });
    expect(otherTenant.status).toBe(401);
    expect(await otherTenant.text()).not.toContain("private revised evidence");
  });
});
