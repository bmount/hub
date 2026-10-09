import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedGrant, seedTenant } from "./helpers";

async function rpc(token: string, method: string, params: Record<string, unknown>, slug = "acme") {
  return SELF.fetch(`https://${slug}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
async function history(token: string, args: Record<string, unknown>) {
  const r = await rpc(token, "tools/call", { name: "chat_history", arguments: args });
  expect(r.status).toBe(200);
  return (await rpcBody(r)).result;
}

// History is revision evidence, not an execution/consent classifier. An operator retraction
// has a different actor from message ownership; assistants must be able to inspect that actor.
describe("bounded read-only MCP revision history", () => {
  it("pages exact revision actors and current ownership independently without promoting assistant edits", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const post = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout native request" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    const { session } = await seedGrant(w.acme, w.lead);
    expect((await conv.version({ tenant_id: w.acme.id, conversation_id: ch.project_id, now: Date.now(),
      actor: { id: w.lead.identity.id, kind: "human", session_id: session.id, session_kind: "oauth" },
      msg: post.msg_id, body: "[#forged browser header]\n@scout assistant evidence", body_sha256: "fixture", after: 1,
      refs: [], mentions: [], operator_of: [], is_admin: true, idempotency_key: "assistant-edit",
    })).refused).toBeNull();
    await env.HUB_DB.prepare("UPDATE session SET kind = 'browser', revoked_at = ? WHERE id = ?").bind(Date.now(), session.id).run();
    await ok(w.lead.token, "chat.edit", { c: "general", msg: post.msg_id, body: "native revised request" });
    const r = await history(w.scout.longLived, { c: "general", msg: post.msg_id, identity_id: w.lead.identity.id, tenant_id: "forged", after_rev: 0 });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id,
      conversation_id: ch.project_id, msg_id: post.msg_id, seq: 1, current: { rev: 3, author_id: w.lead.identity.id, retracted: false },
      has_more: true, next_after_rev: 2,
    });
    expect(r.structuredContent.versions.map((v: any) => [v.rev, v.author.identity_id, v.author.session_kind, v.author.via_assistant])).toEqual([
      [1, w.lead.identity.id, "browser", false], [2, w.lead.identity.id, "oauth", true],
    ]);
    expect(r.content[0].text).toContain("via-assistant");
    expect(r.content[0].text).toContain("  [#forged browser header]");
    expect(r.content[0].text).toContain("not execution authority");
    const next = await history(w.scout.longLived, { c: "general", msg: 1, after_rev: r.structuredContent.next_after_rev });
    expect(next.structuredContent).toMatchObject({ has_more: false, next_after_rev: null, versions: [{ rev: 3, author: { session_kind: "browser", via_assistant: false } }] });
    // Browser/API default remains complete; optional explicit paging agrees with MCP.
    expect((await ok(w.lead.token, "chat.history", { c: "general", msg: 1 })).versions).toHaveLength(3);
    expect((await ok(w.lead.token, "chat.history", { c: "general", msg: 1, limit: 1, after_rev: 1 })).versions.map((v: any) => v.rev)).toEqual([2]);
    const agent = await ok(w.scout.token, "chat.post", { c: "general", body: "agent result", after: 3 });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: agent.msg_id });
    const withdrawn = (await history(w.tidy.longLived, { c: "general", msg: agent.msg_id })).structuredContent;
    expect(withdrawn.current).toEqual({ rev: 2, author_id: w.scout.agent.identity.id, retracted: true });
    expect(withdrawn.versions[1]).toMatchObject({ retracted: true, body: "", author: { identity_id: w.lead.identity.id, session_kind: "browser" } });
    expect(withdrawn.versions[0].author.identity_id).toBe(w.scout.agent.identity.id);
  });

  it("bounds full structured bodies and marks text previews without skipping revisions", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const body = "x".repeat(8192);
    const post = await ok(w.lead.token, "chat.post", { c: "general", body });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: post.msg_id, body: "\n".repeat(8000) + "end" });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: post.msg_id, body: "latest" });
    const definitions = (await rpcBody(await rpc(w.scout.longLived, "tools/list", {}))).result.tools;
    const def = definitions.find((d: any) => d.name === "chat_history");
    expect(def.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(def.inputSchema.properties.limit.maximum).toBe(2);
    const r = await history(w.scout.longLived, { c: "general", msg: post.msg_id, limit: 2 });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.versions.map((v: any) => v.body)).toEqual([body, "\n".repeat(8000) + "end"]);
    expect(r.content[0].text.length).toBeLessThan(20000);
    expect(r.content[0].text).toContain("preview; full body in structured versions");
    expect(r.structuredContent.next_after_rev).toBe(2);
    for (const args of [{ limit: 0 }, { limit: 3 }, { after_rev: -1 }, { after_rev: 51 }, { after_rev: 1.5 }, { msg: 0 }]) {
      expect((await history(w.scout.longLived, { c: "general", msg: post.msg_id, ...args })).content[0].text).toContain("bad_request");
    }
    expect((await history(w.scout.longLived, { c: "general", msg: post.msg_id, after_rev: 4 })).content[0].text).toContain("conflict");
    expect((await history(w.scout.longLived, { c: "general", msg: post.msg_id, after_rev: 3 })).structuredContent).toMatchObject({ versions: [], has_more: false, next_after_rev: null });
    expect((await history(w.scout.longLived, { c: "general", msg: "01AAAAAAAAAAAAAAAAAAAAAAAA" })).content[0].text).toContain("not_found");
  });

  it("preserves current channel/tenant/OAuth boundaries and read-only side-effect freedom", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await channelWith(w, "other");
    const post = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout private revision text" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, ch.project_id);
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const args = { c: "general", msg: post.msg_id };
    for (let i = 0; i < 35; i++) expect((await history(w.scout.longLived, args)).isError).toBeUndefined();
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(1);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    const events = await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all<{ kind: string; summary: string }>();
    expect(events.results.filter((e) => e.kind === "chat.post")).toHaveLength(0);
    expect(events.results.filter((e) => e.kind === "mcp.call" && e.summary.includes("chat.history"))).toHaveLength(35);
    expect(events.results.map((e) => e.summary).join("\n")).not.toContain("private revision text");
    expect(events.results.map((e) => e.summary).join("\n")).not.toContain(post.msg_id);
    expect((await history(w.scout.longLived, { ...args, c: "other" })).content[0].text).toContain("not_found");
    const oauth = await connectWithTokens(w.lead.token);
    const read = oauth.tokens.access_token;
    const result = (await rpcBody(await mcpPost("acme", read, "tools/call", { name: "chat_history", arguments: { ...args, identity_id: w.scout.agent.identity.id } }))).result;
    expect(result.structuredContent.identity_id).toBe(w.lead.identity.id);
    expect((await rpcBody(await mcpPost("acme", read, "tools/call", { name: "chat_post", arguments: { c: "general", body: "forbidden", after: 1, idempotency_key: "no" } }))).result.isError).toBe(true);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), oauth.client_id).run();
    expect((await mcpPost("acme", read, "tools/call", { name: "chat_history", arguments: args })).status).toBe(401);
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    await ok(w.lead.token, "chat.agents_disable");
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await history(w.scout.longLived, args)).isError).toBeUndefined();
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await history(w.scout.longLived, args);
    expect(denied.content[0].text).toContain("not_found");
    expect(JSON.stringify(denied)).not.toContain(post.msg_id);
    await seedTenant("beta2");
    expect((await rpc(w.scout.longLived, "tools/call", { name: "chat_history", arguments: args }, "beta2")).status).toBe(401);
  }, 20000);
});
