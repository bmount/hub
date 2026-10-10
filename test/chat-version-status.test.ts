import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { LIMITS } from "../src/chat/rules";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { inDO } from "./do-helper";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

let rpcId = 0;
async function rpc(token: string, method: string, params: Record<string, unknown>, slug = "acme") {
  return SELF.fetch(`https://${slug}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}
async function tool(token: string, args: Record<string, unknown>) {
  const r = await rpc(token, "tools/call", { name: "chat_version_status", arguments: args });
  expect(r.status).toBe(200);
  return (await rpcBody(r)).result;
}
async function setup() {
  const w = await chatWorld(); await channelWith(w);
  const first = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy original", after: 0, idempotency_key: "private-key" });
  const args = { c: "general", idempotency_key: "private-key" };
  const edit = await ok(w.scout.token, "chat.edit", { ...args, msg: first.msg_id, body: "private changed text", after: first.head });
  const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
  return { w, first, edit, args, ch, conv: conversationStub(env, w.acme.id, ch.project_id) };
}

describe("read-only interrupted chat version reconciliation", () => {
  it("distinguishes original edit/retraction commits from current state without replay or private values", async () => {
    const { w, first, edit, args, ch, conv } = await setup();
    const defs = (await rpcBody(await rpc(w.scout.longLived, "tools/list", {}))).result.tools;
    expect(defs.find((t: { name: string }) => t.name === "chat_version_status").annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect((await tool(w.scout.longLived, { ...args, operation: "retract" })).structuredContent.record).toBeNull();
    const gone = await ok(w.lead.token, "chat.retract", { ...args, msg: first.msg_id });
    const box = inboxStub(env, w.acme.id, w.tidy.agent.identity.id);
    const before = await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    for (let i = 0; i < 12; i++) {
      const r = await tool(w.scout.longLived, { ...args, operation: "edit", identity_id: w.lead.identity.id, tenant_id: "forged", body: "private ignored" });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, conversation_id: ch.project_id, operation: "edit", head: gone.head,
        record: { committed: { msg_id: first.msg_id, seq: edit.seq, rev: 2 }, current: { rev: 3, retracted: true }, intent_bound: true } });
      expect(r.structuredContent.record.expires_at - r.structuredContent.observed_at).toBeGreaterThan(LIMITS.IDEM_TTL_MS - 60_000);
      expect(JSON.stringify(r)).not.toMatch(/private|fingerprint|woke|suppressed|forged/);
      expect(r.content[0].text).toContain("not payload verification");
      expect(r.content[0].text).toContain(`activity_seq=${edit.seq}`);
      expect(r.structuredContent).not.toHaveProperty("intent_check");
    }
    expect((await tool(w.scout.longLived, { ...args, operation: "retract" })).structuredContent.record).toBeNull();
    expect((await ok(w.lead.token, "chat.version_status", { ...args, operation: "retract" })).record).toMatchObject({ committed: { seq: gone.seq, rev: 3 }, current: { rev: 3, retracted: true } });
    expect((await ok(w.scout.token, "chat.post_status", args)).record.committed.rev).toBe(1);
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(gone.head);
    expect(await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    const events = (await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ?").bind(w.acme.id).all<{ kind: string; summary: string }>()).results;
    expect(events.filter((e) => e.kind === "chat.edit")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "chat.retract")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "mcp.call" && e.summary.includes("chat.version_status")).map((e) => e.summary).join("\n")).not.toMatch(/private|fingerprint|forged/);
  });

  it("keeps caller/channel/read OAuth boundaries and posting controls independent", async () => {
    const { w, first, args } = await setup(); await channelWith(w, "other");
    for (const [token, c] of [[w.tidy.longLived, "general"], [w.scout.longLived, "other"]] as const) {
      expect((await tool(token, { ...args, c, operation: "edit", identity_id: w.scout.agent.identity.id })).structuredContent.record).toBeNull();
    }
    const own = await ok(w.lead.token, "chat.post", { c: "general", body: "native source" });
    const native = await ok(w.lead.token, "chat.edit", { ...args, msg: own.msg_id, body: "human change" });
    const conn = await connectWithTokens(w.lead.token);
    const query = { ...args, operation: "edit", identity_id: w.scout.agent.identity.id };
    const oauth = (await rpcBody(await mcpPost("acme", conn.tokens.access_token, "tools/call", { name: "chat_version_status", arguments: query }))).result;
    expect(oauth.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, record: { committed: { msg_id: native.msg_id, rev: 2 } } });
    const readDefs = (await rpcBody(await mcpPost("acme", conn.tokens.access_token, "tools/list", {}))).result.tools;
    expect(readDefs.map((t: { name: string }) => t.name)).toContain("chat_version_status");
    expect(readDefs.map((t: { name: string }) => t.name)).not.toContain("chat_edit");
    expect(readDefs.map((t: { name: string }) => t.name)).not.toContain("chat_retract");
    expect((await rpcBody(await mcpPost("acme", conn.tokens.access_token, "tools/call", { name: "chat_edit", arguments: { c: "general", msg: own.msg_id, body: "denied" } }))).result.isError).toBe(true);
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    await ok(w.lead.token, "chat.agents_disable"); await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await tool(w.scout.longLived, { ...args, operation: "edit" })).isError).toBeUndefined();
    expect((await call(w.scout.token, "chat.edit", { ...args, msg: first.msg_id, body: "private changed text", after: 2 })).status).not.toBe(200);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, { ...args, operation: "edit" });
    expect(denied.content[0].text).toContain("not_found"); expect(denied.structuredContent).toBeUndefined();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), conn.client_id).run();
    expect((await mcpPost("acme", conn.tokens.access_token, "tools/call", { name: "chat_version_status", arguments: query })).status).toBe(401);
    await seedTenant("beta2"); expect((await rpc(w.scout.longLived, "tools/call", { name: "chat_version_status", arguments: query }, "beta2")).status).toBe(401);
  });

  it("retains expiry and legacy/unavailable evidence across reconstruction without pruning or changing SQL", async () => {
    const { w, first, edit, args, ch, conv } = await setup();
    await inDO(conv, async (_o, state) => {
      const fresh = new Conversation(state, env);
      const query = () => fresh.versionStatus(w.acme.id, ch.project_id, w.scout.agent.identity.id, "edit", args.idempotency_key);
      const before = state.storage.sql.exec("SELECT * FROM idem ORDER BY key").toArray();
      const original = await query();
      expect(original.record).toMatchObject({ committed: { msg_id: first.msg_id, seq: edit.seq, rev: 2 }, intent_bound: true });
      expect(await query()).toMatchObject({ record: { expires_at: original.record!.expires_at } });
      expect(state.storage.sql.exec("SELECT * FROM idem ORDER BY key").toArray()).toEqual(before);
      await expect(fresh.versionStatus("wrong-tenant", ch.project_id, w.scout.agent.identity.id, "edit", args.idempotency_key)).rejects.toThrow("another tenant or owner");
      await expect(fresh.versionStatus(w.acme.id, "wrong-channel", w.scout.agent.identity.id, "edit", args.idempotency_key)).rejects.toThrow("another tenant or owner");
      await expect(fresh.versionStatus(w.acme.id, ch.project_id, w.scout.agent.identity.id, "post" as "edit", args.idempotency_key)).rejects.toThrow("invalid version status operation");
      const row = state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM idem WHERE key = ?", "edit:private-key").toArray()[0]!;
      state.storage.sql.exec("UPDATE idem SET result_json = ? WHERE key = ?", JSON.stringify(JSON.parse(row.result_json).result), "edit:private-key");
      expect((await query()).record).toMatchObject({ intent_bound: false, expires_at: original.record!.expires_at });
      // Synthetic unavailable-message/expiry cases only; never mutate actual product data.
      state.storage.sql.exec("DELETE FROM msg WHERE msg_id = ?", first.msg_id);
      expect((await query()).record).toMatchObject({ current: null, committed: { rev: 2 } });
      state.storage.sql.exec("UPDATE idem SET created_at = ? WHERE key = ?", Date.now() - LIMITS.IDEM_TTL_MS, "edit:private-key");
      const expiredRows = state.storage.sql.exec("SELECT * FROM idem ORDER BY key").toArray();
      expect((await query()).record).toBeNull();
      expect(state.storage.sql.exec("SELECT * FROM idem ORDER BY key").toArray()).toEqual(expiredRows);
    });
  });

  it("preserves whitespace/maximal keys and does not infer an unkeyed version from history", async () => {
    const w = await chatWorld(); await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "native" });
    for (const idempotency_key of [" ", " private-key ", "k".repeat(64)]) {
      const args = { c: "general", idempotency_key };
      const edited = await ok(w.lead.token, "chat.edit", { ...args, msg: source.msg_id, body: `change ${idempotency_key.length}` });
      expect((await ok(w.lead.token, "chat.version_status", { ...args, operation: "edit" })).record.committed.rev).toBe(edited.rev);
      expect((await ok(w.lead.token, "chat.version_status", { ...args, operation: "retract" })).record).toBeNull();
    }
    const unkeyed = await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    expect((await ok(w.lead.token, "chat.version_status", { c: "general", operation: "retract", idempotency_key: unkeyed.msg_id })).record).toBeNull();
  });

  it("requires exact bounded keys and a fixed operation, never disclosing a record for malformed input", async () => {
    const { w, args } = await setup();
    for (const operation of [undefined, null, "post", "EDIT", "retract:private-key", {}, []]) {
      expect((await tool(w.scout.longLived, { ...args, operation })).content[0].text).toContain("bad_request");
    }
    for (const idempotency_key of [undefined, null, "", 1, "x".repeat(65), {}, []]) {
      expect((await tool(w.scout.longLived, { ...args, operation: "edit", idempotency_key })).content[0].text).toContain("bad_request");
    }
    for (const idempotency_key of [" private-key", "private-key ", "absent", "x".repeat(64)]) {
      const r = await tool(w.scout.longLived, { ...args, operation: "edit", idempotency_key });
      expect(r.structuredContent.record).toBeNull(); expect(r.content[0].text).toContain("absence does not prove");
    }
  });
});
