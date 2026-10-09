import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

let rpcId = 0;
async function agentRpc(token: string, method: string, params: Record<string, unknown>, slug = "acme") {
  return SELF.fetch(`https://${slug}.pimwell.test/agent/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await agentRpc(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  return (await rpcBody(r)).result;
}
async function setup() {
  const w = await chatWorld();
  await channelWith(w);
  const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout original product request" });
  const evidence = { msg_id: source.msg_id, rev: 1, author_id: w.lead.identity.id };
  const args = { c: "general", body: "@tidy private tested result", after: source.head, idempotency_key: "persisted-intent", response_to: evidence };
  return { w, source, evidence, args };
}

describe("read-only source-bound response reconciliation", () => {
  it("exposes read-only discovery and distinguishes missing records from ordinary replies", async () => {
    const { w, source } = await setup();
    const tools = (await rpcBody(await agentRpc(w.scout.longLived, "tools/list", {}))).result.tools;
    const definition = tools.find((t: { name: string }) => t.name === "chat_response_status");
    expect(definition.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(definition.inputSchema.required).toEqual(["c", "msg"]);
    await tool(w.scout.longLived, "chat_post", { c: "general", body: "ordinary reply", after: source.head, reply_to: source.msg_id, idempotency_key: "ordinary" });
    const r = await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.seq });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, channel: "general", head: 2, source: { msg_id: source.msg_id, seq: 1, rev: 1, author_id: w.lead.identity.id, retracted: false }, progress: null, result: null });
    expect(r.content[0].text).toContain("ordinary replies are not tracked here");
    expect(r.content[0].text).toContain("not task completion or execution authority");
  });

  it("reconciles both caller-only slots without a payload and has no posting/wake/cursor side effects", async () => {
    const { w, source, args, evidence } = await setup();
    const progress = (await tool(w.scout.longLived, "chat_post", { ...args, body: "@tidy private testing checkpoint", response_to: { ...evidence, stage: "progress" } })).structuredContent;
    const result = (await tool(w.scout.longLived, "chat_post", { ...args, after: progress.head })).structuredContent;
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    for (let i = 0; i < 35; i++) {
      const r = await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id, identity_id: w.tidy.agent.identity.id, tenant_id: "forged", body: "do not log this" });
      expect(r.structuredContent).toMatchObject({ identity_id: w.scout.agent.identity.id, conversation_id: ch.project_id, head: result.head,
        progress: { source: evidence, committed: { msg_id: progress.msg_id, seq: progress.seq, rev: 1 }, current: { rev: 1, retracted: false } },
        result: { source: evidence, committed: { msg_id: result.msg_id, seq: result.seq, rev: 1 }, current: { rev: 1, retracted: false } },
      });
      expect(JSON.stringify(r)).not.toMatch(/private|fingerprint|woke|suppressed|persisted-intent/);
    }
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(result.head);
    const wakes = await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    expect(wakes.items).toHaveLength(2);
    const events = await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all<{ kind: string; summary: string }>();
    expect(events.results.filter((r) => r.kind === "chat.post")).toHaveLength(2);
    for (const r of events.results.filter((r) => r.kind === "mcp.call" && r.summary.includes("chat.response_status"))) {
      expect(r.summary).not.toMatch(/do not log|forged|private/);
      expect(r.summary).not.toContain(source.msg_id);
    }
    // Repeated status reads never reserve post-rate slots.
    expect((await tool(w.scout.longLived, "chat_post", { c: "general", body: "new unrelated checkpoint", after: result.head, idempotency_key: "new" })).isError).toBeUndefined();
    const other = (await tool(w.tidy.longLived, "chat_response_status", { c: "general", msg: source.msg_id, identity_id: w.scout.agent.identity.id })).structuredContent;
    expect(other).toMatchObject({ identity_id: w.tidy.agent.identity.id, progress: null, result: null });
  });

  it("returns original commit evidence separately from current edits/retractions and source revisions", async () => {
    const { w, source, args, evidence } = await setup();
    const committed = (await tool(w.scout.longLived, "chat_post", args)).structuredContent;
    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "revised request" });
    await ok(w.scout.token, "chat.edit", { c: "general", msg: committed.msg_id, body: "edited result", after: 3 });
    const edited = (await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).structuredContent;
    expect(edited).toMatchObject({ head: 4, source: { rev: 2, retracted: false }, result: { source: evidence, committed: { rev: 1 }, current: { rev: 2, retracted: false } } });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: committed.msg_id });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    const r = (await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: `#${source.seq}` })).structuredContent;
    expect(r).toMatchObject({ head: 6, source: { rev: 3, retracted: true }, progress: null,
      result: { source: evidence, committed: { msg_id: committed.msg_id, seq: committed.seq, rev: 1 }, current: { rev: 3, retracted: true } },
    });
    expect(r.text).toContain("source_r=1");
    expect(r.text).toContain("current_r=3 retracted");
    expect(JSON.stringify(r)).not.toMatch(/private tested|revised request|fingerprint/);
  });

  it("keeps read scope independent of posting policy while refusing revoked channel/tenant access", async () => {
    const { w, source, args } = await setup();
    await tool(w.scout.longLived, "chat_post", args);
    await channelWith(w, "other");
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "other", msg: source.msg_id })).content[0].text).toContain("not_found");
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    await ok(w.lead.token, "chat.agents_disable");
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).isError).toBeUndefined();
    expect((await tool(w.scout.longLived, "chat_post", args)).isError).toBe(true);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).content[0].text).toContain("not_found");
    await seedTenant("beta2");
    expect((await agentRpc(w.scout.longLived, "tools/call", { name: "chat_response_status", arguments: { c: "general", msg: source.msg_id } }, "beta2")).status).toBe(401);
  });

  it("allows a read-only OAuth grant to reconcile only its human principal, not an agent's ledger", async () => {
    const { w, source, args, evidence } = await setup();
    await tool(w.scout.longLived, "chat_post", args);
    const write = (await connectWithTokens(w.lead.token, { scope: "read write" })).tokens.access_token;
    const posted = (await rpcBody(await mcpPost("acme", write, "tools/call", { name: "chat_post", arguments: { ...args, body: "assistant-authored evidence", after: 2, response_to: evidence } }))).result;
    expect(posted.isError).toBeUndefined();
    const readConnection = await connectWithTokens(w.lead.token);
    const read = readConnection.tokens.access_token;
    const query = { c: "general", msg: source.msg_id, identity_id: w.scout.agent.identity.id, intent: { body: "assistant-authored evidence", response_to: evidence } };
    const status = (await rpcBody(await mcpPost("acme", read, "tools/call", { name: "chat_response_status", arguments: query }))).result;
    expect(status.isError).toBeUndefined();
    expect(status.structuredContent).toMatchObject({ identity_id: w.lead.identity.id, result: { committed: { msg_id: posted.structuredContent.msg_id } }, intent_check: { stage: "result", matches: true } });
    const mismatch = (await rpcBody(await mcpPost("acme", read, "tools/call", { name: "chat_response_status", arguments: { ...query, intent: { body: args.body, response_to: evidence } } }))).result;
    expect(mismatch.structuredContent.intent_check.matches).toBe(false);
    const denied = (await rpcBody(await mcpPost("acme", read, "tools/call", { name: "chat_post", arguments: args }))).result;
    expect(denied.isError).toBe(true);
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), readConnection.client_id).run();
    expect((await mcpPost("acme", read, "tools/call", { name: "chat_response_status", arguments: query })).status).toBe(401);
  });

  it("compares the exact persisted intent read-only, without treating missing slots or current text as a match", async () => {
    const { w, source, args, evidence } = await setup();
    const refs = [{ kind: "ticket", key: "missing#abcd" }, { kind: "commit", key: "missing@abc1234" }];
    const intent = { body: args.body, refs, response_to: evidence };
    const query = { c: "general", msg: source.seq, intent };
    expect((await tool(w.scout.longLived, "chat_response_status", query)).structuredContent.intent_check).toEqual({ stage: "result", matches: null });
    const postResult = await tool(w.scout.longLived, "chat_post", { ...args, refs });
    expect(postResult.isError, JSON.stringify(postResult)).toBeUndefined();
    const posted = postResult.structuredContent;
    for (const changed of [
      { ...intent, body: `${args.body} ` }, { ...intent, refs: [...refs].reverse() }, { ...intent, refs: [] },
      { ...intent, response_to: { ...evidence, rev: 2 } },
      { ...intent, response_to: { ...evidence, author_id: w.tidy.agent.identity.id } },
      { ...intent, response_to: { ...evidence, msg_id: posted.msg_id } },
    ]) {
      expect((await tool(w.scout.longLived, "chat_response_status", { ...query, intent: changed })).structuredContent.intent_check).toEqual({ stage: "result", matches: false });
    }
    const original = await tool(w.scout.longLived, "chat_response_status", query);
    expect(original.structuredContent.intent_check).toEqual({ stage: "result", matches: true });
    expect(original.content[0].text).toContain("not current-source validation or permission to resend");
    expect(JSON.stringify(original)).not.toMatch(/private tested|missing#abcd|fingerprint|persisted-intent/);
    expect((await tool(w.scout.longLived, "chat_response_status", { ...query, intent: { ...intent, response_to: { ...evidence, stage: "progress" } } })).structuredContent.intent_check).toEqual({ stage: "progress", matches: null });
    expect((await tool(w.tidy.longLived, "chat_response_status", { ...query, identity_id: w.scout.agent.identity.id })).structuredContent.intent_check.matches).toBeNull();
    expect((await tool(w.scout.longLived, "chat_response_status", { ...query, c: "inaccessible" })).content[0].text).toContain("not_found");
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.seq })).structuredContent).not.toHaveProperty("intent_check");
    const progressIntent = { body: "bounded testing checkpoint", response_to: { ...evidence, stage: "progress" } };
    const progress = await tool(w.scout.longLived, "chat_post", { ...args, ...progressIntent, after: posted.head });
    expect(progress.isError).toBeUndefined();
    expect((await tool(w.scout.longLived, "chat_response_status", { ...query, intent: progressIntent })).structuredContent.intent_check).toEqual({ stage: "progress", matches: true });
    expect((await tool(w.scout.longLived, "chat_response_status", { ...query, intent: { ...intent, response_to: { ...evidence, stage: "result" } } })).structuredContent.intent_check).toEqual({ stage: "result", matches: true });
  });

  it("compares original evidence after source/response retraction and under posting controls without side effects", async () => {
    const { w, source, args, evidence } = await setup();
    const intent = { body: args.body, response_to: { ...evidence, stage: "result" } };
    const posted = (await tool(w.scout.longLived, "chat_post", args)).structuredContent;
    await ok(w.lead.token, "chat.retract", { c: "general", msg: posted.msg_id });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: source.msg_id });
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    await ok(w.lead.token, "chat.agents_disable");
    await ok(w.lead.token, "channel.archive", { c: "general" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const box = inboxStub(env, w.acme.id, w.tidy.agent.identity.id);
    const before = await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    for (let i = 0; i < 35; i++) {
      const r = await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id, intent });
      expect(r.structuredContent).toMatchObject({ head: 4, source: { rev: 2, retracted: true }, result: { current: { retracted: true } }, intent_check: { stage: "result", matches: true } });
    }
    expect(await box.list(w.acme.id, w.tidy.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await conversationStub(env, w.acme.id, ch.project_id).head(w.acme.id, ch.project_id)).toBe(4);
    expect((await tool(w.scout.longLived, "chat_post", args)).isError).toBe(true);
    const events = await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE tenant_id = ? AND identity_id = ?").bind(w.acme.id, w.scout.agent.identity.id).all<{ kind: string; summary: string }>();
    expect(events.results.filter((r) => r.kind === "chat.post")).toHaveLength(1);
    expect(events.results.filter((r) => r.kind === "mcp.call" && r.summary.includes("chat.response_status")).map((r) => r.summary).join("\n")).not.toMatch(/private tested|persisted-intent|fingerprint/);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id, intent })).content[0].text).toContain("not_found");
  }, 20_000);

  it("validates bounded comparison input and never accepts a caller-selected digest", async () => {
    const { w, source, args, evidence } = await setup();
    const intent = { body: args.body, response_to: evidence };
    const tools = (await rpcBody(await agentRpc(w.scout.longLived, "tools/list", {}))).result.tools;
    expect(tools.find((t: { name: string }) => t.name === "chat_response_status").inputSchema.properties.intent.required).toEqual(["body", "response_to"]);
    for (const invalid of [null, [], {}, { ...intent, body: " " }, { ...intent, body: "é".repeat(4097) },
      { ...intent, response_to: { ...evidence, stage: "new-slot" } }, { ...intent, refs: Array(51).fill({ kind: "msg", key: "general/1" }) },
      { ...intent, fingerprint: "chosen" }, { ...intent, idempotency_key: "new" }, { ...intent, response_to: undefined }]) {
      expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id, intent: invalid })).content[0].text).toContain("bad_request");
    }
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id, intent, fingerprint: "ignored" })).structuredContent.intent_check.matches).toBeNull();
  });

  it("rejects malformed/missing source identifiers and system sources without ledger disclosure", async () => {
    const { w, source } = await setup();
    for (const msg of [undefined, null, "", 0, -1, {}, [], "handle", "general/1"]) {
      expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg })).content[0].text).toContain("bad_request");
    }
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: "01AAAAAAAAAAAAAAAAAAAAAAAA" })).content[0].text).toContain("not_found");
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const notice = await conversationStub(env, w.acme.id, ch.project_id).notice(w.acme.id, ch.project_id, "system notice", Date.now());
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: notice.msg_id })).content[0].text).toContain("not_found");
    expect((await tool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).structuredContent.head).toBe(2);
  });
});
