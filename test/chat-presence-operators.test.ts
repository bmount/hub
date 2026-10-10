import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { operatorActiveIn } from "../src/auth/agent";
import { conversationStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import type { PresenceRow } from "../src/chat/presence";
import { agentMcpAuth } from "../src/mcp/agentAuth";
import { callTool } from "../src/mcp/tools";
import { bearer, seedHuman, seedTenant } from "./helpers";
import { call, channelWith, chatWorld, HOST, ok } from "./chat-helpers";
import { inDO } from "./do-helper";

const fixture = async () => {
  const w = await chatWorld(); await channelWith(w);
  const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
  const stub = conversationStub(env, w.acme.id, ch.project_id);
  const stored = () => inDO(stub, (_obj, state) => state.storage.get<PresenceRow[]>("presence:v1"));
  return { ...w, ch, stub, stored };
};

describe("presence requires a live agent operator", () => {
  it.each(["online", "away", "offline"])("omits retained %s after operator membership withdrawal without fabricating offline or mutating reports", async (status) => {
    const w = await fixture();
    await ok(w.scout.token, "chat.heartbeat", { c: "general", status: "online" });
    const report = await ok(w.tidy.token, "chat.heartbeat", { c: "general", status });
    const before = await w.stored();
    const memberships = () => env.HUB_DB.prepare("SELECT * FROM membership ORDER BY id").all();
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.dev.identity.id).run();
    const membershipBefore = (await memberships()).results;
    expect(await operatorActiveIn(env.HUB_DB, w.dev.identity.id, w.acme.id)).toBe(false);
    expect((await call(w.tidy.token, "chat.heartbeat", { c: "general", status: "online" })).status).toBe(404);
    for (let i = 0; i < 2; i++) {
      const result = await ok(w.lead.token, "chat.presence", { c: "general" });
      expect(result.missing).toBe("unknown");
      expect(result.entries.map((r: { identity_id: string }) => r.identity_id)).toEqual([w.scout.agent.identity.id]);
      expect(await w.stored()).toEqual(before);
      expect((await memberships()).results).toEqual(membershipBefore);
    }
    // Actual MCP composition must not leak the filtered subject in text or structured evidence.
    const auth = await agentMcpAuth(new Request(`https://${HOST}/agent/mcp`, { headers: bearer(w.scout.longLived) }), env, "acme", Date.now());
    if (auth.kind !== "ok") throw new Error("fixture auth refused");
    const mcp = await callTool(auth.ctx, "chat_presence", { c: "general" });
    expect(mcp.isError).toBeUndefined();
    expect((mcp.structuredContent as { entries: Array<{ identity_id: string }> }).entries.map(r => r.identity_id)).toEqual([w.scout.agent.identity.id]);
    expect(JSON.stringify(mcp.content)).not.toContain(w.tidy.agent.identity.id);
    expect(await w.stored()).toEqual(before);
    // Fixture-only restored reader operator: eligible retained evidence is unchanged,
    // not a newly published heartbeat or evidence the agent resumed participation.
    await env.HUB_DB.prepare("UPDATE membership SET state = 'active', role = 'reader' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.dev.identity.id).run();
    expect(await operatorActiveIn(env.HUB_DB, w.dev.identity.id, w.acme.id)).toBe(true);
    const restored = (await ok(w.lead.token, "chat.presence", { c: "general" })).entries;
    expect(restored).toEqual(expect.arrayContaining([expect.objectContaining({ identity_id: report.identity_id, state: status, last_seen: report.last_seen, expires_at: report.expires_at })]));
    expect(await w.stored()).toEqual(before);
    expect(await w.stub.head(w.acme.id, w.ch.project_id)).toBe(0);
  });

  it("matches operatorActiveIn for missing, non-human, archived and foreign-only operators, including invalid root flags", async () => {
    const w = await fixture();
    await ok(w.tidy.token, "chat.heartbeat", { c: "general", status: "away" });
    const before = await w.stored();
    const foreign = await seedTenant("presence-foreign-operator");
    const outsider = await seedHuman("foreign-operator@example.com", { memberships: [{ tenant_id: foreign.id, role: "admin" }] });
    const archivedRoot = await seedHuman("archived-root@example.com", { is_root: true });
    await env.HUB_DB.prepare("UPDATE identity SET state = 'archived' WHERE id = ?").bind(archivedRoot.identity.id).run();
    // A root flag does not turn an agent identity into an eligible human operator.
    await env.HUB_DB.prepare("UPDATE identity SET is_root = 1 WHERE id = ?").bind(w.scout.agent.identity.id).run();
    for (const operator of [null, w.scout.agent.identity.id, archivedRoot.identity.id, outsider.identity.id]) {
      await env.HUB_DB.prepare("UPDATE identity SET operator_id = ? WHERE id = ?").bind(operator, w.tidy.agent.identity.id).run();
      expect(await operatorActiveIn(env.HUB_DB, operator, w.acme.id)).toBe(false);
      expect((await call(w.tidy.token, "chat.presence", { c: "general" })).status).toBe(404);
      expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries).toEqual([]);
      expect(await w.stored()).toEqual(before);
    }
    expect(await w.stub.head(w.acme.id, w.ch.project_id)).toBe(0);
  });

  it("keeps the existing active-human-root exception but not archived agent membership or revoked channel grant", async () => {
    const w = await fixture();
    const report = await ok(w.tidy.token, "chat.heartbeat", { c: "general", status: "online" });
    const root = await seedHuman("presence-root@example.com", { is_root: true });
    await env.HUB_DB.prepare("UPDATE identity SET operator_id = ? WHERE id = ?").bind(root.identity.id, w.tidy.agent.identity.id).run();
    const before = await w.stored();
    expect(await operatorActiveIn(env.HUB_DB, root.identity.id, w.acme.id)).toBe(true);
    expect((await call(w.tidy.token, "chat.presence", { c: "general" })).status).toBe(200);
    expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries).toMatchObject([{ identity_id: report.identity_id, state: "online", last_seen: report.last_seen }]);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'archived' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.tidy.agent.identity.id).run();
    expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries).toEqual([]);
    await env.HUB_DB.prepare("UPDATE membership SET state = 'active' WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.tidy.agent.identity.id).run();
    await env.HUB_DB.prepare("UPDATE conversation_member SET removed_at = ? WHERE tenant_id = ? AND conversation_id = ? AND identity_id = ?")
      .bind(Date.now(), w.acme.id, w.ch.project_id, w.tidy.agent.identity.id).run();
    expect((await ok(w.lead.token, "chat.presence", { c: "general" })).entries).toEqual([]);
    expect(await w.stored()).toEqual(before);
  });
});
