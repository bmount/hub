import { timedStorage, timedEnv, instrumentDurableObject, traceColo, traceFields, requestId } from "../perf";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { bindOnce, storedBinding } from "./bound";
import { LIMITS, postVerdict } from "./rules";
import type { InboxItem, InboxPage, WakeItem } from "./types";
import type { ChatUpdate, UpdateDelivery } from "./updates";
import { authenticateChat, handleChatApi } from "../http/chatApi";
import { canRead, readableChannels, viewerOf } from "./access";
import { getChannelById } from "../db/chat";
import { checkAccess, checkScope } from "../verbs/dispatch";
import { getVerb } from "../verbs/table";
import { conversationStub } from "./stubs";

type SocketState = { tenant: string; identity: string; url: string; headers: Record<string, string>; offset: number; last_seen: number; perfColo?: string };
const SOCKET_GRACE_MS = 30_000;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS item (item_seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
     conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_id TEXT NOT NULL, thread_root TEXT, hop INTEGER NOT NULL,
     author_id TEXT NOT NULL, wake INTEGER NOT NULL, created_at INTEGER NOT NULL, acked_at INTEGER)`,
  // The prune in deliver() looks up acked rows by age; partial, so unacked rows cost nothing. DO-local schema: IF NOT EXISTS guards an existing object.
  "CREATE INDEX IF NOT EXISTS item_acked ON item (acked_at) WHERE acked_at IS NOT NULL",
  // Mail replay protection must outlive visible acked items. Keys contain ids only.
  "CREATE TABLE IF NOT EXISTS mail_delivered (key TEXT PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS cursor (conversation_id TEXT PRIMARY KEY, read_seq INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS stamp (scope TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS stamp_scope ON stamp (scope, at)",
  "CREATE TABLE IF NOT EXISTS refusal (at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chat_update (update_id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS chat_update_age ON chat_update (created_at)",
  "CREATE TABLE IF NOT EXISTS update_delivered (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
];

type ItemRow = {
  item_seq: number; key: string; kind: string; conversation_id: string; seq: number; msg_id: string; thread_root: string | null;
  hop: number; author_id: string; wake: number; created_at: number; acked_at: number | null;
};

const clampLimit = (n: number): number => Math.min(LIMITS.INBOX_LIMIT_MAX, Math.max(1, Math.floor(Number.isFinite(n) ? n : 50)));

export type ReserveResult =
  | { ok: true; wake_hop: number | null; thread_wake_hops: Record<string, number> }
  | { ok: false; retry_after_s: number };

/**
 * Messaging spec 9.2: one per (tenant, identity). Wakes and notifications until acked, read cursors, the
 * per-identity and per-session post windows, and the long poll behind `inbox.wait`.
 */
export class Inbox extends DurableObject<Env> {
  #storage: DurableObjectStorage;
  #waiters = new Set<() => void>();
  #updateWaiters = new Set<() => void>();
  #socketJobs = new Map<WebSocket, Promise<void>>();
  #socketPushJobs = new Map<WebSocket, Promise<void>>();
  #scheduledPushes = new Set<WebSocket>();

  #request(state: SocketState, method = 'getUpdates', params: Record<string, unknown> = {}): Request {
    const url = new URL(state.url);
    url.pathname = `/chat/v1/${method}`;
    url.search = '';
    const reading = method.startsWith('get');
    if (reading) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    return new Request(url, { method: reading ? 'GET' : 'POST', headers: { ...state.headers, 'content-type': 'application/json' }, ...(reading ? {} : { body: JSON.stringify(params) }) });
  }

  async #viewer(state: SocketState) {
    // Hibernated Inbox activations do not pass through the HTTP entrypoint.
    if (!getVerb('chat.inbox')) {
      const { registerAllVerbs } = await import("../verbs/index");
      registerAllVerbs();
    }
    const ctx = await authenticateChat(this.#request(state), this.env, p => this.ctx.waitUntil(p));
    const v = viewerOf(ctx);
    if (v.tenant.id !== state.tenant || v.identity.id !== state.identity) throw new Error('socket identity changed');
    const verb = getVerb('chat.inbox')!;
    checkScope(ctx, verb); checkAccess(ctx, verb);
    return { ctx, v };
  }

  async #presence(state: SocketState, status: 'online' | 'offline'): Promise<void> {
    const { ctx, v } = await this.#viewer(state);
    checkScope(ctx, getVerb('chat.heartbeat')!); checkAccess(ctx, getVerb('chat.heartbeat')!);
    for (const ch of await readableChannels(ctx.db, v, 'active')) {
      const connected = this.ctx.getWebSockets().some(ws => ws.readyState === WebSocket.OPEN);
      if ((status === 'offline' && connected) || (status === 'online' && !connected)) return;
      await conversationStub(this.env, state.tenant, ch.project_id).heartbeat(state.tenant, ch.project_id, state.identity, status, !!(ctx.oauth || ctx.playground));
    }
  }

  #queue(ws: WebSocket, job: () => Promise<void>, jobs = this.#socketJobs): Promise<void> {
    const next = (jobs.get(ws) ?? Promise.resolve()).then(job).catch(async () => {
      // Do not log retained authentication material or message contents.
      try { ws.close(1008, 'authentication or socket failure'); } catch { /* already closed */ }
      await this.webSocketClose(ws, 1008);
    });
    jobs.set(ws, next);
    void next.then(() => { if (jobs.get(ws) === next) jobs.delete(ws); });
    return next;
  }

  /** One pending push per socket; it reads the latest durable head when it runs.
   * Clear before reading so an update arriving during the push schedules a successor. */
  #schedulePush(ws: WebSocket, initial = false): void {
    if (this.#scheduledPushes.has(ws)) return;
    this.#scheduledPushes.add(ws);
    this.ctx.waitUntil(this.#queue(ws, async () => {
      this.#scheduledPushes.delete(ws);
      await this.#push(ws, initial);
    }, this.#socketPushJobs));
  }

  async #push(ws: WebSocket, initial = false): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    const state = ws.deserializeAttachment() as SocketState;
    for (;;) {
      const { ctx, v } = await this.#viewer(state);
      const page = await this.getUpdates(state.tenant, state.identity, state.offset, 100, 0);
      if (page.error) {
        ws.send(JSON.stringify({ ok: false, error: { code: page.error, min_offset: page.min_offset } }));
        ws.close(1008, page.error); return;
      }
      // Reauthorize each chat for this page, not once per event in a presence burst.
      // This cache is local to the freshly authenticated page, never to the socket.
      const readable = new Set<string>();
      await Promise.all([...new Set(page.updates.map(update => update.chat.id))].map(async id => {
        const ch = await getChannelById(ctx.db, state.tenant, id);
        if (ch && await canRead(ctx.db, v, ch)) readable.add(id);
      }));
      const updates: ChatUpdate[] = [];
      for (const update of page.updates) {
        if (!readable.has(update.chat.id)) continue;
        if (update.type === 'typing' && Number(update.data.expires_at) <= Date.now()) update.data.active = false;
        if (update.type === 'presence' && Number(update.data.expires_at) <= Date.now() && update.data.status !== 'offline') update.data.stale = true;
        updates.push(update);
      }
      if (initial || page.next_offset !== state.offset || updates.length) ws.send(JSON.stringify({ ok: true, result: { updates, next_offset: page.next_offset, has_more: page.has_more } }));
      state.offset = page.next_offset;
      // Commands renew last_seen concurrently; only the push queue owns offset.
      ws.serializeAttachment({ ...ws.deserializeAttachment() as SocketState, offset: state.offset });
      initial = false;
      if (!page.has_more) return;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const tenant = request.headers.get('x-chat-tenant')!;
    const identity = request.headers.get('x-chat-identity')!;
    bindOnce(this.#storage.sql, tenant, identity);
    const headers: Record<string, string> = {};
    for (const name of ['authorization', 'cookie', 'origin']) {
      const value = request.headers.get(name); if (value) headers[name] = value;
    }
    const state: SocketState = { tenant, identity, headers, url: request.url, offset: Number(new URL(request.url).searchParams.get('offset') ?? 0), last_seen: Date.now(), perfColo: traceColo() };
    await this.#viewer(state);
    if (this.ctx.getWebSockets().length >= 8) return Response.json({ ok: false, error: { code: 'rate_limited' } }, { status: 429 });
    const page = await this.getUpdates(tenant, identity, state.offset, 100, 0);
    if (page.error) return Response.json({ ok: false, error: { code: page.error, min_offset: page.min_offset } }, { status: 409 });
    if (this.ctx.getWebSockets().length >= 8) return Response.json({ ok: false, error: { code: 'rate_limited' } }, { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(state);
    // Async work uses hibernatable sockets; no timers or parked long-polls.
    pair[1].send(JSON.stringify({ type: 'connected', server_request_id: requestId() }));
    this.#schedulePush(pair[1], true);
    this.ctx.waitUntil(this.#presence(state, 'online').catch(() => {}));
    await this.#socketAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#queue(ws, async () => {
      const state = ws.deserializeAttachment() as SocketState;
      const { ctx } = await this.#viewer(state);
      // A push may have advanced the cursor during authentication. Preserve it.
      ws.serializeAttachment({ ...ws.deserializeAttachment() as SocketState, last_seen: Date.now() });
      let frame: Record<string, unknown>;
      try {
        if (typeof message !== 'string' || new TextEncoder().encode(message).length > 65536) throw new Error();
        frame = JSON.parse(message);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
      } catch {
        ws.send(JSON.stringify({ ok: false, error: { code: 'bad_request' } })); return;
      }
      if (frame.type === 'ping' || frame.type === 'heartbeat') {
        ws.send(JSON.stringify({ type: 'pong' }));
        // Presence fans out to every readable chat. It must not hold the command
        // queue while recipient/index delivery runs; each write still reauthorizes.
        this.ctx.waitUntil(this.#presence(state, 'online').catch(() => {}));
        this.#schedulePush(ws);
        return;
      }
      const methods = ['sendMessage', 'editMessage', 'retractMessage', 'markRead', 'sendTyping', 'setPresence', 'openChat', 'getUpdates', 'getMessages', 'getChats', 'getPresence'];
      if (typeof frame.request_id !== 'string' || frame.request_id.length > 64 || typeof frame.method !== 'string' || !methods.includes(frame.method) || !frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params)) {
        ws.send(JSON.stringify({ request_id: typeof frame.request_id === 'string' ? frame.request_id.slice(0, 64) : null, ok: false, error: { code: 'bad_request' } })); return;
      }
      const response = await handleChatApi(this.#request(state, frame.method, { ...frame.params as Record<string, unknown>, ...(frame.method === 'getUpdates' ? { timeout: 0 } : {}) }), this.env, p => this.ctx.waitUntil(p), ctx);
      ws.send(JSON.stringify({ ...await response.json() as object, request_id: frame.request_id, server_request_id: requestId() }));
    });
  }

  async #socketAlarm(): Promise<void> {
    if (!this.ctx.getWebSockets().length && !this.#q("SELECT key FROM meta WHERE key = 'socket_disconnect'").length) return;
    const pending = this.#q<{ value: string }>("SELECT value FROM meta WHERE key = 'socket_disconnect'")[0];
    const due = Math.min(Date.now() + SOCKET_GRACE_MS, pending ? Math.max(Date.now() + 1, Number(JSON.parse(pending.value).due)) : Infinity);
    const alarm = await this.#storage.getAlarm();
    if (alarm === null || alarm > due) await this.#storage.setAlarm(due);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code); } catch { /* already closed */ }
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:185:webSocketClose*/ INSERT OR REPLACE INTO meta (key, value) VALUES ('socket_disconnect', ?)", JSON.stringify({ state: ws.deserializeAttachment(), due: Date.now() + SOCKET_GRACE_MS }));
    await this.#socketAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws, 1011); }

  #pruneUpdates(): void {
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:192:%23pruneUpdates*/ DELETE FROM chat_update WHERE created_at < ? OR update_id <= (SELECT COALESCE(MAX(update_id), 0) - 10000 FROM chat_update)", Date.now() - 7 * 86_400_000);
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:193:%23pruneUpdates*/ DELETE FROM update_delivered WHERE created_at < ?", Date.now() - 7 * 86_400_000);
  }

  async #scheduleRetention(): Promise<void> {
    const oldest = this.#q<{ at: number | null }>("SELECT MIN(at) AS at FROM (SELECT MIN(created_at) AS at FROM chat_update UNION ALL SELECT MIN(created_at) FROM update_delivered)")[0]?.at;
    if (oldest !== null && oldest !== undefined) {
      const due = Math.max(Date.now() + 1000, oldest + 7 * 86_400_000 + 1);
      const alarm = await this.#storage.getAlarm();
      if (alarm === null || alarm > due) await this.#storage.setAlarm(due);
    }
  }

  async alarm(): Promise<void> {
    traceFields({ tenant: storedBinding(this.#storage.sql)?.tenant_id ?? "" });
    this.#pruneUpdates();
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState;
      if (Date.now() - state.last_seen >= 90_000) {
        ws.close(1001, 'heartbeat expired');
        await this.webSocketClose(ws, 1001);
      }
    }
    const pending = this.#q<{ value: string }>("SELECT value FROM meta WHERE key = 'socket_disconnect'")[0];
    if (pending) {
      const { state, due } = JSON.parse(pending.value) as { state: SocketState; due: number };
      if (Date.now() >= due) {
        if (!this.ctx.getWebSockets().some(ws => ws.readyState === WebSocket.OPEN)) await this.#presence(state, 'offline').catch(() => {});
        this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:220:alarm*/ DELETE FROM meta WHERE key = 'socket_disconnect'");
      }
    }
    await this.#socketAlarm();
    await this.#scheduleRetention();
  }

  async deliverUpdates(tenant: string, identity: string, updates: UpdateDelivery[]): Promise<void> {
    bindOnce(this.#storage.sql, tenant, identity);
    if (this.#q("SELECT key FROM meta WHERE key = 'deleted'").length) return;
    this.#storage.transactionSync(() => {
      for (const update of updates) {
        if (update.created_at < Date.now() - 7 * 86_400_000) continue;
        const fresh = this.#q("INSERT INTO update_delivered (key, created_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING key", update.key, update.created_at);
        if (fresh.length) this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:234:deliverUpdates*/ INSERT INTO chat_update (key, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING", update.key, JSON.stringify({ type: update.type, chat: update.chat, data: update.data }), update.created_at);
      }
      this.#pruneUpdates();
    });
    for (const wake of [...this.#updateWaiters]) wake();
    for (const ws of this.ctx.getWebSockets()) this.#schedulePush(ws);
    await this.#scheduleRetention();
  }

  async getUpdates(tenant: string, identity: string, offset: number, limit: number, timeout: number): Promise<{ updates: ChatUpdate[]; next_offset: number; has_more: boolean; error?: string; min_offset?: number }> {
    bindOnce(this.#storage.sql, tenant, identity);
    const deadline = Date.now() + Math.min(50, Math.max(0, timeout)) * 1000;
    for (;;) {
      this.#pruneUpdates();
      const head = this.#q<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'chat_update'")[0]?.seq ?? 0;
      const min = this.#q<{ n: number | null }>("SELECT MIN(update_id) AS n FROM chat_update")[0]?.n ?? head + 1;
      if (offset > head + 1 || (offset !== 0 && offset < min)) return { updates: [], next_offset: min, has_more: false, error: offset > head + 1 ? 'invalid_offset' : 'offset_expired', min_offset: min };
      const rows = this.#q<{ update_id: number; payload: string }>("SELECT update_id, payload FROM chat_update WHERE update_id >= ? ORDER BY update_id LIMIT ?", offset, Math.min(100, Math.max(1, limit)) + 1);
      const page = rows.slice(0, limit);
      if (!page.length && Date.now() < deadline && this.#updateWaiters.size >= 8) return { updates: [], next_offset: offset, has_more: false, error: 'rate_limited' };
      if (page.length || Date.now() >= deadline) return { updates: page.map(r => ({ ...JSON.parse(r.payload), update_id: r.update_id })), next_offset: page.at(-1)?.update_id ? page.at(-1)!.update_id + 1 : Math.max(offset, head + 1), has_more: rows.length > limit };
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.#updateWaiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.#updateWaiters.add(done);
      });
    }
  }
  /** The waiters currently parked in `wait`, for tests and tooling. */
  async waiting(tenant_id: string, identity_id: string): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    return this.#waiters.size;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, timedEnv(env));
    this.#storage = timedStorage(ctx.storage, "Inbox");
    this.#storage.transactionSync(() => {
      for (const s of SCHEMA) this.#storage.sql.exec(s);
    });
  }

  #q<T extends Record<string, SqlStorageValue>>(query: string, ...binds: SqlStorageValue[]): T[] {
    return this.#storage.sql.exec<T>(query, ...binds).toArray();
  }

  #head(): number {
    return this.#q<{ h: number | null }>("SELECT MAX(item_seq) AS h FROM item")[0]?.h ?? 0;
  }

  #open(after: number, limit: number, includeAcked: boolean): InboxItem[] {
    const rows = this.#q<ItemRow>(
      `SELECT * FROM item WHERE item_seq > ? ${includeAcked ? "" : "AND acked_at IS NULL"} ORDER BY item_seq LIMIT ?`, after, limit,
    );
    return rows.map((r) => ({ ...r, kind: r.kind as InboxItem["kind"], wake: r.wake === 1 }));
  }

  /** Synchronous snapshot; the extra row tests continuation but is never returned or skipped. */
  #page(after: number, limit: number, includeAcked: boolean): InboxPage {
    const rows = this.#open(after, limit + 1, includeAcked);
    const items = rows.slice(0, limit);
    return { head: this.#head(), items, next_after: items.at(-1)?.item_seq ?? after, has_more: rows.length > limit };
  }

  /** Internal organization deletion: retain only the binding and a delivery tombstone. */
  async purgeTenant(tenant_id: string, identity_id: string): Promise<void> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    for (const ws of this.ctx.getWebSockets()) ws.close(1008, 'organization deleted');
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:301:purgeTenant*/ DELETE FROM meta WHERE key = 'socket_disconnect'");
      for (const table of ["item", "cursor", "mail_delivered", "chat_update", "update_delivered"]) this.#storage.sql.exec(`DELETE FROM ${table}`);
      this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:303:purgeTenant*/ INSERT OR REPLACE INTO meta (key, value) VALUES ('deleted', '1')");
    });
  }

  /** Internal cleanup of only the deleted project's conversations and mail. */
  async purgeProject(tenant_id: string, identity_id: string, conversations: string[], mail: string[]): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    return this.#storage.transactionSync(() => {
      const channels = JSON.stringify(conversations), messages = JSON.stringify(mail);
      const rows = this.#q<{ item_seq: number }>("DELETE FROM item WHERE conversation_id IN (SELECT value FROM json_each(?)) OR (kind = 'mail' AND msg_id IN (SELECT value FROM json_each(?))) RETURNING item_seq", channels, messages);
      this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:313:purgeProject*/ DELETE FROM cursor WHERE conversation_id IN (SELECT value FROM json_each(?))", channels);
      this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:314:purgeProject*/ DELETE FROM chat_update WHERE json_extract(payload, '$.chat.id') IN (SELECT value FROM json_each(?))", channels);
      this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:315:purgeProject*/ DELETE FROM mail_delivered WHERE key IN (SELECT 'mail:' || value FROM json_each(?))", messages);
      return rows.length;
    });
  }

  async head(tenant_id: string, identity_id: string): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    return this.#head();
  }

  /** Allocated item sequence, retained by SQLite even when acknowledged rows are pruned. */
  async highWater(tenant_id: string, identity_id: string): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    return this.#q<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'item'")[0]?.seq ?? 0;
  }

  async deliver(tenant_id: string, identity_id: string, items: WakeItem[]): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    if (this.#q("SELECT key FROM meta WHERE key = 'deleted'").length) return 0;
    // Acked items are kept 30 days (they show with include_acked), then pruned.
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:335:deliver*/ DELETE FROM item WHERE acked_at IS NOT NULL AND acked_at < ?", Date.now() - LIMITS.INBOX_ACKED_KEEP_MS);
    let added = 0;
    for (const it of items) {
      added += this.#storage.transactionSync(() => {
        if (it.kind === "mail") {
          const fresh = this.#q<{ key: string }>("INSERT OR IGNORE INTO mail_delivered (key) VALUES (?) RETURNING key", it.key);
          if (!fresh.length) return 0;
        }
        return this.#q<{ item_seq: number }>(
          // Only duplicate keys are ignored; a storage/constraint failure must roll
          // back the mail tombstone rather than claim delivery without an item.
          `INSERT INTO item (key, kind, conversation_id, seq, msg_id, thread_root, hop, author_id, wake, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE NOT EXISTS (SELECT 1 FROM item WHERE key = ?1)
           ON CONFLICT(key) DO NOTHING RETURNING item_seq`,
          it.key, it.kind, it.conversation_id, it.seq, it.msg_id, it.thread_root, it.hop, it.author_id, it.wake ? 1 : 0, it.created_at,
        ).length;
      });
    }
    if (added > 0) for (const wake of [...this.#waiters]) wake();
    return added;
  }

  async list(tenant_id: string, identity_id: string, q: { after: number; limit: number; include_acked: boolean }): Promise<InboxPage> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    return this.#page(q.after, clampLimit(q.limit), q.include_acked);
  }

  /**
   * Open items after `after`, now; or the first that qualifies within `wait_ms` (at most 20 s); or none. A delivery
   * that does not qualify (nothing open after `after`) does not end the wait: it loops until the deadline. At most
   * INBOX_WAITERS_MAX polls park at once; beyond that a call answers at once, as if `wait_ms` were 0.
   */
  async wait(tenant_id: string, identity_id: string, q: { after: number; limit: number; wait_ms: number }): Promise<InboxPage> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    const limit = clampLimit(q.limit);
    const deadline = Date.now() + Math.min(Math.max(0, q.wait_ms), LIMITS.INBOX_WAIT_MAX_S * 1000);
    for (;;) {
      const page = this.#page(q.after, limit, false);
      const left = deadline - Date.now();
      if (page.items.length > 0 || left <= 0 || this.#waiters.size >= LIMITS.INBOX_WAITERS_MAX) return page;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#waiters.add(done);
      });
    }
  }

  async ack(tenant_id: string, identity_id: string, through: number, now: number): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    const n = this.#q<{ n: number }>("SELECT COUNT(*) AS n FROM item WHERE item_seq <= ? AND acked_at IS NULL", through)[0]!.n;
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:390:ack*/ UPDATE item SET acked_at = ? WHERE item_seq <= ? AND acked_at IS NULL", now, through);
    return n;
  }

  /** One synchronous update of exact existing items; no prefix or future acknowledgement watermark. */
  async ackItems(tenant_id: string, identity_id: string, items: number[], now: number): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    if (!Array.isArray(items) || items.length < 1 || items.length > LIMITS.INBOX_LIMIT_MAX ||
        !items.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1)) {
      throw new Error("invalid inbox item numbers");
    }
    const selected = [...new Set(items)];
    return this.#q<{ item_seq: number }>(
      // JSON keeps the full 100-item public bound below the DO's 100 SQL-variable limit.
      "UPDATE item SET acked_at = ? WHERE acked_at IS NULL AND item_seq IN (SELECT value FROM json_each(?)) RETURNING item_seq",
      now, JSON.stringify(selected),
    ).length;
  }

  /** Exact retained attention states only. Absence/pruning is unknown, never inferred acknowledgement. */
  async ackStatus(tenant_id: string, identity_id: string, items: number[]): Promise<{ item: number; state: "open" | "acked" | "unknown"; acked_at: number | null }[]> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    if (!Array.isArray(items) || items.length < 1 || items.length > LIMITS.INBOX_LIMIT_MAX ||
        !items.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1)) {
      throw new Error("invalid inbox item numbers");
    }
    const selected = [...new Set(items)];
    // One synchronous bounded snapshot; no source metadata, counters or retention mutation.
    const rows = new Map(this.#q<{ item_seq: number; acked_at: number | null }>(
      "SELECT item_seq, acked_at FROM item WHERE item_seq IN (SELECT value FROM json_each(?))", JSON.stringify(selected),
    ).map(r => [r.item_seq, r]));
    return selected.map(item => {
      const row = rows.get(item);
      return { item, state: row === undefined ? "unknown" : row.acked_at === null ? "open" : "acked", acked_at: row?.acked_at ?? null };
    });
  }

  /** Exact saved cursor only; absence differs from an explicitly saved zero. Never repairs or advances. */
  async readCursor(tenant_id: string, identity_id: string, conversation_id: string): Promise<number | null> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    return this.#q<{ read_seq: number }>("SELECT read_seq FROM cursor WHERE conversation_id = ?", conversation_id)[0]?.read_seq ?? null;
  }

  async cursors(tenant_id: string, identity_id: string): Promise<Record<string, number>> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    return Object.fromEntries(this.#q<{ conversation_id: string; read_seq: number }>("SELECT conversation_id, read_seq FROM cursor").map((r) => [r.conversation_id, r.read_seq]));
  }

  async markRead(tenant_id: string, identity_id: string, conversation_id: string, seq: number): Promise<number> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    this.#storage.sql.exec(
      "/*perf-site:src%2Fchat%2FinboxDO.ts:440:markRead*/ INSERT INTO cursor (conversation_id, read_seq) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET read_seq = MAX(read_seq, excluded.read_seq)",
      conversation_id, seq,
    );
    return this.#q<{ read_seq: number }>("SELECT read_seq FROM cursor WHERE conversation_id = ?", conversation_id)[0]!.read_seq;
  }

  /**
   * Spec 6.5 per-identity and per-session windows, counted exactly; on success the post is counted and the hop of
   * the newest wake delivered in this conversation within 10 minutes (any thread or the top level, acked or not)
   * comes back as a cause for the post (ruling C-7).
   */
  async reserve(tenant_id: string, identity_id: string, q: { session_id: string; is_agent: boolean; conversation_id: string; now: number }): Promise<ReserveResult> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:454:reserve*/ DELETE FROM stamp WHERE at < ?", q.now - 86_400_000);
    const stamps = (scope: string) => this.#q<{ at: number }>("SELECT at FROM stamp WHERE scope = ?", scope).map((r) => r.at);
    const session = `session:${q.session_id}`;
    const v = postVerdict({ is_agent: q.is_agent, session: stamps(session), identity: stamps("identity"), now: q.now });
    if (!v.ok) return v;
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:459:reserve*/ INSERT INTO stamp (scope, at) VALUES (?, ?), ('identity', ?)", session, q.now, q.now);
    const w = this.#q<{ hop: number }>(
      "SELECT hop FROM item WHERE wake = 1 AND created_at > ? AND conversation_id = ? ORDER BY item_seq DESC LIMIT 1", q.now - LIMITS.WAKE_HOP_WINDOW_MS, q.conversation_id,
    )[0];
    // Newest open wake per scope: a thread's own wakes, and the wake on its root message (ruling C-4).
    const thread_wake_hops: Record<string, number> = {};
    for (const r of this.#q<{ k: string; hop: number }>(
      "SELECT COALESCE(thread_root, msg_id) AS k, hop FROM item WHERE wake = 1 AND created_at > ? AND conversation_id = ? ORDER BY item_seq DESC LIMIT 200", q.now - LIMITS.WAKE_HOP_WINDOW_MS, q.conversation_id,
    )) if (!(r.k in thread_wake_hops)) thread_wake_hops[r.k] = r.hop;
    return { ok: true, wake_hop: w ? w.hop : null, thread_wake_hops };
  }

  /** Counts a refusal; the one that makes more than 20 in an hour trips the wire and clears the window, so it can trip again after an unmute. */
  async noteRefusal(tenant_id: string, identity_id: string, now: number): Promise<{ count: number; tripped: boolean }> {
    bindOnce(this.#storage.sql, tenant_id, identity_id);
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:474:noteRefusal*/ DELETE FROM refusal WHERE at <= ?", now - 3_600_000);
    this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:475:noteRefusal*/ INSERT INTO refusal (at) VALUES (?)", now);
    const count = this.#q<{ n: number }>("SELECT COUNT(*) AS n FROM refusal")[0]!.n;
    const tripped = count > LIMITS.TRIPWIRE_REFUSALS;
    if (tripped) this.#storage.sql.exec("/*perf-site:src%2Fchat%2FinboxDO.ts:478:noteRefusal*/ DELETE FROM refusal");
    return { count, tripped };
  }
}
instrumentDurableObject(Inbox, "Inbox");
