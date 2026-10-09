import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getChannelBySlug } from "../src/db/chat";
import { inboxStub } from "../src/chat/stubs";
import { call, channelWith, chatWorld, ok, until } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function agent(token: string, args: Record<string, unknown>, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_inbox", arguments: args } }),
  });
  return { status: res.status, result: res.status === 200 ? (await rpcBody(res)).result : null };
}

describe("public inbox future scan refusal", () => {
  it("refuses future API scans and waits before parking, without hiding later incoming items", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    for (const verb of ["chat.inbox", "inbox.wait"]) {
      for (const after of [1, Number.MAX_SAFE_INTEGER]) {
        const r = await call(w.scout.token, verb, { after, wait_s: 20 });
        expect(r).toMatchObject({ status: 409, body: { error: "conflict", data: { high_water: 0 } } });
        expect(r.body).not.toHaveProperty("result");
      }
    }
    expect(await box.waiting(w.acme.id, id)).toBe(0);
    const first = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout original after refused future scan" });
    expect(await ok(w.scout.token, "chat.inbox", { after: 0 })).toMatchObject({ head: 1, next_after: 1, items: [{ msg_id: first.msg_id }] });
    expect(await call(w.scout.token, "chat.inbox", { after: 2 })).toMatchObject({ status: 409, body: { data: { high_water: 1 } } });
    const waiting = call(w.scout.token, "inbox.wait", { after: 1, wait_s: 5 });
    await until(async () => (await box.waiting(w.acme.id, id)) === 1);
    const later = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout second original after valid scan" });
    expect(await waiting).toMatchObject({ status: 200, body: { result: { next_after: 2, items: [{ msg_id: later.msg_id }] } } });
    expect(await box.cursors(w.acme.id, id)).toEqual({});
    expect((await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).items.every((x) => x.acked_at === null)).toBe(true);
  });

  it("validates allocated high-water rather than retained head after acknowledgement and pruning", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout first scan before pruning" });
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout second scan before pruning" });
    await box.ack(w.acme.id, id, 2, Date.now() - 31 * 86_400_000);
    await box.deliver(w.acme.id, id, []);
    expect(await box.head(w.acme.id, id)).toBe(0);
    for (const verb of ["chat.inbox", "inbox.wait"]) {
      expect(await ok(w.scout.token, verb, { after: 2, wait_s: 0 })).toMatchObject({ head: 0, next_after: 2, items: [], has_more: false });
      expect(await call(w.scout.token, verb, { after: 3, wait_s: 0 })).toMatchObject({ status: 409, body: { data: { high_water: 2 } } });
    }
    const late = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout late arrival after pruning" });
    expect(await ok(w.scout.token, "chat.inbox", { after: 2 })).toMatchObject({ head: 3, next_after: 3, items: [{ msg_id: late.msg_id }] });
  });

  it("binds MCP refusal to the reader, does not leak denied source evidence or mutate attention", async () => {
    const w = await chatWorld();
    await channelWith(w, "hidden");
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "hidden"))!;
    const original = await ok(w.lead.token, "chat.post", { c: "hidden", body: "@scout hidden evidence" });
    await ok(w.lead.token, "channel.remove_agent", { c: "hidden", agent: "scout" });
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    const before = await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true });
    for (let n = 0; n < 25; n++) {
      const r = (await agent(w.scout.longLived, { after: 2, identity_id: w.lead.identity.id, tenant_id: "forged", high_water: 2 })).result;
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).toContain("conflict");
      for (const secret of [original.msg_id, ch.project_id, "hidden evidence", "#hidden", w.lead.identity.id]) expect(JSON.stringify(r)).not.toContain(secret);
    }
    expect((await agent(w.scout.longLived, { after: 1 })).result.structuredContent).toMatchObject({ identity_id: id, next_after: 1, items: [] });
    expect((await agent(w.tidy.longLived, { after: 1, identity_id: id })).result.isError).toBe(true);
    expect(await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await box.cursors(w.acme.id, id)).toEqual({});
    expect(await box.waiting(w.acme.id, id)).toBe(0);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id).all();
    expect(events.results.map((x) => x.kind)).toEqual(["chat.post"]);
    await seedTenant("beta2");
    expect((await agent(w.scout.longLived, { after: 2 }, "beta2")).status).toBe(401);
  });

  it("validates read-only OAuth's own inbox and denies revoked grants before disclosing bounds", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: "@lead incoming original for human inbox" });
    const connection = await connectWithTokens(w.lead.token);
    const invoke = async (args: Record<string, unknown>) => mcpPost("acme", connection.tokens.access_token, "tools/call", { name: "chat_inbox", arguments: args });
    expect((await rpcBody(await invoke({ after: 2, identity_id: w.scout.agent.identity.id, high_water: 2 }))).result.isError).toBe(true);
    expect((await rpcBody(await invoke({ after: 1 }))).result.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, next_after: 1, items: [] });
    expect(await call(w.scout.token, "chat.inbox", { after: 1, identity_id: w.lead.identity.id })).toMatchObject({ status: 409, body: { data: { high_water: 0 } } });
    const box = inboxStub(env, w.acme.id, w.lead.identity.id);
    expect((await box.list(w.acme.id, w.lead.identity.id, { after: 0, limit: 100, include_acked: true })).items[0]!.acked_at).toBeNull();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), connection.client_id).run();
    const revoked = await invoke({ after: 2 });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain("high_water");
  });
});
