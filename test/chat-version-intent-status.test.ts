import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/chat/conversationDO";
import { LIMITS } from "../src/chat/rules";
import { versionIntentFingerprint } from "../src/chat/versionIntent";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { inDO } from "./do-helper";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";

async function tool(token: string, args: Record<string, unknown>, host = "acme") {
  const response = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_version_status", arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await rpcBody(response)).result;
}
async function setup() {
  const w = await chatWorld(); await channelWith(w);
  const source = await ok(w.scout.token, "chat.post", { c: "general", body: "@tidy original", after: 0, idempotency_key: "post-private" });
  const intent = { msg: source.msg_id, body: "private replacement @tidy" };
  const args = { c: "general", operation: "edit", idempotency_key: "edit-private" };
  const edited = await ok(w.scout.token, "chat.edit", { ...args, ...intent, after: source.head });
  const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
  return { w, source, intent, args, edited, ch, conv: conversationStub(env, w.acme.id, ch.project_id) };
}

describe("read-only original version intent comparison", () => {
  it("compares exact parsed target/body without replay even after a later operator retraction", async () => {
    const { w, source, intent, args, edited, ch, conv } = await setup();
    const retractArgs = { c: "general", operation: "retract", idempotency_key: "retract-private" };
    const gone = await ok(w.lead.token, "chat.retract", { ...retractArgs, msg: source.seq });
    const box = inboxStub(env, w.acme.id, w.tidy.agent.identity.id);
    const attention = await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const expiry = (await ok(w.scout.token, "chat.version_status", args)).record.expires_at;
    expect((await ok(w.scout.token, "chat.version_status", args))).not.toHaveProperty("intent_check");
    for (let i = 0; i < 12; i++) {
      const r = await tool(w.scout.longLived, { ...args, intent, identity_id: w.lead.identity.id, fingerprint: "forged" });
      expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, conversation_id: ch.project_id,
        intent_check: { matches: true, reason: "match" }, record: { committed: { msg_id: source.msg_id, seq: edited.seq, rev: 2 }, current: { rev: 3, retracted: true }, expires_at: expiry } });
      expect(r.content[0].text).toContain("not current-text validation");
      expect(JSON.stringify(r)).not.toMatch(/private|fingerprint|forged|@tidy|idempotency_key/);
    }
    expect((await tool(w.scout.longLived, { ...args, intent: { ...intent, body: "other replacement" } })).structuredContent.intent_check).toEqual({ matches: false, reason: "mismatch" });
    expect((await ok(w.scout.token, "chat.version_status", { ...args, intent: { ...intent, msg: source.seq } })).intent_check).toEqual({ matches: false, reason: "mismatch" });
    // Valid but unavailable ids are comparison input, not authority to fetch another message.
    expect((await tool(w.scout.longLived, { ...args, intent: { ...intent, msg: "00000000000000000000000000" } })).structuredContent.intent_check).toEqual({ matches: false, reason: "mismatch" });
    // Numeric/#/whitespace aliases normalize exactly like version writes; id vs number remains distinct.
    for (const msg of [source.seq, String(source.seq), ` #${source.seq} `]) {
      expect((await ok(w.lead.token, "chat.version_status", { ...retractArgs, intent: { msg } })).intent_check).toEqual({ matches: true, reason: "match" });
    }
    expect((await ok(w.lead.token, "chat.version_status", { ...retractArgs, intent: { msg: source.seq, body: null } })).intent_check.matches).toBe(true);
    expect((await ok(w.lead.token, "chat.version_status", { ...retractArgs, intent: { msg: source.msg_id } })).intent_check.matches).toBe(false);
    expect(await conv.head(w.acme.id, ch.project_id)).toBe(gone.head);
    expect(await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(attention);
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    const events = (await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ?").bind(w.acme.id).all<{ kind: string; summary: string }>()).results;
    expect(events.filter((e) => e.kind === "chat.edit")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "chat.retract")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "mcp.call" && e.summary.includes("chat.version_status")).map((e) => e.summary).join("\n")).not.toMatch(/private|fingerprint|forged|@tidy/);
  });

  it("keeps independent caller/channel/operation and read-only OAuth boundaries under posting controls", async () => {
    const { w, source, intent, args } = await setup(); await channelWith(w, "other");
    for (const [token, extra] of [[w.tidy.longLived, {}], [w.scout.longLived, { c: "other" }], [w.scout.longLived, { idempotency_key: "missing" }]] as const) {
      const r = await tool(token, { ...args, ...extra, intent });
      expect(r.structuredContent.intent_check).toEqual({ matches: null, reason: "missing" });
    }
    expect((await tool(w.scout.longLived, { ...args, operation: "retract", intent: { msg: source.msg_id } })).structuredContent.intent_check.reason).toBe("missing");
    const own = await ok(w.lead.token, "chat.post", { c: "general", body: "human original" });
    const humanIntent = { msg: own.msg_id, body: "human private replacement" };
    await ok(w.lead.token, "chat.edit", { ...args, ...humanIntent });
    const conn = await connectWithTokens(w.lead.token);
    const query = { ...args, intent: humanIntent, identity_id: w.scout.agent.identity.id };
    const r = (await rpcBody(await mcpPost("acme", conn.tokens.access_token, "tools/call", { name: "chat_version_status", arguments: query }))).result;
    expect(r.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, intent_check: { matches: true, reason: "match" } });
    expect((await tool(w.scout.longLived, query)).structuredContent.intent_check.matches).toBe(false);
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    await ok(w.lead.token, "chat.agents_disable"); await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await tool(w.scout.longLived, { ...args, intent })).structuredContent.intent_check.matches).toBe(true);
    expect((await call(w.scout.token, "chat.edit", { ...args, ...intent, after: 2 })).status).not.toBe(200);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const denied = await tool(w.scout.longLived, { ...args, intent });
    expect(denied.content[0].text).toContain("not_found"); expect(denied.structuredContent).toBeUndefined();
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), conn.client_id).run();
    expect((await mcpPost("acme", conn.tokens.access_token, "tools/call", { name: "chat_version_status", arguments: query })).status).toBe(401);
  });

  it("rejects malformed, operation-inconsistent or oversized intents and private nested fields", async () => {
    const { w, source, intent, args } = await setup();
    for (const invalid of [null, [], "payload", {}, { msg: source.msg_id }, { ...intent, msg: 0 }, { ...intent, msg: Number.MAX_SAFE_INTEGER + 1 },
      { ...intent, body: null }, { ...intent, body: " " }, { ...intent, body: "x".repeat(8193) }, { ...intent, body: "é".repeat(4097) },
      ...["fingerprint", "idempotency_key", "after", "refs", "operation", "author_id"].map((k) => ({ ...intent, [k]: "forged" }))]) {
      const r = await tool(w.scout.longLived, { ...args, intent: invalid });
      expect(r.content[0].text).toContain("bad_request"); expect(r.structuredContent).toBeUndefined();
    }
    const r = await tool(w.scout.longLived, { ...args, operation: "retract", intent });
    expect(r.content[0].text).toContain("bad_request");
    for (const body of ["x".repeat(8192), "é".repeat(4096)]) {
      expect((await tool(w.scout.longLived, { ...args, intent: { ...intent, body } })).structuredContent.intent_check).toEqual({ matches: false, reason: "mismatch" });
    }
    expect((await tool(w.scout.longLived, { ...args, intent })).structuredContent.intent_check.matches).toBe(true);
  });

  it("compares fresh-object durable snapshots without writes, preserving legacy/missing uncertainty and expiry", async () => {
    const { w, source, intent, args, ch, conv } = await setup();
    const fingerprint = await versionIntentFingerprint(intent);
    await inDO(conv, async (_o, state) => {
      const fresh = new Conversation(state, env);
      // RPC optional comparison is shared with ordinary status, not a public supplied digest.
      const query = () => fresh.versionStatus(w.acme.id, ch.project_id, w.scout.agent.identity.id, "edit", args.idempotency_key, fingerprint);
      const before = state.storage.sql.exec("SELECT * FROM idem ORDER BY identity_id, key").toArray();
      const original = await query();
      expect(original).toMatchObject({ intent_check: { matches: true, reason: "match" } });
      expect((await query()).record!.expires_at).toBe(original.record!.expires_at);
      expect(state.storage.sql.exec("SELECT * FROM idem ORDER BY identity_id, key").toArray()).toEqual(before);
      await expect(fresh.versionStatus("wrong-tenant", ch.project_id, w.scout.agent.identity.id, "edit", args.idempotency_key, fingerprint)).rejects.toThrow("another tenant or owner");
      state.storage.sql.exec("DELETE FROM msg WHERE msg_id = ?", source.msg_id);
      expect(await query()).toMatchObject({ record: { current: null }, intent_check: { matches: true, reason: "match" } });
      const row = state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM idem WHERE identity_id = ? AND key = ?", w.scout.agent.identity.id, "edit:edit-private").toArray()[0]!;
      state.storage.sql.exec("UPDATE idem SET result_json = ? WHERE identity_id = ? AND key = ?", JSON.stringify(JSON.parse(row.result_json).result), w.scout.agent.identity.id, "edit:edit-private");
      expect(await query()).toMatchObject({ record: { intent_bound: false }, intent_check: { matches: null, reason: "unbound" } });
      state.storage.sql.exec("UPDATE idem SET created_at = ? WHERE identity_id = ? AND key = ?", Date.now() - LIMITS.IDEM_TTL_MS, w.scout.agent.identity.id, "edit:edit-private");
      const expired = state.storage.sql.exec("SELECT * FROM idem ORDER BY identity_id, key").toArray();
      expect(await query()).toMatchObject({ record: null, intent_check: { matches: null, reason: "missing" } });
      expect(state.storage.sql.exec("SELECT * FROM idem ORDER BY identity_id, key").toArray()).toEqual(expired);
    });
  });
});
