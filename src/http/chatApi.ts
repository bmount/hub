import type { Env } from "../env";
import { agentMcpAuth } from "../mcp/agentAuth";
import { mcpAuth } from "../mcp/context";
import { API_TOKEN_PREFIX } from "../db/apiTokens";
import { buildContext } from "../auth/context";
import { checkAccess, checkScope } from "../verbs/dispatch";
import { getVerb } from "../verbs/table";
import { HubError, badRequest, notFound } from "../errors";
import { canRead, viewerOf } from "../chat/access";
import { getChannelById } from "../db/chat";
import { conversationStub, inboxStub } from "../chat/stubs";
import { updateAudience } from "../chat/updates";
import { readRequestBytes, MAX_API_BODY_BYTES } from "./body";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const integer = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max) throw badRequest("invalid integer");
  return n;
};

async function authenticate(request: Request, env: Env, waitUntil: (p: Promise<unknown>) => void) {
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) throw new HubError(401, 'unauthorized');
  let ctx = await buildContext(request, env, Date.now(), waitUntil, { longLivedToken: true });
  if (ctx.host.kind !== 'tenant') throw notFound();
  if (ctx.apiToken || !ctx.identity) {
    const token = request.headers.get('authorization')!.slice(7);
    const auth = await (token.startsWith(API_TOKEN_PREFIX) ? agentMcpAuth : mcpAuth)(request, env, ctx.host.slug, Date.now(), waitUntil);
    if (auth.kind !== 'ok') throw new HubError(auth.response.status, auth.response.status === 429 ? 'rate_limited' : 'unauthorized');
    ctx = auth.ctx;
  }
  viewerOf(ctx);
  return ctx;
}

export async function handleChatApi(request: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  try {
    let ctx = await authenticate(request, env, waitUntil);
    const v = viewerOf(ctx);
    const method = new URL(request.url).pathname.slice('/chat/v1/'.length);
    const mapping: Record<string, string> = { sendMessage: 'chat.post', editMessage: 'chat.edit', retractMessage: 'chat.retract', markRead: 'chat.mark_read', sendTyping: 'chat.mark_read', getUpdates: 'chat.inbox', getMessages: 'chat.read', getChats: 'chat.conversations', openChat: 'chat.open', setPresence: 'chat.heartbeat', getPresence: 'chat.presence' };
    const verb = getVerb(mapping[method] ?? '');
    if (!verb || ctx.host.kind !== 'tenant') throw notFound();
    checkScope(ctx, verb); checkAccess(ctx, verb);
    const reading = ['getUpdates', 'getMessages', 'getChats', 'getPresence'].includes(method);
    if (request.method !== (reading ? 'GET' : 'POST')) throw new HubError(405, 'bad_request', 'wrong HTTP method');
    let input: Record<string, unknown>;
    if (reading) input = Object.fromEntries(new URL(request.url).searchParams);
    else {
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw badRequest('application/json required');
      const parsed = JSON.parse(new TextDecoder().decode(await readRequestBytes(request, MAX_API_BODY_BYTES)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('JSON object required');
      input = parsed;
    }
    if (method === 'getUpdates') {
      const page = await inboxStub(env, v.tenant.id, v.identity.id).getUpdates(v.tenant.id, v.identity.id, integer(input.offset, 0), integer(input.limit, 100, 100) || 1, integer(input.timeout, 0, 50)) as { updates: import('../chat/updates').ChatUpdate[]; next_offset: number; has_more: boolean; error?: string; min_offset?: number };
      if (page.error) throw new HubError(page.error === 'rate_limited' ? 429 : 409, page.error, page.error === 'rate_limited' ? 'too many long-polls' : 'resynchronize chat snapshots', { min_offset: page.min_offset });
      ctx = await authenticate(request, env, waitUntil);
      checkScope(ctx, verb); checkAccess(ctx, verb);
      const current = viewerOf(ctx);
      const updates = [];
      for (const update of page.updates) {
        const channel = await getChannelById(ctx.db, v.tenant.id, update.chat.id);
        if (channel && await canRead(ctx.db, current, channel)) {
          if (update.type === 'typing' && Number(update.data.expires_at) <= Date.now()) update.data.active = false;
          if (update.type === 'presence' && Number(update.data.expires_at) <= Date.now() && update.data.status !== 'offline') update.data.stale = true;
          updates.push(update);
        }
      }
      return json({ ok: true, result: { updates, next_offset: page.next_offset, has_more: page.has_more } });
    }
    if (method === 'getChats') return json({ ok: true, result: await verb.run(ctx, verb.parse({})) });
    if (method === 'openChat') return json({ ok: true, result: await verb.run(ctx, verb.parse(input)) });
    let chat = input.chat;
    if (typeof chat === 'string') { try { chat = JSON.parse(chat); } catch { throw badRequest('chat must be an object'); } }
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) throw badRequest('chat must be an object');
    const wire = chat as Record<string, unknown>;
    if (typeof wire.id !== 'string' || !['channel', 'thread', 'direct', 'group'].includes(String(wire.kind))) throw badRequest('invalid chat');
    if (wire.kind === 'thread' && typeof wire.root !== 'string') throw badRequest('thread root required');
    const ch = await getChannelById(ctx.db, v.tenant.id, wire.id);
    if (!ch || !await canRead(ctx.db, v, ch)) throw notFound();
    if (wire.kind !== 'thread' && wire.kind !== (ch.kind ?? 'channel')) throw notFound();
    if (method === 'getPresence') return json({ ok: true, result: await verb.run(ctx, verb.parse({ c: ch.slug })) });
    if (method === 'getMessages') {
      const target = getVerb(wire.kind === 'thread' ? 'chat.thread' : 'chat.read')!;
      checkScope(ctx, target); checkAccess(ctx, target);
      const result = await target.run(ctx, target.parse({ c: ch.slug, ...(wire.root ? { msg: wire.root } : {}), after: input.after === undefined ? undefined : integer(input.after, 0), before: input.before === undefined ? undefined : integer(input.before, 0), limit: integer(input.limit, 50, 100) }));
      return json({ ok: true, result });
    }
    if (typeof input.client_id !== 'string' || input.client_id.length < 1 || input.client_id.length > 64) throw badRequest('client_id must be 1–64 characters');
    if (method === 'sendTyping' || method === 'markRead' || method === 'setPresence') {
      const conv = conversationStub(env, v.tenant.id, ch.project_id);
      let data: Record<string, unknown>;
      if (method === 'setPresence') {
        if (!['online', 'away', 'offline'].includes(String(input.status))) throw badRequest('invalid status');
        data = { status: input.status, via_assistant: !!(ctx.oauth || ctx.playground) };
      } else if (method === 'sendTyping') {
        if (typeof input.active !== 'boolean') throw badRequest('active must be boolean');
        data = { active: input.active };
      } else {
        const seq = integer(input.seq, 0);
        const head = await conv.head(v.tenant.id, ch.project_id);
        if (seq > head) throw new HubError(409, 'conflict', 'seq exceeds head');
        data = { seq };
      }
      const result = await conv.signal(v.tenant.id, ch.project_id, v.identity.id, method === 'sendTyping' ? 'typing' : method === 'setPresence' ? 'presence' : 'read', input.client_id, data, await updateAudience(ctx.db, v.tenant.id, ch.project_id, ch)) as Record<string, unknown>;
      if (result.conflict) throw new HubError(409, 'conflict', 'client_id intent changed');
      return json({ ok: true, result });
    }
    const params = verb.parse({ c: ch.slug, body: input.text, msg: input.msg_id, reply_to: input.reply_to ?? wire.root, idempotency_key: input.client_id, after: input.after });
    return json({ ok: true, result: await verb.run(ctx, params) });
  } catch (e) {
    if (e instanceof HubError) return json({ ok: false, error: { code: e.reason === 'rate' ? 'rate_limited' : e.reason, message: e.detail ?? e.reason, ...e.data, ...(e.data?.retry_after !== undefined ? { retry_after_s: e.data.retry_after } : {}) } }, e.status);
    if (e instanceof SyntaxError) return json({ ok: false, error: { code: 'bad_request', message: 'invalid JSON' } }, 400);
    console.error('chat HTTP failed', e instanceof Error ? e.name : 'error');
    return json({ ok: false, error: { code: 'internal', message: 'temporary failure' } }, 500);
  }
}
