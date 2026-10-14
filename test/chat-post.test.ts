import { env, SELF } from "cloudflare:test";
import { inDO } from "./do-helper";
import { Inbox } from "../src/chat/inboxDO";
import { describe, expect, it } from "vitest";
import { conversationStub, inboxStub } from "../src/chat/stubs";
import { getChannelBySlug } from "../src/db/chat";
import { DATA_NOTE } from "../src/mcp/render";
import { seedHuman } from "./helpers";
import { connectWithTokens } from "./oauth-helpers";
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

describe("chat WebSocket stream", () => {
  it('caps sockets and applies disconnect grace only after the last socket', async () => {
    const w = await chatWorld();
    await channelWith(w, 'general', ['scout']);
    const { ch, stub } = await conv(w);
    const box = inboxStub(env, w.acme.id, w.lead.identity.id);
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await SELF.fetch('https://acme.pimwell.test/chat/v1/ws', { headers: { authorization: `Bearer ${w.lead.token}`, upgrade: 'websocket' } });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      const next = frames(ws); ws.accept();
      await next(f => f.result?.updates);
      ws.send(JSON.stringify({ type: 'ping' }));
      await next(f => f.type === 'pong');
      sockets.push(ws);
    }
    const excess = await SELF.fetch('https://acme.pimwell.test/chat/v1/ws', { headers: { authorization: `Bearer ${w.lead.token}`, upgrade: 'websocket' } });
    expect(excess.status).toBe(429);
    const expireGrace = async () => {
      await expect.poll(() => inDO(box, (_obj, state) => state.storage.sql.exec("SELECT 1 FROM meta WHERE key = 'socket_disconnect'").toArray().length), { timeout: 5000 }).toBe(1);
      await inDO(box, async (obj: Inbox, state) => {
        const pending = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'socket_disconnect'").toArray()[0]!;
        const value = JSON.parse(pending.value); value.due = Date.now() - 1;
        state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'socket_disconnect'", JSON.stringify(value));
        await obj.alarm();
      });
    };
    sockets.pop()!.close(1000);
    await new Promise(resolve => setTimeout(resolve, 30));
    await expireGrace();
    expect((await stub.presence(w.acme.id, ch.project_id)).find(p => p.identity_id === w.lead.identity.id)?.status).toBe('online');
    for (const ws of sockets) ws.close(1000);
    await new Promise(resolve => setTimeout(resolve, 30));
    // Before grace expiry, disconnect does not publish offline.
    expect((await stub.presence(w.acme.id, ch.project_id)).find(p => p.identity_id === w.lead.identity.id)?.status).toBe('online');
    await expireGrace();
    expect((await stub.presence(w.acme.id, ch.project_id)).find(p => p.identity_id === w.lead.identity.id)?.status).toBe('offline');
  });

  it('coalesces update bursts without losing events and rechecks chat access on the next page', async () => {
    const w = await chatWorld();
    await channelWith(w, 'general', ['scout']);
    await channelWith(w, 'other', ['scout']);
    await channelWith(w, 'hidden', []);
    const { ch } = await conv(w);
    const { ch: other } = await conv(w, 'other');
    const { ch: hidden } = await conv(w, 'hidden');
    const response = await SELF.fetch('https://acme.pimwell.test/chat/v1/ws', { headers: { authorization: `Bearer ${w.scout.longLived}`, upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const next = frames(ws); ws.accept();
    await next(f => f.type === 'connected');
    await next(f => f.result?.updates);
    const box = inboxStub(env, w.acme.id, w.scout.agent.identity.id);
    const commandAt = Date.now();
    ws.send(JSON.stringify({ request_id: 'during-burst', method: 'getMessages', params: { chat: { id: ch.project_id, kind: 'channel' } } }));
    const update = (id: string, body: string) => ({ key: crypto.randomUUID(), type: 'message', chat: { id, kind: 'channel' as const }, data: { body }, created_at: Date.now() });
    await box.deliverUpdates(w.acme.id, w.scout.agent.identity.id, [
      ...Array.from({ length: 20 }, (_, i) => update(ch.project_id, `burst-${i}`)),
      update(hidden.project_id, 'hidden-burst'),
    ]);
    const burst = await next(f => f.result?.updates.some((u: any) => u.data.body === 'burst-19'));
    expect(burst.result.updates.filter((u: any) => u.data.body?.startsWith('burst-')).map((u: any) => u.data.body)).toEqual(Array.from({ length: 20 }, (_, i) => `burst-${i}`));
    expect(burst.result.updates.some((u: any) => u.data.body === 'hidden-burst')).toBe(false);
    expect((await next(f => f.request_id === 'during-burst')).ok).toBe(true);
    await env.HUB_DB.prepare('UPDATE conversation_member SET removed_at = ? WHERE tenant_id = ? AND conversation_id = ? AND identity_id = ?')
      .bind(Date.now(), w.acme.id, ch.project_id, w.scout.agent.identity.id).run();
    await box.deliverUpdates(w.acme.id, w.scout.agent.identity.id, [update(ch.project_id, 'revoked-burst'), update(other.project_id, 'still-readable')]);
    const later = await next(f => f.result?.updates.some((u: any) => u.data.body === 'still-readable'));
    expect(later.result.updates.some((u: any) => u.data.body === 'revoked-burst')).toBe(false);
    const attachment = await inDO(box, (_o, state) => state.getWebSockets()[0]!.deserializeAttachment() as { offset: number; last_seen: number });
    expect(attachment.offset).toBeGreaterThanOrEqual(later.result.next_offset);
    expect(attachment.last_seen).toBeGreaterThanOrEqual(commandAt);
    ws.close(1000);
  });

  function frames(ws: WebSocket) {
    const buffered: any[] = [];
    let wake: (() => void) | undefined;
    ws.addEventListener('message', event => { buffered.push(JSON.parse(String(event.data))); wake?.(); });
    return async (matches: (frame: any) => boolean): Promise<any> => {
      for (;;) {
        const index = buffered.findIndex(matches);
        if (index >= 0) return buffered.splice(index, 1)[0];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('socket frame timeout')), 5000);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      }
    };
  }

  it('exchanges member/agent commands, resumes missed updates once and checks cookie Origin', async () => {
    const w = await chatWorld();
    await channelWith(w, 'general', ['scout']);
    const { ch } = await conv(w);
    const chat = { id: ch.project_id, kind: 'channel' };
    const connect = async (token: string, offset = 0) => {
      const response = await SELF.fetch(`https://acme.pimwell.test/chat/v1/ws?offset=${offset}`, { headers: { authorization: `Bearer ${token}`, upgrade: 'websocket' } });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      const next = frames(ws);
      ws.accept();
      const connected = await next(f => f.type === 'connected');
      expect(connected.server_request_id).toBe(response.headers.get('x-request-id'));
      await next(f => f.result?.updates);
      return { ws, next };
    };
    const member = await connect(w.lead.token);
    const agent = await connect(w.scout.longLived);
    member.ws.send(JSON.stringify({ request_id: 'member', method: 'sendMessage', params: { chat, text: 'live hello', client_id: 'ws-member' } }));
    const acknowledged = await member.next(f => f.request_id === 'member');
    expect(acknowledged.ok).toBe(true);
    expect(acknowledged.server_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(acknowledged.server_request_id).not.toBe(acknowledged.request_id);
    const hello = await agent.next(f => f.result?.updates.some((u: any) => u.type === 'message'));
    const message = hello.result.updates.find((u: any) => u.type === 'message');
    agent.ws.send(JSON.stringify({ request_id: 'agent', method: 'sendMessage', params: { chat, text: 'live reply', client_id: 'ws-agent', after: message.data.seq } }));
    expect((await agent.next(f => f.request_id === 'agent')).ok).toBe(true);
    const reply = await member.next(f => f.result?.updates.some((u: any) => u.type === 'message' && u.data.body === 'live reply'));
    const offset = reply.result.next_offset;
    member.ws.close(1000);
    const missed = await chatHttp(w.dev.token, 'sendMessage', { chat, text: 'while dropped', client_id: 'ws-missed' });
    expect(missed.status).toBe(200);
    const response = await SELF.fetch(`https://acme.pimwell.test/chat/v1/ws?offset=${offset}`, { headers: { authorization: `Bearer ${w.lead.token}`, upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const resumed = response.webSocket!;
    const next = frames(resumed); resumed.accept();
    const replay = await next(f => f.result?.updates.some((u: any) => u.type === 'message'));
    expect(replay.result.updates.filter((u: any) => u.type === 'message').map((u: any) => u.data.body)).toEqual(['while dropped']);
    expect((await chatHttp(w.lead.token, 'getUpdates', { offset: replay.result.next_offset })).body.result.updates.filter((u: any) => u.type === 'message')).toEqual([]);
    resumed.send(JSON.stringify({ type: 'ping' }));
    expect(await next(f => f.type === 'pong')).toEqual({ type: 'pong' });
    const leadBox = inboxStub(env, w.acme.id, w.lead.identity.id);
    await inDO(leadBox, async (_obj, state) => {
      const fresh = new Inbox(state, env);
      const socket = state.getWebSockets().find(ws => ws.readyState === WebSocket.OPEN)!;
      await fresh.webSocketMessage(socket, JSON.stringify({ type: 'ping' }));
    });
    expect(await next(f => f.type === 'pong')).toEqual({ type: 'pong' });
    const badOrigin = await SELF.fetch('https://acme.pimwell.test/chat/v1/ws', { headers: { cookie: `pmw_session=${w.lead.token}`, origin: 'https://evil.test', upgrade: 'websocket' } });
    expect(badOrigin.status).toBe(403);
    const cookie = await SELF.fetch('https://acme.pimwell.test/chat/v1/ws', { headers: { cookie: `pmw_session=${w.lead.token}`, origin: 'https://acme.pimwell.test', upgrade: 'websocket' } });
    expect(cookie.status).toBe(101); cookie.webSocket!.accept(); cookie.webSocket!.close(1000);
    const future = await SELF.fetch('https://acme.pimwell.test/chat/v1/ws?offset=999999', { headers: { authorization: `Bearer ${w.lead.token}`, upgrade: 'websocket' } });
    expect(future.status).toBe(409);
    expect((await future.json() as any).error.code).toBe('invalid_offset');
    const noDuplicates = await SELF.fetch(`https://acme.pimwell.test/chat/v1/ws?offset=${replay.result.next_offset}`, { headers: { authorization: `Bearer ${w.lead.token}`, upgrade: 'websocket' } });
    const duplicateSocket = noDuplicates.webSocket!;
    const duplicateNext = frames(duplicateSocket); duplicateSocket.accept();
    expect((await duplicateNext(f => f.result?.updates)).result.updates.filter((u: any) => u.type === 'message')).toEqual([]);
    duplicateSocket.close(1000);
    await env.HUB_DB.prepare('UPDATE api_token SET revoked_at = ? WHERE id = ?').bind(Date.now(), w.scout.apiToken.id).run();
    const closed = new Promise<number>(resolve => agent.ws.addEventListener('close', event => resolve(event.code)));
    agent.ws.send(JSON.stringify({ request_id: 'revoked-command', method: 'sendMessage', params: { chat, text: 'must not commit after revocation', client_id: 'ws-revoked', after: message.data.seq } }));
    expect(await closed).toBe(1008);
    const history = await chatHttp(w.lead.token, 'getMessages', { chat });
    expect(history.body.result.messages.some((m: any) => m.body === 'must not commit after revocation')).toBe(false);
    resumed.close(1000);
  });
});

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
    const sendIntent = { chat, text: 'agent HTTP message', client_id: 'agent-send', after: 0 };
    const posted = await chatHttp(w.scout.longLived, 'sendMessage', sendIntent);
    expect(posted.status).toBe(200);
    const editIntent = { chat, text: 'agent HTTP edit', msg_id: posted.body.result.msg_id, client_id: 'agent-edit', after: posted.body.result.head };
    const edited = await chatHttp(w.scout.longLived, 'editMessage', editIntent);
    expect(edited.status).toBe(200);
    expect((await chatHttp(w.scout.longLived, 'editMessage', editIntent)).body.result.replayed).toBe(true);
    expect((await chatHttp(w.tidy.longLived, 'editMessage', editIntent)).status).toBe(404);
    const retractIntent = { chat, msg_id: posted.body.result.msg_id, client_id: 'agent-retract' };
    expect((await chatHttp(w.scout.longLived, 'retractMessage', retractIntent)).status).toBe(200);
    expect((await chatHttp(w.scout.longLived, 'retractMessage', retractIntent)).body.result.replayed).toBe(true);
    const caughtUp = await chatHttp(w.scout.longLived, 'getUpdates', { offset: page.body.result.next_offset });
    const pending = chatHttp(w.scout.longLived, 'getUpdates', { offset: caughtUp.body.result.next_offset, timeout: 1 });
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

  it('enforces OAuth write scope and message ownership for HTTP edit/retract without exposing new MCP tools', async () => {
    const w = await chatWorld();
    await channelWith(w, 'general', []);
    const { ch } = await conv(w);
    const chat = { id: ch.project_id, kind: 'channel' };
    const read = (await connectWithTokens(w.lead.token)).tokens.access_token;
    const write = (await connectWithTokens(w.lead.token, { scope: 'read write' })).tokens.access_token;
    const sent = await chatHttp(write, 'sendMessage', { chat, text: 'scoped message', client_id: 'oauth-send', after: 0 });
    expect(sent.status).toBe(200);
    const edit = { chat, msg_id: sent.body.result.msg_id, text: 'scoped edit', client_id: 'oauth-edit', after: sent.body.result.head };
    const retract = { chat, msg_id: sent.body.result.msg_id, client_id: 'oauth-retract' };
    for (const [method, intent] of [['editMessage', edit], ['retractMessage', retract]] as const) expect((await chatHttp(read, method, intent)).body.error.code).toBe('insufficient_scope');
    expect((await chatHttp(w.dev.token, 'editMessage', edit)).status).toBe(403);
    expect((await chatHttp(w.dev.token, 'retractMessage', retract)).status).toBe(403);
    expect((await chatHttp(write, 'editMessage', edit)).status).toBe(200);
    expect((await chatHttp(write, 'retractMessage', retract)).status).toBe(200);
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
