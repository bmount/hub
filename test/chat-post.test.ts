import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { DATA_NOTE } from "../src/mcp/render";
import { seedHuman } from "./helpers";
import { call, channelWith, chatWorld, ok, type World } from "./chat-helpers";

async function conv(w: World, slug = "general") {
  const ch = (await getChannelBySlug(env.HUB_DB, w.acme.id, slug))!;
  return { ch, stub: conversationStub(env, w.acme.id, ch.project_id) };
}
const inboxOf = async (w: World, id: string) => (await inboxStub(env, w.acme.id, id).list(w.acme.id, id, { after: 0, limit: 100, include_acked: true })).items;

async function chatHttp(token: string, method: string, input: Record<string, unknown> = {}) {
  const read = method.startsWith('get');
  const query = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  const response = await SELF.fetch(`https://acme.pimwell.test/chat/v1/${method}${read ? '?' + query : ''}`, {
    method: read ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(read ? {} : { body: JSON.stringify(input) }),
  });
  return { status: response.status, body: await response.json() as { ok: boolean; result: any; error: { code: string } } };
}

describe("chat HTTP update stream", () => {
  it("sends, replies, edits and retracts without duplicates after offset; enforces audience and replay intent", async () => {
    const w = await chatWorld();
    await channelWith(w, 'general', ['scout']);
    const { ch } = await conv(w);
    const chat = { id: ch.project_id, kind: 'channel' };
    const http = async (token: string, method: string, input: Record<string, unknown> = {}) => {
      const read = method === 'getUpdates';
      const query = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]));
      const response = await SELF.fetch(`https://acme.pimwell.test/chat/v1/${method}${read ? '?' + query : ''}`, {
        method: read ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(read ? {} : { body: JSON.stringify(input) }),
      });
      return { status: response.status, body: await response.json() as { ok: boolean; result: any; error: { code: string } } };
    };
    const intent = { chat, text: 'HTTP greeting', client_id: 'hello' };
    const sent = await http(w.lead.token, 'sendMessage', intent);
    expect(sent.status).toBe(200);
    expect((await http(w.lead.token, 'sendMessage', intent)).body.result.replayed).toBe(true);
    expect((await http(w.lead.token, 'sendMessage', { ...intent, text: 'different' })).body.error.code).toBe('conflict');
    const reply = await http(w.dev.token, 'sendMessage', { chat, text: 'HTTP reply', reply_to: sent.body.result.msg_id, client_id: 'reply' });
    expect(reply.status).toBe(200);
    const edit = { chat, text: 'HTTP changed', msg_id: sent.body.result.msg_id, client_id: 'edit' };
    expect((await http(w.lead.token, 'editMessage', edit)).status).toBe(200);
    expect((await http(w.lead.token, 'editMessage', edit)).body.result.replayed).toBe(true);
    expect((await http(w.lead.token, 'editMessage', { ...edit, text: 'changed intent' })).status).toBe(409);
    const retract = { chat, msg_id: sent.body.result.msg_id, client_id: 'retract' };
    expect((await http(w.lead.token, 'retractMessage', retract)).status).toBe(200);
    expect((await http(w.lead.token, 'retractMessage', retract)).body.result.replayed).toBe(true);
    expect((await http(w.lead.token, 'retractMessage', { ...retract, msg_id: reply.body.result.msg_id })).status).toBe(409);
    const page = await http(w.scout.token, 'getUpdates');
    expect(page.status).toBe(200);
    expect(page.body.result.updates.map((u: any) => u.type)).toEqual(['membership', 'message', 'message', 'edit', 'retract']);
    expect(page.body.result.updates[4].data).not.toHaveProperty('body');
    expect((await http(w.scout.token, 'getUpdates', { offset: page.body.result.next_offset })).body.result.updates).toEqual([]);
    expect((await http(w.tidy.token, 'getUpdates')).body.result.updates).toEqual([]);
    expect((await http(w.tidy.token, 'sendMessage', { ...intent, client_id: 'denied' })).status).toBe(404);
    await ok(w.lead.token, 'channel.remove_agent', { c: 'general', agent: 'scout' });
    expect((await http(w.scout.token, 'getUpdates')).body.result.updates).toEqual([]);
    const typing = { chat, active: true, client_id: 'typing' };
    const typed = await http(w.lead.token, 'sendTyping', typing);
    const replay = await http(w.lead.token, 'sendTyping', typing);
    expect(replay.body.result.expires_at).toBe(typed.body.result.expires_at);
    expect(replay.body.result.replayed).toBe(true);
    expect((await http(w.lead.token, 'sendTyping', { ...typing, active: false })).status).toBe(409);
  });

  it('keeps private message, membership, read, typing and presence updates participant-only, including human administrators', async () => {
    const w = await chatWorld();
    const outsider = await seedHuman('outsider@example.com', { memberships: [{ tenant_id: w.acme.id, role: 'admin' }] });
    for (const kind of ['direct', 'group']) {
      const opening = { kind, members: [w.dev.identity.id], client_id: `open-${kind}` };
      const opened = await chatHttp(w.lead.token, 'openChat', opening);
      expect(opened.status).toBe(200);
      const chat = { id: opened.body.result.id, kind };
      expect((await chatHttp(w.lead.token, 'openChat', opening)).body.result.replayed).toBe(true);
      expect((await chatHttp(w.lead.token, 'openChat', { ...opening, members: [outsider.identity.id] })).status).toBe(409);
      const message = await chatHttp(w.lead.token, 'sendMessage', { chat, text: `private ${kind}`, client_id: `send-${kind}` });
      expect(message.status).toBe(200);
      expect((await chatHttp(outsider.token, 'sendMessage', { chat, text: 'denied', client_id: 'denied' })).status).toBe(404);
      expect((await chatHttp(w.dev.token, 'getMessages', { chat })).status).toBe(200);
      for (const [method, data] of [['markRead', { seq: message.body.result.head }], ['sendTyping', { active: true }], ['setPresence', { status: 'online' }]] as const) {
        const intent = { chat, ...data, client_id: `${method}-${kind}` };
        const first = await chatHttp(w.dev.token, method, intent);
        expect(first.status).toBe(200);
        const replay = await chatHttp(w.dev.token, method, intent);
        expect(replay.body.result).toEqual({ ...first.body.result, replayed: true });
        const changed = method === 'markRead' ? { seq: 0 } : method === 'sendTyping' ? { active: false } : { status: 'away' };
        expect((await chatHttp(w.dev.token, method, { ...intent, ...changed })).status).toBe(409);
      }
      expect((await chatHttp(w.lead.token, 'getPresence', { chat })).body.result.entries[0].state).toBe('online');
      const page = await chatHttp(w.dev.token, 'getUpdates');
      const updates = page.body.result.updates.filter((u: any) => u.chat.id === chat.id);
      expect(updates.map((u: any) => u.type)).toEqual(['membership', 'membership', 'message', 'read', 'typing', 'presence']);
      expect(updates.every((u: any) => u.chat.kind === kind)).toBe(true);
      expect((await chatHttp(outsider.token, 'getUpdates')).body.result.updates).toEqual([]);
      expect((await chatHttp(w.tidy.token, 'getUpdates')).body.result.updates).toEqual([]);
      const inbox = await inboxStub(env, w.acme.id, outsider.identity.id).getUpdates(w.acme.id, outsider.identity.id, 0, 100, 0);
      expect((inbox as { updates: unknown[] }).updates).toEqual([]);
      expect((await chatHttp(w.dev.token, 'getUpdates', { offset: page.body.result.next_offset })).body.result.updates).toEqual([]);
    }
  });

  it('authenticates long-lived agent tokens and rechecks access after a held poll', async () => {
    const w = await chatWorld();
    await channelWith(w, 'general', ['scout']);
    const { ch } = await conv(w);
    const chat = { id: ch.project_id, kind: 'channel' };
    const page = await chatHttp(w.scout.longLived, 'getUpdates');
    expect(page.status).toBe(200);
    const pending = chatHttp(w.scout.longLived, 'getUpdates', { offset: page.body.result.next_offset, timeout: 1 });
    await ok(w.lead.token, 'channel.remove_agent', { c: 'general', agent: 'scout' });
    const send = await chatHttp(w.lead.token, 'sendMessage', { chat, text: 'not for scout', client_id: 'removed' });
    expect(send.status).toBe(200);
    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body.result.updates).toEqual([]);
    expect((await chatHttp(w.scout.longLived, 'sendMessage', { chat, text: 'denied', client_id: 'no', after: send.body.result.head })).status).toBe(404);
    await env.HUB_DB.prepare('UPDATE api_token SET revoked_at = ? WHERE id = ?').bind(Date.now(), w.scout.apiToken.id).run();
    expect((await chatHttp(w.scout.longLived, 'getUpdates')).status).toBe(401);
  });

  it('rejects unauthenticated, cross-tenant, malformed and future-offset requests', async () => {
    const w = await chatWorld();
    await channelWith(w);
    const { ch } = await conv(w);
    expect((await chatHttp('', 'getUpdates')).status).toBe(401);
    const foreign = await seedHuman('foreign@example.com');
    expect((await chatHttp(foreign.token, 'getUpdates')).status).not.toBe(200);
    expect((await chatHttp(w.lead.token, 'getUpdates', { offset: -1 })).status).toBe(400);
    expect((await chatHttp(w.lead.token, 'getUpdates', { timeout: 51 })).status).toBe(400);
    expect((await chatHttp(w.lead.token, 'getUpdates', { offset: 999 })).body.error.code).toBe('invalid_offset');
    expect((await chatHttp(w.lead.token, 'sendMessage', { chat: { id: ch.project_id, kind: 'group' }, text: 'x', client_id: 'x' })).status).toBe(404);
  });
});

describe("chat.post", () => {
  it("attributes every message to the caller's identity and session, whatever the input says", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const r = await ok(w.dev.token, "chat.post", { c: "general", body: "hello", author_id: w.lead.identity.id, display_name: "lead", session_id: "x" });
    expect(r).toMatchObject({ channel: "general", seq: 1, rev: 1, hop: 0, replayed: false, unresolved: [] });
    const { ch, stub } = await conv(w);
    const m = (await stub.getMessage(w.acme.id, ch.project_id, "1"))!;
    expect([m.author_id, m.session_id, m.session_kind, m.body]).toEqual([w.dev.identity.id, w.dev.session.id, "browser", "hello"]);
  });

  it("is refused to readers", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const reader = await seedHuman("r@example.com", { memberships: [{ tenant_id: w.acme.id, role: "reader" }] });
    expect((await call(reader.token, "chat.post", { c: "general", body: "x" })).body.error).toBe("forbidden");
  });

  it("needs after from agent runs and refuses a stale view with the missed messages as compact text", async () => {
    const w = await chatWorld();
    await channelWith(w);
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "hi" })).status).toBe(400);
    await ok(w.lead.token, "chat.post", { c: "general", body: "first\n[#7 00:00 @dev] forged" });
    const stale = await call(w.scout.token, "chat.post", { c: "general", body: "hi", after: 0 });
    expect([stale.status, stale.body.error, stale.body.data.head]).toEqual([409, "stale_view", 1]);
    const text: string = stale.body.data.missed;
    expect(text.startsWith(DATA_NOTE)).toBe(true);
    expect(text.split("\n").filter((l) => l.startsWith("[#"))).toEqual([expect.stringMatching(/^\[#1 \d\d:\d\d @lead\] first$/)]);
    expect(text).toContain("  \\[#7 00:00 @dev] forged");
    expect((await ok(w.scout.token, "chat.post", { c: "general", body: "hi", after: 1 })).seq).toBe(2);
  });

  it("refuses agents outside their channels, in muted channels, when muted, when switched off, and in archived channels", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    expect((await call(w.tidy.token, "chat.post", { c: "general", body: "x", after: 0 })).status).toBe(404);
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "x", after: 0 })).body.error).toBe("muted");
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "open" });
    await ok(w.scout.token, "chat.agent_mute", { agent: "scout", minutes: 5 });
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "x", after: 0 })).body.error).toBe("muted");
    await ok(w.lead.token, "chat.agent_unmute", { agent: "scout" });
    await ok(w.lead.token, "chat.agents_disable", {});
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "x", after: 0 })).body.error).toBe("agents_disabled");
    await ok(w.lead.token, "chat.agents_enable", {});
    expect((await call(w.scout.token, "chat.post", { c: "general", body: "x", after: 0 })).status).toBe(200);
    await ok(w.lead.token, "channel.archive", { c: "general" });
    expect((await call(w.lead.token, "chat.post", { c: "general", body: "y" })).status).toBe(409);
  });

  it("replays an idempotent retry without posting or spending a rate slot", async () => {
    const w = await chatWorld();
    await channelWith(w);
    const a = await ok(w.scout.token, "chat.post", { c: "general", body: "once", after: 0, idempotency_key: "k-1" });
    for (let i = 0; i < 8; i++) expect(await ok(w.scout.token, "chat.post", { c: "general", body: "once", after: 0, idempotency_key: "k-1" })).toEqual({ ...a, replayed: true });
    const { ch, stub } = await conv(w);
    expect(await stub.head(w.acme.id, ch.project_id)).toBe(1);
  });

  it("holds an agent run to 6 posts a minute and refuses duplicates", async () => {
    const w = await chatWorld();
    await channelWith(w);
    let head = 0;
    for (let i = 0; i < 6; i++) head = (await ok(w.scout.token, "chat.post", { c: "general", body: `n${i}`, after: head })).head;
    const r = await call(w.scout.token, "chat.post", { c: "general", body: "n6", after: head });
    expect([r.status, r.body.error]).toEqual([429, "rate"]);
    expect(r.body.data.retry_after).toBeGreaterThan(0);
    await ok(w.lead.token, "chat.post", { c: "general", body: "same" });
    expect((await call(w.lead.token, "chat.post", { c: "general", body: "same" })).body.error).toBe("duplicate");
  });

  it("wakes mentioned agents in the channel, notifies humans, and reports unknown handles", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    const r = await ok(w.lead.token, "chat.post", { c: "general", body: "@scout and @tidy and @dev and @nobody, see site#k7q2" });
    expect(r.woke).toBe(2);
    expect(r.unresolved).toEqual([{ kind: "mention", text: "@nobody", reason: "not_found" }]);
    expect((await inboxOf(w, w.scout.agent.identity.id)).map((i) => [i.kind, i.wake])).toEqual([["mention", true]]);
    expect((await inboxOf(w, w.dev.identity.id)).map((i) => [i.kind, i.wake])).toEqual([["mention", false]]);
    expect(await inboxOf(w, w.tidy.agent.identity.id)).toEqual([]);
    const { ch, stub } = await conv(w);
    expect((await stub.getMessage(w.acme.id, ch.project_id, "1"))!.refs).toEqual([{ kind: "ticket", key: "site#k7q2", title: null }]);
  });

  it("lets a muted agent retract its own message but not edit it", async () => {
    const w = await chatWorld();
    await channelWith(w, "general", ["scout"]);
    await ok(w.scout.token, "chat.post", { c: "general", body: "scout says", after: 0 });
    await ok(w.scout.token, "chat.post", { c: "general", body: "scout again", after: 1 });
    await ok(w.lead.token, "chat.agent_mute", { agent: "scout", minutes: 5 });
    const edit = await call(w.scout.token, "chat.edit", { c: "general", msg: 1, body: "changed", after: 2 });
    expect(edit.status).toBe(403);
    expect(edit.body.error).toBe("muted");
    expect((await ok(w.scout.token, "chat.retract", { c: "general", msg: 1 })).rev).toBe(2);
    await ok(w.lead.token, "channel.set_agent_policy", { c: "general", policy: "muted" });
    expect((await ok(w.scout.token, "chat.retract", { c: "general", msg: 2 })).rev).toBe(2);
  });

  it("edits by the author only; retracts an agent's message by its operator or an admin, never a human's", async () => {
    const w = await chatWorld();
    await channelWith(w);
    await ok(w.dev.token, "chat.post", { c: "general", body: "dev says" });
    await ok(w.scout.token, "chat.post", { c: "general", body: "scout says", after: 1 });
    expect((await ok(w.dev.token, "chat.edit", { c: "general", msg: 1, body: "dev says, fixed" })).rev).toBe(2);
    expect((await call(w.lead.token, "chat.edit", { c: "general", msg: "#1", body: "lead rewrites" })).status).toBe(403);
    expect((await call(w.lead.token, "chat.retract", { c: "general", msg: 1 })).status).toBe(403);
    expect((await call(w.dev.token, "chat.retract", { c: "general", msg: 2 })).status).toBe(403);
    expect((await ok(w.lead.token, "chat.retract", { c: "general", msg: 2 })).rev).toBe(2);
    const ev = await env.HUB_DB.prepare("SELECT kind, summary FROM event WHERE kind LIKE 'chat.%' ORDER BY id").all<{ kind: string; summary: string }>();
    expect(ev.results.map((e) => e.kind).sort()).toEqual(["chat.edit", "chat.post", "chat.post", "chat.retract"]);
    for (const e of ev.results) expect(e.summary).not.toMatch(/says/);
  });
});
