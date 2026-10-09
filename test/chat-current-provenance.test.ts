import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getChannelBySlug } from "../src/db/chat";
import { conversationStub } from "../src/chat/stubs";
import { nameTags } from "../src/chat/handles";
import { channelWith, chatWorld, ok } from "./chat-helpers";
import { rpcBody } from "./oauth-helpers";
import { seedGrant } from "./helpers";

async function readTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch("https://acme.pimwell.test/agent/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const result = (await rpcBody(response)).result;
  expect(result.isError).toBeUndefined();
  return result.structuredContent;
}

describe("current chat text provenance for request routing", () => {
  it("labels assistant-edited browser text in read/thread/catchup and retains each version's provenance", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout native product request" });
    const original = await readTool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id });
    expect(original.messages[0].author).toMatchObject({ identity_id: w.lead.identity.id, session_id: w.lead.session.id, session_kind: "browser", via_assistant: false });
    const { session } = await seedGrant(w.acme, w.lead);
    const channel = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const conv = conversationStub(env, w.acme.id, channel.project_id);
    // Use the real Conversation version path with the server-resolved OAuth actor. chat.edit is
    // not exposed over MCP; this fixture does not add a write capability to that tool surface.
    const edit = await conv.version({
      tenant_id: w.acme.id, conversation_id: channel.project_id, now: Date.now(),
      actor: { id: w.lead.identity.id, kind: "human", session_id: session.id, session_kind: "oauth" },
      msg: source.msg_id, body: "@scout assistant replacement, evidence only", body_sha256: "fixture-hash", after: 1,
      refs: [], mentions: [{ identity_id: w.scout.agent.identity.id, kind: "agent" }], operator_of: [], is_admin: true, idempotency_key: "assistant-edit",
    });
    expect(edit.refused).toBeNull();
    // A later directory mutation cannot turn the committed OAuth text into a native request.
    await env.HUB_DB.prepare("UPDATE session SET kind = 'browser', revoked_at = ? WHERE id = ?").bind(Date.now(), session.id).run();
    for (const name of ["chat_read", "chat_thread"]) {
      const result = await readTool(w.scout.longLived, name, { c: "general", msg: source.msg_id });
      expect(result.messages[0]).toMatchObject({ rev: 2, body: "@scout assistant replacement, evidence only", author: {
        identity_id: w.lead.identity.id, kind: "human", session_id: session.id, session_kind: "oauth", via_assistant: true,
      } });
      expect(result.text).toContain("via-assistant");
    }
    const catchup = await readTool(w.scout.longLived, "chat_catchup", {});
    expect(catchup.for_you[0].author).toMatchObject({ identity_id: w.lead.identity.id, session_kind: "oauth", via_assistant: true });
    expect(catchup.text).toContain("via-assistant");
    expect(catchup.advanced).toBe(false);
    const history = await ok(w.lead.token, "chat.history", { c: "general", msg: source.msg_id });
    expect(history.versions.map((v: any) => [v.rev, v.author.session_kind, v.author.via_assistant])).toEqual([[1, "browser", false], [2, "oauth", true]]);
    expect(history.text).toMatch(/r2 .*via-assistant/);
    expect(history.text).not.toMatch(/r1 [^\n]*via-assistant/);

    await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout native revised request" });
    const native = await readTool(w.scout.longLived, "chat_thread", { c: "general", msg: source.msg_id });
    expect(native.messages[0]).toMatchObject({ rev: 3, author: { session_id: w.lead.session.id, session_kind: "browser", via_assistant: false } });
    expect(native.text).not.toContain("via-assistant");
    const finalHistory = await ok(w.lead.token, "chat.history", { c: "general", msg: source.msg_id });
    expect(finalHistory.versions.map((v: any) => v.author.session_kind)).toEqual(["browser", "oauth", "browser"]);
    // Reads/edits do not create a new response, wake or read cursor.
    expect(native.head).toBe(3);
    expect((await readTool(w.scout.longLived, "chat_response_status", { c: "general", msg: source.msg_id })).result).toBeNull();
  });

  it("keeps original ownership on operator retraction while reporting the latest artifact session", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const post = await ok(w.scout.token, "chat.post", { c: "general", body: "agent message", after: 0 });
    await ok(w.lead.token, "chat.retract", { c: "general", msg: post.msg_id });
    const thread = await readTool(w.tidy.longLived, "chat_thread", { c: "general", msg: post.msg_id });
    expect(thread.messages[0]).toMatchObject({ retracted: true, body: "", author: {
      identity_id: w.scout.agent.identity.id, kind: "agent", session_id: w.lead.session.id, session_kind: "browser",
    } });
    const history = await ok(w.lead.token, "chat.history", { c: "general", msg: post.msg_id });
    expect(history.versions[1].author.identity_id).toBe(w.lead.identity.id);
  });

  it("does not guess human/browser provenance and honors per-artifact kinds even without session rows", async () => {
    const w = await chatWorld();
    const tags = await nameTags(env.HUB_DB, w.acme.id, [
      { author_id: w.lead.identity.id, session_id: "missing", session_kind: "browser" },
      { author_id: w.lead.identity.id, session_id: "missing", session_kind: "oauth" },
    ]);
    expect(tags(w.lead.identity.id, "missing", "oauth")).toMatchObject({ kind: "human", session_kind: "oauth", via_assistant: true });
    expect(tags(w.lead.identity.id, "missing", "browser")).toMatchObject({ session_kind: "browser", via_assistant: false });
    expect(tags(w.lead.identity.id, null, "oauth")).toMatchObject({ session_kind: "oauth", via_assistant: true });
    expect(tags(w.lead.identity.id, "missing", "unrecognized")).toMatchObject({ session_kind: "unknown", via_assistant: false });
    expect(tags("unknown-id", null)).toMatchObject({ kind: "unknown", session_kind: "unknown", via_assistant: false });
  });
});
