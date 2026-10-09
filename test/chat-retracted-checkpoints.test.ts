import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeCursors, type CatchupResult } from "../src/chat/catchup";
import { oauthContext } from "../src/auth/context";
import { liveGrant } from "../src/db/oauthGrants";
import { callTool } from "../src/mcp/tools";
import { inboxStub } from "../src/chat/stubs";
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

describe("followed thread retraction checkpoints", () => {
  it("discovers withdrawn roots behind the cursor, with body-free thread agreement and no read effects", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "withdrawn secret @scout" });
    const reply = await ok(w.scout.token, "chat.post", { c: "general", reply_to: root.seq, body: "following", after: root.head });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: reply.head });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const retract = await ok(w.lead.token, "chat.retract", { c: "general", msg: root.msg_id });
    expect(retract.woke).toBe(0);
    for (let i = 0; i < 3; i++) {
      const r = (await tool(w.scout.longLived, "chat_catchup")).structuredContent;
      expect(r.for_you).toEqual([]);
      expect(r.threads).toHaveLength(1);
      expect(r.threads[0]).toMatchObject({ conversation_id: ch.project_id, root_seq: root.seq, root_edited: false, root_retracted: true,
        replies: 0, edited_replies: 0, retracted_replies: 0, latest_seq: root.seq, latest_activity_seq: retract.head,
        latest: { msg_id: root.msg_id, rev: 2, body: "", retracted: true, author: { identity_id: w.lead.identity.id } } });
      expect(r.text).toContain("root retracted");
      expect(JSON.stringify(r)).not.toContain("withdrawn secret");
      expect(r.conversations[0].new).toBe(0);
      const thread = (await tool(w.scout.longLived, "chat_thread", { c: "general", msg: root.msg_id })).structuredContent;
      expect(thread.messages.find((m: any) => m.msg_id === root.msg_id)).toEqual(r.threads[0].latest);
      expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [ch.project_id]: reply.head });
      expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    }
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: retract.head });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.threads).toEqual([]);
  });

  it("merges new/edited/retracted replies once and treats same-range withdrawal as retracted, not new", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "root" });
    const older = await ok(w.lead.token, "chat.post", { c: "general", reply_to: root.seq, body: "older withdrawn" });
    const edited = await ok(w.lead.token, "chat.post", { c: "general", reply_to: root.seq, body: "old revision" });
    const follow = await ok(w.dev.token, "chat.post", { c: "general", reply_to: root.seq, body: "following" });
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: follow.head });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: edited.msg_id, body: "current revision" });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: older.msg_id });
    await ok(w.lead.token, "chat.post", { c: "general", reply_to: root.seq, body: "new surviving" });
    const fresh = await ok(w.lead.token, "chat.post", { c: "general", reply_to: root.seq, body: "new withdrawn" });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: fresh.msg_id });
    const rootRetract = await ok(w.lead.token, "chat.retract", { c: "general", msg: root.msg_id });
    let r = await ok(w.dev.token, "chat.catchup", {});
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]).toMatchObject({ root_retracted: true, root_edited: false, replies: 1, edited_replies: 1, retracted_replies: 2,
      latest_seq: root.seq, latest_activity_seq: rootRetract.head, latest: { retracted: true, body: "" } });
    expect(r.text).toContain("2 retracted");
    expect(JSON.stringify(r)).not.toContain("withdrawn");
    const { grant } = await seedGrant(w.acme, w.dev);
    const live = (await liveGrant(env.HUB_DB, grant.id, Date.now()))!;
    const ctx = oauthContext(env, live, ["read"], { now: Date.now(), ip: "203.0.113.1" });
    const read = await callTool(ctx, "chat_catchup", {});
    expect((read.structuredContent as CatchupResult).threads).toEqual(r.threads);
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: rootRetract.head });
    const later = await ok(w.lead.token, "chat.edit", { c: "general", msg: edited.msg_id, body: "later revision" });
    r = await ok(w.dev.token, "chat.catchup", {});
    expect(r.threads[0]).toMatchObject({ root_retracted: false, retracted_replies: 0, edited_replies: 1, latest_activity_seq: later.head });
  });

  it("reports an operator-retracted agent source as state, not as a native human request", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const root = await ok(w.scout.token, "chat.post", { c: "general", body: "agent source", after: 0 });
    const follow = await ok(w.dev.token, "chat.post", { c: "general", reply_to: root.seq, body: "following" });
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: follow.head });
    const retract = await ok(w.lead.token, "chat.retract", { c: "general", msg: root.msg_id });
    const r = await ok(w.dev.token, "chat.catchup", {});
    expect(r.threads[0]).toMatchObject({ root_retracted: true, latest_activity_seq: retract.head, latest: {
      body: "", retracted: true, author: { identity_id: w.scout.agent.identity.id, kind: "agent", session_kind: "browser" } } });
    const history = await ok(w.dev.token, "chat.history", { c: "general", msg: root.msg_id });
    expect(history.versions.at(-1).author.identity_id).toBe(w.lead.identity.id);
    expect(history.versions.at(-1).retracted).toBe(true);
  });

  it("retains cap and tiny-budget cursors for body-free retractions and resumes by activity", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const roots = [];
    for (let i = 0; i < 22; i++) {
      const root = await ok(w.lead.token, "chat.post", { c: "general", body: `root ${i}` });
      roots.push(root);
      await ok(w.dev.token, "chat.post", { c: "general", reply_to: root.seq, body: `following ${i}` });
    }
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: 44 });
    for (const root of [...roots].reverse()) await ok(w.lead.token, "chat.retract", { c: "general", msg: root.msg_id });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const tiny = await ok(w.dev.token, "chat.catchup", { advance: true, budget: 100 });
    expect(tiny.omitted).toBeGreaterThan(0);
    expect(decodeCursors(tiny.next)[ch.project_id]).toBe(44);
    const r = await ok(w.dev.token, "chat.catchup", { advance: true, budget: 8000 });
    expect(r.threads.map((t: any) => t.latest_seq)).toEqual([...roots].reverse().slice(0, 20).map((m) => m.seq));
    expect(r.threads.every((t: any) => t.root_retracted && !t.root_edited && t.latest.body === "")).toBe(true);
    expect(decodeCursors(r.next)[ch.project_id]).toBe(44);
    await ok(w.dev.token, "chat.mark_read", { c: "general", seq: r.threads.at(-1).latest_activity_seq });
    const tail = await ok(w.dev.token, "chat.catchup", { budget: 8000 });
    expect(tail.threads.map((t: any) => t.latest_seq)).toEqual(roots.slice(0, 2).reverse().map((m) => m.seq));
    expect(decodeCursors(tail.next)[ch.project_id]).toBe(66);
  }, 20_000);

  it("excludes self/unfollowed activity and preserves removed membership and tenant privacy", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "private root" });
    const follow = await ok(w.scout.token, "chat.post", { c: "general", reply_to: root.seq, body: "following", after: root.head });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: follow.head });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: root.msg_id });
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.threads).toHaveLength(1);
    expect((await ok(w.lead.token, "chat.catchup", {})).threads[0]).toMatchObject({ root_retracted: false, retracted_replies: 0 });
    expect((await tool(w.tidy.longLived, "chat_catchup")).structuredContent.threads).toEqual([]);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, "chat_catchup", { scope: "general", identity_id: w.lead.identity.id });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain(root.msg_id);
    expect((await tool(w.scout.longLived, "chat_catchup")).structuredContent.threads).toEqual([]);
    await seedTenant("beta2");
    const cross = await tool(w.scout.longLived, "chat_catchup", { tenant_id: w.acme.id }, "beta2");
    expect(cross.status).toBe(401);
    expect(cross.text).not.toContain(root.msg_id);
  });
});
