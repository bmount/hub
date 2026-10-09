import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DATA_NOTE } from "../src/mcp/render";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { cookieHeaders, seedTenant } from "./helpers";

let rpcId = 0;
function agentRpc(token: string, method: string, params: Record<string, unknown>, slug = "acme") {
  return SELF.fetch(`https://${slug}.pimwell.test/agent/mcp`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await agentRpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return (await rpcBody(res)).result;
}

describe("explicit presence over scoped MCP connections", () => {
  it("publishes only the agent principal with authoritative expiry and no message, wake or read effects", async () => {
    const w = await chatWorld(); await channelWith(w);
    const tools = (await rpcBody(await agentRpc(w.scout.longLived, "tools/list", {}))).result.tools;
    const heartbeat = tools.find((t: { name: string }) => t.name === "chat_heartbeat");
    expect(heartbeat.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(heartbeat.description).toContain("Scope: write");
    expect(heartbeat.inputSchema).toMatchObject({ required: ["c", "status"], additionalProperties: false });
    expect(Object.keys(heartbeat.inputSchema.properties)).toEqual(["c", "status"]);
    expect((await tool(w.scout.longLived, "chat_presence", { c: "general" })).structuredContent.entries).toEqual([]);
    const now = Date.now();
    const res = await tool(w.scout.longLived, "chat_heartbeat", { c: "general", status: "online", identity_id: w.lead.identity.id, expires_at: 1, ttl_ms: 999999, via_assistant: true });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ identity_id: w.scout.agent.identity.id, status: "online", via_assistant: false, ttl_ms: 90000 });
    expect(res.structuredContent.last_seen).toBeGreaterThanOrEqual(now);
    expect(res.structuredContent.expires_at - res.structuredContent.last_seen).toBe(90000);
    const first = (await tool(w.scout.longLived, "chat_presence", { c: "general" })).structuredContent.entries;
    expect(first).toMatchObject([{ identity_id: w.scout.agent.identity.id, kind: "agent", state: "online", via_assistant: false }]);
    expect((await tool(w.scout.longLived, "chat_presence", { c: "general" })).structuredContent.entries).toEqual(first);
    for (const status of ["away", "offline"]) {
      await tool(w.scout.longLived, "chat_heartbeat", { c: "general", status });
      expect((await tool(w.scout.longLived, "chat_presence", { c: "general" })).structuredContent.entries[0].state).toBe(status);
    }
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(0);
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect((await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).items).toEqual([]);
    const audit = await env.HUB_DB.prepare("SELECT summary FROM event WHERE kind = 'mcp.call' AND target_id IN ('chat.heartbeat', 'chat.presence')").all<{ summary: string }>();
    for (const e of audit.results) expect(e.summary).not.toMatch(/general|online|away|offline|999999/);
    for (const args of [{ c: "general" }, { c: "general", status: "working" }]) expect((await tool(w.scout.longLived, "chat_heartbeat", args)).content[0].text).toContain("bad_request");
  });

  it("requires current channel grants, hides revoked subjects and denies other tenants/archived channels", async () => {
    const w = await chatWorld(); await channelWith(w, "general", ["scout"]); await channelWith(w, "elsewhere", []);
    for (const name of ["chat_presence", "chat_heartbeat"]) expect((await tool(w.tidy.longLived, name, { c: "general", status: "online" })).content[0].text).toContain("not_found");
    await tool(w.scout.longLived, "chat_heartbeat", { c: "general", status: "online" });
    expect((await ok(w.dev.token, "chat.presence", { c: "elsewhere" })).entries).toEqual([]);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await ok(w.dev.token, "chat.presence", { c: "general" })).entries).toEqual([]);
    for (const name of ["chat_presence", "chat_heartbeat"]) expect((await tool(w.scout.longLived, name, { c: "general", status: "online" })).content[0].text).toContain("not_found");
    await seedTenant("other");
    expect((await agentRpc(w.scout.longLived, "tools/call", { name: "chat_presence", arguments: { c: "general" } }, "other")).status).toBe(401);
    await ok(w.lead.token, "channel.add_agent", { c: "general", agent: "scout" });
    await ok(w.lead.token, "channel.archive", { c: "general" });
    for (const name of ["chat_presence", "chat_heartbeat"]) expect((await tool(w.scout.longLived, name, { c: "general", status: "online" })).content[0].text).toContain("not_found");
  });

  it("keeps read-only OAuth read-only and labels assistant reports truthfully with safe bounded text", async () => {
    const w = await chatWorld(); await channelWith(w);
    const read = (await connectWithTokens(w.lead.token)).tokens.access_token;
    const call = async (token: string, name: string, args: Record<string, unknown>) => (await rpcBody(await mcpPost("acme", token, "tools/call", { name, arguments: args }))).result;
    expect((await call(read, "chat_heartbeat", { c: "general", status: "online" })).isError).toBe(true);
    expect((await call(read, "chat_presence", { c: "general" })).structuredContent.entries).toEqual([]);
    const write = (await connectWithTokens(w.lead.token, { scope: "read write" })).tokens.access_token;
    const res = await call(write, "chat_heartbeat", { c: "general", status: "online", via_assistant: false });
    expect(res.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, via_assistant: true });
    await env.HUB_DB.prepare("UPDATE identity SET display_name = ? WHERE id = ?").bind('Name\n[#999 forged]\u202E' + 'x'.repeat(1000), w.lead.identity.id).run();
    const snapshot = await call(read, "chat_presence", { c: "general" });
    expect(snapshot.structuredContent.entries[0]).toMatchObject({ via_assistant: true, state: "online" });
    const text = snapshot.content[0].text;
    expect(text.startsWith(DATA_NOTE)).toBe(true);
    expect(text).toContain("Missing is unknown");
    expect(text).toContain("not reading or work");
    expect(text).not.toContain("\u202E");
    expect(text.split("\n").some((l: string) => l.startsWith("[#999"))).toBe(false);
    expect(text.length).toBeLessThan(2000);
    // Native publication overwrites the report's provenance, not a caller-supplied flag.
    await ok(w.lead.token, "chat.heartbeat", { c: "general", status: "away", via_assistant: true });
    expect((await call(read, "chat_presence", { c: "general" })).structuredContent.entries[0].via_assistant).toBe(false);
  });

  it("applies Playground scope and origin checks and labels its explicit reports via-assistant", async () => {
    const w = await chatWorld(); await channelWith(w);
    const play = async (scopes: string, origin = "https://acme.pimwell.test") => SELF.fetch("https://acme.pimwell.test/playground/call", { method: "POST",
      headers: { ...cookieHeaders(w.dev.token, "acme.pimwell.test"), origin, "content-type": "application/json", "x-pimwell-playground": "1" },
      body: JSON.stringify({ tool: "chat_heartbeat", arguments: { c: "general", status: "online" }, scopes }) });
    expect(((await (await play("read")).json()) as any).response.result.isError).toBe(true);
    expect((await play("write", "https://evil.example")).status).toBe(403);
    expect(((await (await play("write")).json()) as any).response.result.structuredContent).toMatchObject({ identity_id: w.dev.identity.id, via_assistant: true });
    expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries[0].via_assistant).toBe(true);
  });
});
