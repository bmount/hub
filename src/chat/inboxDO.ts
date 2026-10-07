import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { bindOnce } from "./bound";
import { LIMITS, postVerdict } from "./rules";
import type { InboxItem, WakeItem } from "./types";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS item (item_seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
     conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_id TEXT NOT NULL, thread_root TEXT, hop INTEGER NOT NULL,
     author_id TEXT NOT NULL, wake INTEGER NOT NULL, created_at INTEGER NOT NULL, acked_at INTEGER)`,
  "CREATE TABLE IF NOT EXISTS cursor (conversation_id TEXT PRIMARY KEY, read_seq INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS stamp (scope TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS stamp_scope ON stamp (scope, at)",
  "CREATE TABLE IF NOT EXISTS refusal (at INTEGER NOT NULL)",
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
  #waiters = new Set<() => void>();
  /** The waiters currently parked in `wait`, for tests and tooling. */
  async waiting(tenant_id: string, identity_id: string): Promise<number> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    return this.#waiters.size;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const s of SCHEMA) this.ctx.storage.sql.exec(s);
  }

  #q<T extends Record<string, SqlStorageValue>>(query: string, ...binds: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...binds).toArray();
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

  async head(tenant_id: string, identity_id: string): Promise<number> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    return this.#head();
  }

  async deliver(tenant_id: string, identity_id: string, items: WakeItem[]): Promise<number> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    // Acked items are kept 30 days (they show with include_acked), then pruned.
    this.ctx.storage.sql.exec("DELETE FROM item WHERE acked_at IS NOT NULL AND acked_at < ?", Date.now() - LIMITS.INBOX_ACKED_KEEP_MS);
    let added = 0;
    for (const it of items) {
      added += this.#q<{ item_seq: number }>(
        // OR IGNORE settles a duplicate key; the NOT EXISTS keeps a duplicate from using up an item number.
        `INSERT OR IGNORE INTO item (key, kind, conversation_id, seq, msg_id, thread_root, hop, author_id, wake, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE NOT EXISTS (SELECT 1 FROM item WHERE key = ?1) RETURNING item_seq`,
        it.key, it.kind, it.conversation_id, it.seq, it.msg_id, it.thread_root, it.hop, it.author_id, it.wake ? 1 : 0, it.created_at,
      ).length;
    }
    if (added > 0) for (const wake of [...this.#waiters]) wake();
    return added;
  }

  async list(tenant_id: string, identity_id: string, q: { after: number; limit: number; include_acked: boolean }): Promise<{ head: number; items: InboxItem[] }> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    return { head: this.#head(), items: this.#open(q.after, clampLimit(q.limit), q.include_acked) };
  }

  /**
   * Open items after `after`, now; or the first that qualifies within `wait_ms` (at most 20 s); or none. A delivery
   * that does not qualify (nothing open after `after`) does not end the wait: it loops until the deadline. At most
   * INBOX_WAITERS_MAX polls park at once; beyond that a call answers at once, as if `wait_ms` were 0.
   */
  async wait(tenant_id: string, identity_id: string, q: { after: number; limit: number; wait_ms: number }): Promise<{ head: number; items: InboxItem[] }> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    const limit = clampLimit(q.limit);
    const deadline = Date.now() + Math.min(Math.max(0, q.wait_ms), LIMITS.INBOX_WAIT_MAX_S * 1000);
    for (;;) {
      const ready = this.#open(q.after, limit, false);
      const left = deadline - Date.now();
      if (ready.length > 0 || left <= 0 || this.#waiters.size >= LIMITS.INBOX_WAITERS_MAX) return { head: this.#head(), items: ready };
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
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    const n = this.#q<{ n: number }>("SELECT COUNT(*) AS n FROM item WHERE item_seq <= ? AND acked_at IS NULL", through)[0]!.n;
    this.ctx.storage.sql.exec("UPDATE item SET acked_at = ? WHERE item_seq <= ? AND acked_at IS NULL", now, through);
    return n;
  }

  async cursors(tenant_id: string, identity_id: string): Promise<Record<string, number>> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    return Object.fromEntries(this.#q<{ conversation_id: string; read_seq: number }>("SELECT conversation_id, read_seq FROM cursor").map((r) => [r.conversation_id, r.read_seq]));
  }

  async markRead(tenant_id: string, identity_id: string, conversation_id: string, seq: number): Promise<number> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    this.ctx.storage.sql.exec(
      "INSERT INTO cursor (conversation_id, read_seq) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET read_seq = MAX(read_seq, excluded.read_seq)",
      conversation_id, seq,
    );
    return this.#q<{ read_seq: number }>("SELECT read_seq FROM cursor WHERE conversation_id = ?", conversation_id)[0]!.read_seq;
  }

  /**
   * Spec 6.5 per-identity and per-session windows, counted exactly; on success the post is counted and the hop of
   * the newest open top-level wake in this conversation comes back as the cause for a top-level post (spec 6.6).
   */
  async reserve(tenant_id: string, identity_id: string, q: { session_id: string; is_agent: boolean; conversation_id: string; now: number }): Promise<ReserveResult> {
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    this.ctx.storage.sql.exec("DELETE FROM stamp WHERE at < ?", q.now - 86_400_000);
    const stamps = (scope: string) => this.#q<{ at: number }>("SELECT at FROM stamp WHERE scope = ?", scope).map((r) => r.at);
    const session = `session:${q.session_id}`;
    const v = postVerdict({ is_agent: q.is_agent, session: stamps(session), identity: stamps("identity"), now: q.now });
    if (!v.ok) return v;
    this.ctx.storage.sql.exec("INSERT INTO stamp (scope, at) VALUES (?, ?), ('identity', ?)", session, q.now, q.now);
    const w = this.#q<{ hop: number }>(
      "SELECT hop FROM item WHERE wake = 1 AND created_at > ? AND conversation_id = ? AND thread_root IS NULL ORDER BY item_seq DESC LIMIT 1", q.now - LIMITS.WAKE_HOP_WINDOW_MS, q.conversation_id,
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
    bindOnce(this.ctx.storage.sql, tenant_id, identity_id);
    this.ctx.storage.sql.exec("DELETE FROM refusal WHERE at <= ?", now - 3_600_000);
    this.ctx.storage.sql.exec("INSERT INTO refusal (at) VALUES (?)", now);
    const count = this.#q<{ n: number }>("SELECT COUNT(*) AS n FROM refusal")[0]!.n;
    const tripped = count > LIMITS.TRIPWIRE_REFUSALS;
    if (tripped) this.ctx.storage.sql.exec("DELETE FROM refusal");
    return { count, tripped };
  }
}
