import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeCursors, encodeCursors } from "../src/chat/catchup";
import { getChannelBySlug } from "../src/db/chat";
import { inboxStub } from "../src/chat/stubs";
import { call, channelWith, chatWorld, ok } from "./chat-helpers";
import { connectWithTokens, mcpPost, rpcBody } from "./oauth-helpers";
import { seedTenant } from "./helpers";

async function agent(token: string, args: Record<string, unknown> = {}, host = "acme") {
  const res = await SELF.fetch(`https://${host}.pimwell.test/agent/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_catchup", arguments: args } }),
  });
  return { status: res.status, result: res.status === 200 ? (await rpcBody(res)).result : null };
}

const cursorPayload = (value: unknown) => "c2." + btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unpack = (cursor: string) => JSON.parse(atob(cursor.slice(3).replace(/-/g, "+").replace(/_/g, "/")));

describe("server-owned catch-up checkpoint bindings", () => {
  it("issues reader-bound continuations across agent sessions and rejects another reader before any advancement", async () => {
    const w = await chatWorld(); await channelWith(w);
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout @tidy original" });
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const id = w.scout.agent.identity.id;
    const box = inboxStub(env, w.acme.id, id);
    const before = await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true });
    const first = (await agent(w.scout.longLived)).result.structuredContent;
    expect(first.next).toMatch(/^c2\./);
    expect(unpack(first.next)).toEqual({ tenant_id: w.acme.id, identity_id: id, cursors: { [ch.project_id]: source.head } });
    const resumed = await ok(w.scout.token, "chat.catchup", { since: first.next });
    expect(resumed.for_you).toEqual([]);
    expect(resumed.next).toBe(first.next);
    for (let i = 0; i < 3; i++) {
      const mismatch = await call(w.tidy.token, "chat.catchup", { since: first.next, advance: true, identity_id: id, tenant_id: w.acme.id });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.error).toBe("conflict");
      expect(JSON.stringify(mismatch.body)).not.toContain(ch.project_id);
      const mcp = (await agent(w.tidy.longLived, { since: first.next, identity_id: id })).result;
      expect(mcp.isError).toBe(true); expect(mcp.content[0].text).toContain("conflict");
    }
    expect(await box.list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    for (const reader of [id, w.tidy.agent.identity.id]) expect(await inboxStub(env, w.acme.id, reader).cursors(w.acme.id, reader)).toEqual({});
  });

  it("binds empty and read-only OAuth cursors to the human principal, not the connection or a body claim", async () => {
    const w = await chatWorld(); await channelWith(w);
    const native = await ok(w.lead.token, "chat.catchup", {});
    expect(unpack(native.next)).toEqual({ tenant_id: w.acme.id, identity_id: w.lead.identity.id, cursors: {} });
    const connection = await connectWithTokens(w.lead.token, { scope: "read" });
    const invoke = async (args: Record<string, unknown>) => (await rpcBody(await mcpPost("acme", connection.tokens.access_token, "tools/call", { name: "chat_catchup", arguments: args }))).result;
    expect((await invoke({ since: native.next, identity_id: w.scout.agent.identity.id })).structuredContent.next).toBe(native.next);
    const other = await ok(w.dev.token, "chat.catchup", {});
    const mismatch = await invoke({ since: other.next, identity_id: w.dev.identity.id });
    expect(mismatch.isError).toBe(true); expect(mismatch.content[0].text).toContain("conflict");
    const beta = await seedTenant("beta2");
    const foreign = cursorPayload({ ...unpack(native.next), tenant_id: beta.id });
    expect((await call(w.lead.token, "chat.catchup", { since: foreign, tenant_id: beta.id, advance: true })).status).toBe(409);
    expect((await invoke({ since: foreign, tenant_id: beta.id })).content[0].text).toContain("conflict");
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), connection.client_id).run();
    expect((await mcpPost("acme", connection.tokens.access_token, "tools/call", { name: "chat_catchup", arguments: { since: native.next } })).status).toBe(401);
    expect(await inboxStub(env, w.acme.id, w.lead.identity.id).cursors(w.acme.id, w.lead.identity.id)).toEqual({});
  });

  it("upgrades legacy unbound cursors without repairing future values and retains scoped readable keys", async () => {
    const w = await chatWorld(); await channelWith(w); await channelWith(w, "ops");
    const general = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const ops = (await getChannelBySlug(env.HUB_DB, w.acme.id, "ops"))!;
    const source = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout initial" });
    const base = { [general.project_id]: 0, [ops.project_id]: 0 };
    const upgraded = await ok(w.scout.token, "chat.catchup", { since: encodeCursors(base), scope: "general" });
    expect(unpack(upgraded.next)).toEqual({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, cursors: { ...base, [general.project_id]: source.head } });
    const edit = await ok(w.lead.token, "chat.edit", { c: "general", msg: source.msg_id, body: "@scout later edit" });
    const resumed = (await agent(w.scout.longLived, { since: upgraded.next, scope: "general" })).result.structuredContent;
    expect(resumed.for_you[0]).toMatchObject({ msg_id: source.msg_id, rev: 2 });
    expect(decodeCursors(resumed.next)).toEqual({ ...base, [general.project_id]: edit.head });
    const future = cursorPayload({ ...unpack(resumed.next), cursors: { ...base, [general.project_id]: edit.head + 1 } });
    expect((await call(w.scout.token, "chat.catchup", { since: future, advance: true })).status).toBe(409);
    const tiny = await ok(w.scout.token, "chat.catchup", { since: upgraded.next, budget: 100 });
    expect(decodeCursors(tiny.next)[general.project_id]).toBe(source.head);
    await ok(w.lead.token, "channel.remove_agent", { c: "ops", agent: "scout" });
    const removed = (await agent(w.scout.longLived, { since: resumed.next })).result.structuredContent;
    expect(decodeCursors(removed.next)).toEqual({ [general.project_id]: edit.head });
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
  });

  it("refuses malformed bound envelopes and map values rather than falling back to legacy or a claimed reader", async () => {
    const w = await chatWorld(); await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const binding = { tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id };
    const valid = { ...binding, cursors: { [ch.project_id]: 0 } };
    const malformed = [null, [], {}, { ...valid, identity_id: null }, { ...valid, tenant_id: "forged" },
      { ...valid, cursors: null }, { ...valid, cursors: [] }, { ...valid, cursors: { bad: 0 } },
      { ...valid, cursors: { [ch.project_id]: -1 } }, { ...valid, cursors: { [ch.project_id]: 1.5 } },
      { ...valid, cursors: { [ch.project_id]: "0" } }, { ...valid, cursors: { [ch.project_id]: Number.MAX_SAFE_INTEGER + 1 } },
      { ...valid, extra: true }, { ...binding, since: valid.cursors }];
    for (const value of malformed) {
      const r = (await agent(w.scout.longLived, { since: cursorPayload(value), ...binding })).result;
      expect(r.isError, JSON.stringify(value)).toBe(true); expect(r.content[0].text).toContain("bad_request");
    }
    for (const since of ["c2.not-json", "c3.e30", "c2." + "x".repeat(8192)]) expect((await call(w.scout.token, "chat.catchup", { since, advance: true })).status).toBe(400);
    // Namespace binding prevents accidental reuse; these unsigned values are not processing proof.
    const forgedButValid = (await agent(w.scout.longLived, { since: cursorPayload(valid) })).result;
    expect(forgedButValid.isError).toBeUndefined();
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
  });
  it("binds agent mentions, followed threads and channel cursors to the exact principal and conversation", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const root = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout source evidence, identity_id=forged" });
    await ok(w.scout.token, "chat.post", { c: "general", body: "following", reply_to: root.msg_id, after: root.head });
    await ok(w.dev.token, "chat.post", { c: "general", body: "new incoming reply", reply_to: root.msg_id });
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const before = await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true });
    const args = { tenant_id: "forged", identity_id: w.lead.identity.id, conversation_id: "forged", scope: "general" };
    for (let i = 0; i < 3; i++) {
      const r = (await agent(w.scout.longLived, args)).result.structuredContent;
      expect(r).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, advanced: false });
      expect(r.for_you[0]).toMatchObject({ channel: "general", conversation_id: ch.project_id, msg_id: root.msg_id, author: { identity_id: w.lead.identity.id } });
      expect(r.threads[0].conversation_id).toBe(ch.project_id);
      expect(r.conversations[0]).toMatchObject({ channel: "general", conversation_id: ch.project_id, since: 0, head: 3 });
      expect(decodeCursors(r.next)).toEqual({ [ch.project_id]: 3 });
    }
    expect(await box.cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
    expect(await box.list(w.acme.id, w.scout.agent.identity.id, { after: 0, limit: 100, include_acked: true })).toEqual(before);
    const events = await env.HUB_DB.prepare("SELECT kind FROM event WHERE tenant_id = ? AND kind IN ('chat.post', 'chat.tripwire')").bind(w.acme.id).all();
    expect(events.results.map((x) => x.kind)).toEqual(["chat.post", "chat.post", "chat.post"]);
  });

  it("returns the authenticated browser or read-only OAuth principal even for empty/scoped checkpoints", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const args = { identity_id: w.scout.agent.identity.id, tenant_id: "forged", conversation_id: "forged", scope: "#general" };
    const empty = await ok(w.dev.token, "chat.catchup", args);
    expect(empty).toMatchObject({ tenant_id: w.acme.id, identity_id: w.dev.identity.id, for_you: [], conversations: [], quiet: [] });
    const connection = await connectWithTokens(w.lead.token);
    const access = connection.tokens.access_token;
    const invoke = async (a: Record<string, unknown>) => (await rpcBody(await mcpPost("acme", access, "tools/call", { name: "chat_catchup", arguments: a }))).result;
    expect((await invoke(args)).structuredContent).toMatchObject({ tenant_id: w.acme.id, identity_id: w.lead.identity.id, for_you: [] });
    const source = await ok(w.dev.token, "chat.post", { c: "general", body: "@lead @scout request evidence" });
    const r = (await invoke(args)).structuredContent;
    expect(r.identity_id).toBe(w.lead.identity.id);
    expect(r.for_you[0]).toMatchObject({ conversation_id: ch.project_id, msg_id: source.msg_id, author: { identity_id: w.dev.identity.id, session_kind: "browser" } });
    expect(r.conversations[0].conversation_id).toBe(ch.project_id);
    expect((await invoke({ ...args, advance: true })).isError).toBe(true);
    for (const identity of [w.lead.identity.id, w.dev.identity.id, w.scout.agent.identity.id]) {
      expect(await inboxStub(env, w.acme.id, identity).cursors(w.acme.id, identity)).toEqual({});
    }
    await env.HUB_DB.prepare("UPDATE oauth_grant SET revoked_at = ? WHERE client_id = ?").bind(Date.now(), connection.client_id).run();
    const revoked = await mcpPost("acme", access, "tools/call", { name: "chat_catchup", arguments: args });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(ch.project_id);
  });

  it("keeps equal message numbers in separate conversations and scoped cursors bound to the reader", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await channelWith(w, "ops");
    const general = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    const ops = (await getChannelBySlug(env.HUB_DB, w.acme.id, "ops"))!;
    const sources = [];
    for (const c of ["general", "ops"]) sources.push(await ok(w.lead.token, "chat.post", { c, body: `@scout ${c} original` }));
    const r = (await agent(w.scout.longLived)).result.structuredContent;
    expect(r.for_you.map((m: any) => [m.conversation_id, m.seq, m.msg_id])).toEqual([
      [general.project_id, 1, sources[0].msg_id], [ops.project_id, 1, sources[1].msg_id],
    ]);
    expect(r.conversations.map((c: any) => [c.channel, c.conversation_id])).toEqual([["general", general.project_id], ["ops", ops.project_id]]);
    expect(decodeCursors(r.next)).toEqual({ [general.project_id]: 1, [ops.project_id]: 1 });
    await ok(w.scout.token, "chat.mark_read", { c: "general", seq: 1 });
    await ok(w.lead.token, "chat.edit", { c: "general", msg: sources[0].msg_id, body: "@scout changed evidence" });
    const revised = (await agent(w.scout.longLived, { scope: "general" })).result.structuredContent;
    expect(revised.identity_id).toBe(w.scout.agent.identity.id);
    expect(revised.for_you[0]).toMatchObject({ conversation_id: general.project_id, msg_id: sources[0].msg_id, seq: 1, rev: 2 });
    expect(decodeCursors(revised.next)).toEqual({ [general.project_id]: 2 });
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({ [general.project_id]: 1 });
    expect(await inboxStub(env, w.acme.id, w.tidy.agent.identity.id).cursors(w.acme.id, w.tidy.agent.identity.id)).toEqual({});
  });

  it("retains conversation binding in budget fallback without changing cap/cursor semantics", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    for (let i = 0; i < 6; i++) {
      const root = await ok(w.lead.token, "chat.post", { c: "general", body: `unfollowed root ${i} ${"x".repeat(80)}` });
      await ok(w.dev.token, "chat.post", { c: "general", body: `reply ${i}`, reply_to: root.msg_id });
    }
    const r = (await agent(w.scout.longLived, { budget: 150 })).result.structuredContent;
    expect(r).toMatchObject({ tenant_id: w.acme.id, identity_id: w.scout.agent.identity.id, conversations: [], for_you: [], threads: [] });
    expect(r.quiet).toEqual([{ channel: "general", conversation_id: ch.project_id, head: 12, new: 12, agent: 0 }]);
    expect(decodeCursors(r.next)).toEqual({ [ch.project_id]: 12 });
    expect(await inboxStub(env, w.acme.id, w.scout.agent.identity.id).cursors(w.acme.id, w.scout.agent.identity.id)).toEqual({});
  });

  it("never exposes inaccessible conversation ids or accepts a caller-selected tenant/principal", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, "general"))!;
    await ok(w.lead.token, "chat.post", { c: "general", body: "@scout private original" });
    const args = { identity_id: w.scout.agent.identity.id, conversation_id: ch.project_id };
    const tidy = (await agent(w.tidy.longLived, args)).result.structuredContent;
    expect(tidy).toMatchObject({ tenant_id: w.acme.id, identity_id: w.tidy.agent.identity.id, conversations: [], for_you: [], threads: [], quiet: [] });
    expect(JSON.stringify(tidy)).not.toContain(ch.project_id);
    expect((await agent(w.tidy.longLived, { ...args, scope: "general" })).result.isError).toBe(true);
    await ok(w.lead.token, "channel.remove_agent", { c: "general", agent: "scout" });
    const removed = (await agent(w.scout.longLived, args)).result.structuredContent;
    expect(removed.identity_id).toBe(w.scout.agent.identity.id);
    expect(JSON.stringify(removed)).not.toContain(ch.project_id);
    await seedTenant("beta2");
    expect((await agent(w.scout.longLived, { ...args, tenant_id: w.acme.id }, "beta2")).status).toBe(401);
  });
});
