import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { ulid } from "../ids";
import { postIntentFingerprint } from "./postIntent";
import { bindOnce, storedBinding } from "./bound";
import { PRESENCE_TTL_MS, retainedPresence, type PresenceRow, type PresenceStatus } from "./presence";
import { inboxStub } from "./stubs";
import { getControls } from "../db/chat";
import { LIMITS, computeHop, gateRefuses, nextAgentRun, pairTrip, wakesAllowed } from "./rules";
import type {
  AuthorKind, ChatSessionKind, Digest, DigestQuery, MsgView, PostInput, PostOk, PostOutcome, ReadPage, ReadQuery, StoredRef, Suppressed,
  ResponseAttribution, ResponseIntent, ResponseSlot, ResponseStatus, Version, VersionInput, WakeItem, WakeKind,
} from "./types";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS artifact (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, msg_id TEXT NOT NULL, rev INTEGER NOT NULL,
     kind TEXT NOT NULL, author_id TEXT NOT NULL, session_id TEXT, session_kind TEXT NOT NULL, thread_root TEXT, body TEXT NOT NULL,
     body_sha256 TEXT NOT NULL, meta_json TEXT NOT NULL, hop INTEGER NOT NULL, cause_seq INTEGER, created_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS artifact_msg ON artifact (msg_id, rev)",
  "CREATE INDEX IF NOT EXISTS artifact_author ON artifact (author_id, created_at)",
  `CREATE TABLE IF NOT EXISTS msg (msg_id TEXT PRIMARY KEY, first_seq INTEGER NOT NULL UNIQUE, last_seq INTEGER NOT NULL, rev INTEGER NOT NULL,
     kind TEXT NOT NULL, author_id TEXT NOT NULL, author_kind TEXT NOT NULL, session_id TEXT, session_kind TEXT NOT NULL, thread_root TEXT,
     hop INTEGER NOT NULL, retracted INTEGER NOT NULL DEFAULT 0, reply_count INTEGER NOT NULL DEFAULT 0, last_reply_seq INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS msg_thread ON msg (thread_root, first_seq)",
  "CREATE TABLE IF NOT EXISTS ref (seq INTEGER NOT NULL, msg_id TEXT NOT NULL, rev INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, title_snapshot TEXT, PRIMARY KEY (seq, kind, key))",
  "CREATE TABLE IF NOT EXISTS thread_sub (thread_root TEXT NOT NULL, identity_id TEXT NOT NULL, kind TEXT NOT NULL, via TEXT NOT NULL, PRIMARY KEY (thread_root, identity_id))",
  "CREATE TABLE IF NOT EXISTS scope_state (scope TEXT PRIMARY KEY, agent_run INTEGER NOT NULL, gate_noted INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pair_block (a TEXT NOT NULL, b TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (a, b))",
  "CREATE TABLE IF NOT EXISTS idem (identity_id TEXT NOT NULL, key TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (identity_id, key))",
  "CREATE TABLE IF NOT EXISTS inbox_outbox (key TEXT PRIMARY KEY, identity_id TEXT NOT NULL, item_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS index_outbox (seq INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)",
];
// Objects created before the backoff column existed get it added; a pragma table_info check says whether they need it.
const UPGRADES: Array<{ table: string; column: string; ddl: string }> = [
  { table: "inbox_outbox", column: "next_at", ddl: "ALTER TABLE inbox_outbox ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0" },
  { table: "index_outbox", column: "next_at", ddl: "ALTER TABLE index_outbox ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0" },
];

type Op = "post" | "edit" | "retract";
type OutboxTable = "inbox_outbox" | "index_outbox";

type MsgRow = {
  msg_id: string; first_seq: number; last_seq: number; rev: number; kind: string; author_id: string; author_kind: string;
  session_id: string | null; session_kind: string; thread_root: string | null; hop: number; retracted: number; reply_count: number;
  last_reply_seq: number | null; created_at: number; updated_at: number; body: string; meta_json: string;
  current_session_id: string | null; current_session_kind: string;
};
type ArtifactRow = {
  seq: number; msg_id: string; rev: number; kind: string; author_id: string; session_id: string | null; session_kind: string;
  thread_root: string | null; body: string; meta_json: string; hop: number; created_at: number;
};
type Meta = { mentions?: string[]; hop_limited?: boolean; retracted?: boolean; loop?: string[]; gate?: boolean; response_to?: ResponseAttribution };
type NewMessage = {
  kind: "say" | "system"; author_id: string; author_kind: AuthorKind; session_id: string | null; session_kind: ChatSessionKind;
  thread_root: string | null; body: string; body_sha256: string; meta: Meta; hop: number; cause_seq: number | null; now: number;
};

export const SYSTEM_GATE = "Agents have posted 8 messages in a row here. Agent posts are paused until a human posts.";
export const SYSTEM_LOOP = "Two agents kept answering each other. Wakes between them are paused for 30 minutes.";

// Author identity remains the original message owner (including operator retractions), but the current
// text's session provenance comes from its latest artifact, not the session that created revision 1.
const MSG_SELECT = "SELECT m.*, a.body, a.meta_json, a.session_id AS current_session_id, a.session_kind AS current_session_kind FROM msg m JOIN artifact a ON a.seq = m.last_seq";

/** Messaging spec 9.1: one per channel. Serializes every write to the conversation and assigns `seq`. */
export class Conversation extends DurableObject<Env> {
  #tenant = "";
  #id = "";
  /** Tail of the drain chain: drains run one at a time, so index flushes cannot interleave. */
  #draining: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const s of SCHEMA) this.ctx.storage.sql.exec(s);
    for (const u of UPGRADES) {
      const has = this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${u.table}')`).toArray().some((c) => c.name === u.column);
      if (!has) this.ctx.storage.sql.exec(u.ddl);
    }
  }

  #q<T extends Record<string, SqlStorageValue>>(query: string, ...binds: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...binds).toArray();
  }

  #run(query: string, ...binds: SqlStorageValue[]): void {
    this.ctx.storage.sql.exec(query, ...binds);
  }

  #bind(tenant_id: string, conversation_id: string): void {
    bindOnce(this.ctx.storage.sql, tenant_id, conversation_id);
    this.#tenant = tenant_id;
    this.#id = conversation_id;
  }

  #head(): number {
    return this.#q<{ h: number | null }>("SELECT MAX(seq) AS h FROM artifact")[0]?.h ?? 0;
  }

  /** A message by its number (decimal seq) or its msg_id, joined to its latest version. */
  #msg(ref: string): MsgRow | null {
    const bySeq = /^\d{1,12}$/.test(ref);
    return this.#q<MsgRow>(`${MSG_SELECT} WHERE ${bySeq ? "m.first_seq = ?" : "m.msg_id = ?"}`, bySeq ? Number(ref) : ref)[0] ?? null;
  }

  #view(r: MsgRow): MsgView {
    const meta = JSON.parse(r.meta_json) as Meta;
    const root = r.thread_root ? this.#q<{ first_seq: number }>("SELECT first_seq FROM msg WHERE msg_id = ?", r.thread_root)[0]?.first_seq ?? null : null;
    const refs = this.#q<{ kind: string; key: string; title: string | null }>("SELECT kind, key, title_snapshot AS title FROM ref WHERE seq = ? ORDER BY rowid", r.last_seq)
      .map((x) => ({ kind: x.kind as StoredRef["kind"], key: x.key, title: x.title }));
    return {
      seq: r.first_seq, msg_id: r.msg_id, rev: r.rev, kind: r.kind === "system" ? "system" : "say", thread_root: r.thread_root, root_seq: root,
      author_id: r.author_id, author_kind: r.author_kind as AuthorKind, session_id: r.current_session_id, session_kind: r.current_session_kind as ChatSessionKind,
      hop: r.hop, body: r.body, edited: r.rev > 1 && r.retracted === 0, retracted: r.retracted === 1, reply_count: r.reply_count,
      last_reply_seq: r.last_reply_seq, refs, mentions: meta.mentions ?? [], hop_limited: meta.hop_limited === true,
      created_at: r.created_at, updated_at: r.updated_at, response_to: meta.response_to ?? null,
    };
  }

  #append(a: Omit<NewMessage, "author_kind"> & { msg_id: string; rev: number }): number {
    this.#run(
      `INSERT INTO artifact (id, msg_id, rev, kind, author_id, session_id, session_kind, thread_root, body, body_sha256, meta_json, hop, cause_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ulid(a.now), a.msg_id, a.rev, a.kind, a.author_id, a.session_id, a.session_kind, a.thread_root, a.body, a.body_sha256,
      JSON.stringify(a.meta), a.hop, a.cause_seq, a.now,
    );
    const seq = this.#q<{ s: number }>("SELECT last_insert_rowid() AS s")[0]!.s;
    this.#run("INSERT INTO index_outbox (seq) VALUES (?)", seq);
    return seq;
  }

  #newMessage(a: NewMessage): { seq: number; msg_id: string } {
    const msg_id = ulid(a.now);
    const seq = this.#append({ ...a, msg_id, rev: 1 });
    this.#run(
      `INSERT INTO msg (msg_id, first_seq, last_seq, rev, kind, author_id, author_kind, session_id, session_kind, thread_root, hop, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg_id, seq, seq, a.kind, a.author_id, a.author_kind, a.session_id, a.session_kind, a.thread_root, a.hop, a.now, a.now,
    );
    if (a.thread_root) this.#run("UPDATE msg SET reply_count = reply_count + 1, last_reply_seq = ? WHERE msg_id = ?", seq, a.thread_root);
    return { seq, msg_id };
  }

  #system(body: string, thread_root: string | null, meta: Meta, now: number): { seq: number; msg_id: string } {
    return this.#newMessage({
      kind: "system", author_id: "hub", author_kind: "hub", session_id: null, session_kind: "hub", thread_root, body, body_sha256: "", meta, hop: 0,
      cause_seq: null, now,
    });
  }

  #storeRefs(seq: number, msg_id: string, rev: number, refs: StoredRef[]): void {
    for (const r of refs) this.#run("INSERT OR IGNORE INTO ref (seq, msg_id, rev, kind, key, title_snapshot) VALUES (?, ?, ?, ?, ?, ?)", seq, msg_id, rev, r.kind, r.key, r.title);
  }

  /** Keys are namespaced by operation (a post key never replays an edit) and expire after 24 h. */
  #replayRecord(identity_id: string, op: Op, key: string | null, now: number): { result: PostOk; fingerprint?: string } | null {
    if (!key) return null;
    const r = this.#q<{ result_json: string }>(
      "SELECT result_json FROM idem WHERE identity_id = ? AND key = ? AND created_at > ?", identity_id, `${op}:${key}`, now - LIMITS.IDEM_TTL_MS,
    )[0];
    if (!r) return null;
    const stored = JSON.parse(r.result_json) as PostOk | { result: PostOk; fingerprint: string };
    // Old records and version operations retain their original result-only shape.
    return "result" in stored ? stored : { result: stored };
  }

  #replay(identity_id: string, op: Op, key: string | null, now: number): PostOk | null {
    const prior = this.#replayRecord(identity_id, op, key, now);
    return prior ? { ...prior.result, replayed: true } : null;
  }

  #postReplay(identity_id: string, key: string | null, fingerprint: string, now: number): PostOutcome | null {
    const prior = this.#replayRecord(identity_id, "post", key, now);
    if (!prior) return null;
    if (!prior.fingerprint || prior.fingerprint !== fingerprint) {
      return { refused: "conflict", detail: "post intent differs or was not recorded for this key; reconcile authorized history before sending" };
    }
    return { ...prior.result, replayed: true };
  }

  #remember(identity_id: string, op: Op, key: string | null, result: PostOk, now: number, fingerprint?: string): void {
    if (!key) return;
    this.#run("DELETE FROM idem WHERE created_at <= ?", now - LIMITS.IDEM_TTL_MS);
    this.#run("INSERT OR REPLACE INTO idem (identity_id, key, result_json, created_at) VALUES (?, ?, ?, ?)", identity_id, `${op}:${key}`, JSON.stringify(fingerprint ? { result, fingerprint } : result), now);
  }

  #responseKey(identity_id: string, intent: Pick<ResponseIntent, "source" | "stage">): string {
    // Preserve all previously committed responses as the default result slot.
    return intent.stage === "progress"
      ? `response:v2:progress:${identity_id}:${intent.source.msg_id}`
      : `response:v1:${identity_id}:${intent.source.msg_id}`;
  }

  /** No TTL: compact evidence/result only, retained with the conversation. Never stores response text. */
  #responseReplay(identity_id: string, intent: ResponseIntent): PostOutcome | null {
    if (intent.stage !== undefined && intent.stage !== "progress" && intent.stage !== "result") {
      return { refused: "conflict", detail: "response stage must be progress or result" };
    }
    const row = this.#q<{ value: string }>("SELECT value FROM meta WHERE key = ?", this.#responseKey(identity_id, intent))[0];
    if (row) {
      const prior = JSON.parse(row.value) as { intent: ResponseIntent; result: PostOk };
      if (prior.intent.source.rev !== intent.source.rev || prior.intent.source.author_id !== intent.source.author_id || prior.intent.fingerprint !== intent.fingerprint) {
        return { refused: "conflict", detail: "a different response is already recorded for this source/stage; reconcile the original thread" };
      }
      // Reconcile even after source/response edits or retraction, but never resurrect either message.
      return { ...prior.result, replayed: true };
    }
    const source = this.#msg(intent.source.msg_id);
    if (!source || source.kind !== "say") return { refused: "not_found" };
    if (source.retracted || source.rev !== intent.source.rev || source.author_id !== intent.source.author_id) {
      return { refused: "conflict", detail: "source evidence changed or does not match; read the original message again" };
    }
    return null;
  }

  /** Read-only preflight; post repeats this check inside the artifact/outbox transaction. */
  async responseReplay(tenant_id: string, conversation_id: string, identity_id: string, intent: ResponseIntent): Promise<PostOutcome | null> {
    this.#bind(tenant_id, conversation_id);
    return this.#responseReplay(identity_id, intent);
  }

  /** Caller-only durable ledger lookup, including changed/retracted sources. Never sends or replays a post. */
  async responseStatus(tenant_id: string, conversation_id: string, identity_id: string, msg: string): Promise<ResponseStatus | null> {
    this.#bind(tenant_id, conversation_id);
    const source = this.#msg(msg);
    if (!source || source.kind !== "say") return null;
    const evidence = { msg_id: source.msg_id, rev: source.rev, author_id: source.author_id };
    const slot = (stage: "progress" | "result"): ResponseSlot | null => {
      const row = this.#q<{ value: string }>("SELECT value FROM meta WHERE key = ?", this.#responseKey(identity_id, { source: evidence, stage }))[0];
      if (!row) return null;
      const prior = JSON.parse(row.value) as { intent: ResponseIntent; result: PostOk };
      const current = this.#msg(prior.result.msg_id);
      return {
        source: { msg_id: prior.intent.source.msg_id, rev: prior.intent.source.rev, author_id: prior.intent.source.author_id },
        committed: { msg_id: prior.result.msg_id, seq: prior.result.seq, rev: prior.result.rev },
        current: current ? { rev: current.rev, retracted: current.retracted === 1 } : null,
      };
    };
    // Synchronous SQL reads observe one snapshot: current head/source and both slots cannot interleave with a write.
    return { head: this.#head(), source: { ...evidence, seq: source.first_seq, retracted: source.retracted === 1 }, progress: slot("progress"), result: slot("result") };
  }

  /** Spec 6.4: messages by others, not system, newer than `after` in the scope (the thread, or the top level). */
  #stale(me: string, after: number, root: string | null): MsgView[] {
    const scope = root ? "(thread_root = ? OR msg_id = ?)" : "thread_root IS NULL";
    const ids = this.#q<{ msg_id: string }>(
      `SELECT msg_id FROM artifact WHERE seq > ? AND author_id <> ? AND kind <> 'system' AND ${scope} GROUP BY msg_id ORDER BY MIN(seq) LIMIT 50`,
      after, me, ...(root ? [root, root] : []),
    );
    return ids.map((x) => this.#view(this.#msg(x.msg_id)!));
  }

  /** The newest few messages by others in the scope: what a post that claims a view past the head is shown. */
  #tail(me: string, root: string | null): MsgView[] {
    const scope = root ? "(thread_root = ? OR msg_id = ?)" : "thread_root IS NULL";
    const ids = this.#q<{ msg_id: string }>(
      `SELECT msg_id FROM artifact WHERE author_id <> ? AND kind <> 'system' AND ${scope} GROUP BY msg_id ORDER BY MIN(seq) DESC LIMIT 5`,
      me, ...(root ? [root, root] : []),
    );
    return ids.reverse().map((x) => this.#view(this.#msg(x.msg_id)!));
  }

  /** `after` is the head the caller read; one past the head cannot be a view of anything, and would skip read-first. */
  #staleCheck(me: string, after: number, root: string | null): PostOutcome | null {
    const head = this.#head();
    if (after > head) return { refused: "stale_view", head, missed: this.#tail(me, root) };
    const missed = this.#stale(me, after, root);
    return missed.length > 0 ? { refused: "stale_view", head, missed } : null;
  }

  #blocked(x: string, y: string, now: number): boolean {
    const [a, b] = x < y ? [x, y] : [y, x];
    return this.#q<{ n: number }>("SELECT COUNT(*) AS n FROM pair_block WHERE a = ? AND b = ? AND until > ?", a, b, now)[0]!.n > 0;
  }

  #subscribe(root: string, identity_id: string, kind: "human" | "agent", via: "author" | "mention"): void {
    this.#run(
      `INSERT INTO thread_sub (thread_root, identity_id, kind, via) VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_root, identity_id) DO UPDATE SET via = CASE WHEN excluded.via = 'mention' THEN 'mention' ELSE thread_sub.via END`,
      root, identity_id, kind, via,
    );
  }

  #enqueue(identity_id: string, item: Omit<WakeItem, "key" | "conversation_id">, key: string): void {
    const full: WakeItem = { ...item, key: `${this.#id}:${key}`, conversation_id: this.#id };
    this.#run("INSERT OR IGNORE INTO inbox_outbox (key, identity_id, item_json) VALUES (?, ?, ?)", full.key, identity_id, JSON.stringify(full));
  }

  /** Messages whose current text contains every term (case-insensitive), newest first; retracted ones never match. */
  async search(tenant_id: string, conversation_id: string, terms: string[], limit: number): Promise<Array<{ msg_id: string; seq: number; author_id: string; thread_root: string | null; body: string; created_at: number }>> {
    this.#bind(tenant_id, conversation_id);
    const ts = terms.slice(0, 6).map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (!ts.length) return [];
    return this.#q<{ msg_id: string; seq: number; author_id: string; thread_root: string | null; body: string; created_at: number }>(
      `SELECT m.msg_id, m.first_seq AS seq, a.author_id, m.thread_root, a.body, a.created_at FROM msg m JOIN artifact a ON a.msg_id = m.msg_id AND a.rev = m.rev
       WHERE m.kind = 'say' AND m.retracted = 0 AND ${ts.map(() => "a.body LIKE ? ESCAPE '\\'").join(" AND ")}
       ORDER BY m.first_seq DESC LIMIT ?`, ...ts, Math.min(limit, 20));
  }

  /** Pimwell's own notice (app telemetry on #<project>-ops): a system message; nobody is woken. */
  async notice(tenant_id: string, conversation_id: string, body: string, now: number): Promise<{ seq: number; msg_id: string }> {
    this.#bind(tenant_id, conversation_id);
    return this.ctx.storage.transactionSync(() => this.#system(body, null, {}, now));
  }

  /** Ephemeral, bounded KV state; no message, wake, cursor or activity-ledger side effects. */
  async heartbeat(tenant_id: string, conversation_id: string, identity_id: string, status: PresenceStatus, via_assistant = false): Promise<PresenceRow> {
    this.#bind(tenant_id, conversation_id);
    const now = Date.now();
    const row: PresenceRow = { identity_id, status, via_assistant, last_seen: now, expires_at: status === "offline" ? now : now + PRESENCE_TTL_MS };
    await this.ctx.storage.transaction(async (tx) => {
      const rows = (await tx.get<PresenceRow[]>("presence:v1")) ?? [];
      await tx.put("presence:v1", retainedPresence([row, ...rows.filter((r) => r.identity_id !== identity_id)], now));
    });
    return row;
  }

  async presence(tenant_id: string, conversation_id: string): Promise<PresenceRow[]> {
    this.#bind(tenant_id, conversation_id);
    return retainedPresence((await this.ctx.storage.get<PresenceRow[]>("presence:v1")) ?? [], Date.now());
  }

  async head(tenant_id: string, conversation_id: string): Promise<number> {
    this.#bind(tenant_id, conversation_id);
    return this.#head();
  }

  async replay(tenant_id: string, conversation_id: string, identity_id: string, op: Op, key: string): Promise<PostOk | null> {
    this.#bind(tenant_id, conversation_id);
    return this.#replay(identity_id, op, key, Date.now());
  }

  /** Read-only payload-bound preflight; post repeats it atomically before committing artifacts/outboxes. */
  async postReplay(tenant_id: string, conversation_id: string, identity_id: string, key: string, fingerprint: string): Promise<PostOutcome | null> {
    this.#bind(tenant_id, conversation_id);
    return this.#postReplay(identity_id, key, fingerprint, Date.now());
  }

  async post(input: PostInput): Promise<PostOutcome> {
    this.#bind(input.tenant_id, input.conversation_id);
    const intent_fingerprint = input.intent_fingerprint ?? await postIntentFingerprint(input);
    const outcome = this.ctx.storage.transactionSync(() => this.#post({ ...input, intent_fingerprint }));
    await this.#drain();
    return outcome;
  }

  #post(p: PostInput & { intent_fingerprint: string }): PostOutcome {
    const me = p.author;
    // The Worker checks these from D1 first; repeat supplied controls even for cached successes.
    // Replay is reconciliation, not permission to bypass a mute or kill switch.
    if (me.kind === "agent") {
      if (!p.audience.agents_enabled) return { refused: "forbidden", detail: "agent posting is switched off in this tenant" };
      if (p.audience.muted_agents.includes(me.id)) return { refused: "forbidden", detail: "this agent is muted" };
      if (p.policy === "muted") return { refused: "forbidden", detail: "this channel takes no agent posts" };
    }
    // Durable responses must never replay an unrelated ordinary idempotency key.
    if (!p.response) {
      const prior = this.#postReplay(me.id, p.idempotency_key, p.intent_fingerprint, p.now);
      if (prior) return prior;
    }
    if (p.response) {
      if (p.reply_to !== p.response.source.msg_id || p.after === null) return { refused: "conflict", detail: "durable responses require the exact source reply target and a read head" };
      const prior = this.#responseReplay(me.id, p.response);
      if (prior) return prior;
    }
    let target: MsgRow | null = null;
    if (p.reply_to !== null) {
      target = this.#msg(p.reply_to);
      if (!target || target.kind === "system") return { refused: "not_found" };
    }
    const root = target ? target.thread_root ?? target.msg_id : null;
    if (me.kind === "agent" && p.policy === "mention_only") {
      const mentioned = root !== null && this.#q<{ n: number }>("SELECT COUNT(*) AS n FROM thread_sub WHERE thread_root = ? AND identity_id = ? AND via = 'mention'", root, me.id)[0]!.n > 0;
      if (!mentioned) return { refused: "forbidden", detail: "this channel takes agent posts only as replies in threads that mention the agent" };
    }
    if (p.after !== null) {
      const stale = this.#staleCheck(me.id, p.after, root);
      if (stale) return stale;
    }
    const dup = this.#q<{ n: number }>(
      "SELECT COUNT(*) AS n FROM artifact WHERE author_id = ? AND body_sha256 = ? AND kind = 'say' AND created_at > ?", me.id, p.body_sha256, p.now - LIMITS.DUPLICATE_WINDOW_MS,
    )[0]!.n;
    if (dup > 0) return { refused: "duplicate" };
    if (me.kind === "agent") {
      const recent = this.#q<{ at: number }>("SELECT created_at AS at FROM artifact WHERE session_kind = 'agent_run' AND kind = 'say' AND rev = 1 AND created_at > ? ORDER BY created_at", p.now - 60_000)
        .map((r) => r.at);
      if (recent.length >= LIMITS.CONV_AGENT_PER_MIN) {
        return { refused: "rate", retry_after_s: Math.max(1, Math.ceil((recent[recent.length - LIMITS.CONV_AGENT_PER_MIN]! + 60_000 - p.now) / 1000)) };
      }
    }
    const scope = root ?? "top";
    const state = this.#q<{ agent_run: number; gate_noted: number }>("SELECT agent_run, gate_noted FROM scope_state WHERE scope = ?", scope)[0] ?? { agent_run: 0, gate_noted: 0 };
    if (gateRefuses(me.kind, state.agent_run)) {
      if (state.gate_noted === 0) {
        this.#system(SYSTEM_GATE, root, { gate: true }, p.now);
        this.#run("INSERT INTO scope_state (scope, agent_run, gate_noted) VALUES (?, ?, 1) ON CONFLICT (scope) DO UPDATE SET gate_noted = 1", scope, state.agent_run);
      }
      return { refused: "needs_human" };
    }

    // Ruling C-7: the newest wake this agent was given anywhere in the conversation counts, so a top-level post after a thread wake cannot reset the chain.
    const threadWake = root ? p.thread_wake_hops[root] ?? null : null;
    const scopeWake = threadWake === null && p.wake_hop === null ? null : Math.max(threadWake ?? 0, p.wake_hop ?? 0);
    const hop = computeHop(me.kind, target ? target.hop : null, scopeWake);
    const { seq, msg_id } = this.#newMessage({
      kind: "say", author_id: me.id, author_kind: me.kind, session_id: me.session_id, session_kind: me.session_kind, thread_root: root,
      body: p.body, body_sha256: p.body_sha256, meta: {
        mentions: p.mentions.map((m) => m.identity_id), hop_limited: !wakesAllowed(hop),
        // Source evidence was checked in this transaction. Publish only exact source/stage attribution,
        // never the private fingerprint, replay key, recipients or a claim that work ran.
        ...(p.response ? { response_to: { msg_id: p.response.source.msg_id, author_id: p.response.source.author_id,
          rev: p.response.source.rev, seq: target!.first_seq, stage: p.response.stage ?? "result" } } : {}),
      },
      hop, cause_seq: target ? target.last_seq : null, now: p.now,
    });
    this.#storeRefs(seq, msg_id, 1, p.refs);
    const run = nextAgentRun(me.kind, state.agent_run);
    this.#run(
      `INSERT INTO scope_state (scope, agent_run, gate_noted) VALUES (?, ?, 0)
       ON CONFLICT (scope) DO UPDATE SET agent_run = excluded.agent_run, gate_noted = CASE WHEN excluded.agent_run = 0 THEN 0 ELSE scope_state.gate_noted END`,
      scope, run,
    );
    const thread = root ?? msg_id;
    this.#subscribe(thread, me.id, me.kind, "author");
    for (const m of p.mentions) if (m.identity_id !== me.id) this.#subscribe(thread, m.identity_id, m.kind, "mention");

    let loop: { a: string; b: string } | null = null;
    if (me.kind === "agent") {
      const recent = this.#q<{ author_id: string; author_kind: string; created_at: number }>(
        "SELECT author_id, author_kind, created_at FROM msg WHERE kind = 'say' AND created_at > ? ORDER BY first_seq DESC LIMIT 32", p.now - LIMITS.PAIR_WINDOW_MS,
      ).reverse();
      const trip = pairTrip(recent.map((r) => ({ author_id: r.author_id, author_kind: r.author_kind as AuthorKind, created_at: r.created_at })), p.now);
      if (trip && !this.#blocked(trip.a, trip.b, p.now)) {
        this.#run("INSERT INTO pair_block (a, b, until) VALUES (?, ?, ?) ON CONFLICT (a, b) DO UPDATE SET until = excluded.until", trip.a, trip.b, p.now + LIMITS.PAIR_BLOCK_MS);
        const sys = this.#system(SYSTEM_LOOP, null, { loop: [trip.a, trip.b] }, p.now);
        for (const agentId of [trip.a, trip.b]) {
          const op = p.audience.operators[agentId];
          if (op) {
            this.#enqueue(op, { kind: "loop_tripped", seq: sys.seq, msg_id: sys.msg_id, thread_root: null, hop: 0, author_id: "hub", wake: false, created_at: p.now }, `loop:${sys.seq}:${op}`);
          }
        }
        loop = trip;
      }
    }

    // Spec 6.3: mentions and replies in subscribed threads; never the author; agents only where they may be woken.
    const targets = new Map<string, { kind: "human" | "agent"; why: WakeKind }>();
    if (root) {
      for (const s of this.#q<{ identity_id: string; kind: string }>("SELECT identity_id, kind FROM thread_sub WHERE thread_root = ?", root)) {
        targets.set(s.identity_id, { kind: s.kind === "agent" ? "agent" : "human", why: "reply" });
      }
    }
    for (const m of p.mentions) targets.set(m.identity_id, { kind: m.kind, why: "mention" });
    targets.delete(me.id);
    const woke: string[] = [];
    const suppressed: Suppressed[] = [];
    for (const [id, t] of targets) {
      let reason: Suppressed["reason"] | null = null;
      if (t.kind === "agent") {
        if (!p.audience.agent_members.includes(id)) reason = "not_member";
        else if (!p.audience.agents_enabled || p.audience.muted_agents.includes(id) || p.policy === "muted") reason = "muted";
        else if (!wakesAllowed(hop)) reason = "hop_limit";
        else if (me.kind === "agent" && this.#blocked(me.id, id, p.now)) reason = "pair_block";
      }
      if (reason) {
        suppressed.push({ identity_id: id, reason });
        continue;
      }
      this.#enqueue(id, { kind: t.why, seq, msg_id, thread_root: root, hop, author_id: me.id, wake: t.kind === "agent", created_at: p.now }, `${seq}:${id}`);
      woke.push(id);
    }

    const result: PostOk = { refused: null, seq, msg_id, rev: 1, hop, head: this.#head(), woke, suppressed, loop_tripped: loop, replayed: false };
    if (p.response) {
      this.#run("INSERT INTO meta (key, value) VALUES (?, ?)", this.#responseKey(me.id, p.response), JSON.stringify({ intent: p.response, result }));
    } else {
      this.#remember(me.id, "post", p.idempotency_key, result, p.now, p.intent_fingerprint);
    }
    return result;
  }

  async version(input: VersionInput): Promise<PostOutcome> {
    this.#bind(input.tenant_id, input.conversation_id);
    const outcome = this.ctx.storage.transactionSync(() => this.#version(input));
    await this.#drain();
    return outcome;
  }

  /** Spec 4.4: a new artifact with rev + 1. Edits by the author only; retraction also by an agent's operator or an admin. */
  #version(v: VersionInput): PostOutcome {
    const me = v.actor;
    const op: Op = v.body === null ? "retract" : "edit";
    const prior = this.#replay(me.id, op, v.idempotency_key, v.now);
    if (prior) return prior;
    const m = this.#msg(v.msg);
    if (!m) return { refused: "not_found" };
    if (m.kind === "system") return { refused: "forbidden", detail: "system messages have no versions" };
    const retract = v.body === null;
    const own = m.author_id === me.id;
    const mayRetractAgent = retract && m.author_kind === "agent" && (v.operator_of.includes(m.author_id) || v.is_admin);
    if (!own && !mayRetractAgent) {
      return { refused: "forbidden", detail: retract ? "only the author, the agent's operator, or an admin may retract this" : "only the author may edit" };
    }
    if (m.retracted === 1) return { refused: "conflict", detail: "message is retracted" };
    // The cap bounds edits only: a message at the cap can still be retracted (B-I2).
    if (!retract && m.rev >= LIMITS.VERSIONS_MAX) return { refused: "edit_cap" };
    if (!retract && v.after !== null) {
      const stale = this.#staleCheck(me.id, v.after, m.thread_root);
      if (stale) return stale;
    }
    const rev = m.rev + 1;
    const response_to = (JSON.parse(m.meta_json) as Meta).response_to;
    const seq = this.#append({
      msg_id: m.msg_id, rev, kind: "say", author_id: me.id, session_id: me.session_id, session_kind: me.session_kind, thread_root: m.thread_root,
      body: retract ? "" : v.body!, body_sha256: retract ? "" : v.body_sha256,
      meta: {
        ...(retract ? { retracted: true } : { mentions: v.mentions.map((x) => x.identity_id), hop_limited: !wakesAllowed(m.hop) }),
        // Text revisions (including operator retractions) cannot rebind the original committed reply.
        ...(response_to ? { response_to } : {}),
      },
      hop: m.hop, cause_seq: m.last_seq, now: v.now,
    });
    if (!retract) this.#storeRefs(seq, m.msg_id, rev, v.refs);
    this.#run("UPDATE msg SET last_seq = ?, rev = ?, retracted = ?, updated_at = ? WHERE msg_id = ?", seq, rev, retract ? 1 : 0, v.now, m.msg_id);
    const result: PostOk = { refused: null, seq, msg_id: m.msg_id, rev, hop: m.hop, head: this.#head(), woke: [], suppressed: [], loop_tripped: null, replayed: false };
    this.#remember(me.id, op, v.idempotency_key, result, v.now);
    return result;
  }

  async read(q: ReadQuery): Promise<ReadPage> {
    this.#bind(q.tenant_id, q.conversation_id);
    const head = this.#head();
    let root: MsgRow | null = null;
    if (q.thread !== null) {
      root = this.#msg(q.thread);
      if (root && root.thread_root) root = this.#msg(root.thread_root);
      if (!root) return { head, found: false, root: null, messages: [], has_more: false, cursors: {} };
    }
    const cond = [root ? "m.thread_root = ?" : "m.thread_root IS NULL"];
    const args: SqlStorageValue[] = root ? [root.msg_id] : [];
    // A top-level message changed when it was edited or got a reply.
    const touched = root ? "m.last_seq" : "MAX(m.last_seq, COALESCE(m.last_reply_seq, 0))";
    let order = "DESC";
    if (q.after !== null) {
      cond.push(`${touched} > ?`);
      args.push(q.after);
      order = "ASC";
    }
    if (q.before !== null) {
      cond.push("m.first_seq < ?");
      args.push(q.before);
    }
    // After a cursor the page is ordered and limited by the very expression it was filtered on, so the last message's
    // `touched` is a cursor that neither skips nor repeats anything. Otherwise it is the message number.
    const sortBy = q.after !== null ? "touched" : "m.first_seq";
    const rows = this.#q<MsgRow & { touched: number }>(
      `${MSG_SELECT.replace("SELECT m.*,", `SELECT m.*, ${touched} AS touched,`)} WHERE ${cond.join(" AND ")} ORDER BY ${sortBy} ${order}, m.first_seq ${order} LIMIT ?`,
      ...args, q.limit + 1,
    );
    const has_more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    if (order === "DESC") page.reverse();
    const cursors: Record<number, number> = {};
    if (q.after !== null) for (const r of page) cursors[r.first_seq] = r.touched;
    return { head, found: true, root: root ? this.#view(root) : null, messages: page.map((r) => this.#view(r)), has_more, cursors };
  }

  async getMessage(tenant_id: string, conversation_id: string, ref: string): Promise<MsgView | null> {
    this.#bind(tenant_id, conversation_id);
    const m = this.#msg(ref);
    return m ? this.#view(m) : null;
  }

  async history(tenant_id: string, conversation_id: string, ref: string): Promise<{ msg: MsgView; versions: Version[] } | null> {
    this.#bind(tenant_id, conversation_id);
    const m = this.#msg(ref);
    if (!m) return null;
    const versions = this.#q<{ seq: number; rev: number; body: string; meta_json: string; author_id: string; session_id: string | null; session_kind: string; created_at: number }>(
      "SELECT seq, rev, body, meta_json, author_id, session_id, session_kind, created_at FROM artifact WHERE msg_id = ? ORDER BY rev", m.msg_id,
    ).map((a) => ({
      seq: a.seq, rev: a.rev, body: a.body, retracted: (JSON.parse(a.meta_json) as Meta).retracted === true, author_id: a.author_id,
      session_id: a.session_id, session_kind: a.session_kind as ChatSessionKind, created_at: a.created_at,
    }));
    return { msg: this.#view(m), versions };
  }

  /** Extractive material for catch-up (spec 7.4 tiers 2, 4, 5, 6), for one reader since one cursor. */
  async digest(q: DigestQuery): Promise<Digest> {
    this.#bind(q.tenant_id, q.conversation_id);
    const since = q.since;
    const counts = this.#q<{ n: number; agents: number }>(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN author_kind = 'agent' THEN 1 ELSE 0 END), 0) AS agents FROM msg WHERE kind = 'say' AND retracted = 0 AND first_seq > ?", since,
    )[0]!;
    // Match only the mentions array, not other metadata such as response source author ids.
    // Mentions are current-revision evidence: an edit after the cursor may add or revise a mention
    // on an older message. Use activity order, not creation order; removed mentions and retractions
    // are not current requests. The new-message counts above still count only newly created text.
    // One row past the cap says the list was cut, so the caller does not move its cursor over what it never saw.
    const mentionRows = this.#q<MsgRow>(
      `${MSG_SELECT} WHERE m.kind = 'say' AND m.last_seq > ? AND m.author_id <> ? AND m.retracted = 0
       AND EXISTS (SELECT 1 FROM json_each(a.meta_json, '$.mentions') WHERE value = ?) ORDER BY m.last_seq LIMIT ?`,
      since, q.me, q.me, q.max_items + 1,
    );
    const mentions_truncated = mentionRows.length > q.max_items;
    const mentions_me = mentionRows.slice(0, q.max_items).map((r) => this.#view(r));
    // Followed threads also carry revised replies behind the creation cursor, even without a mention.
    // Count newly created and older edited replies separately; choose current text by activity, not message number.
    const threadRows = this.#q<{ thread_root: string; n: number; edited: number; newest: number }>(
      `SELECT thread_root, SUM(CASE WHEN first_seq > ? THEN 1 ELSE 0 END) AS n,
         SUM(CASE WHEN first_seq <= ? THEN 1 ELSE 0 END) AS edited, MAX(last_seq) AS newest
         FROM msg WHERE kind = 'say' AND retracted = 0 AND last_seq > ? AND author_id <> ?
         AND thread_root IN (SELECT thread_root FROM thread_sub WHERE identity_id = ?) GROUP BY thread_root ORDER BY newest LIMIT ?`,
      since, since, since, q.me, q.me, q.max_items + 1,
    );
    const my_threads_truncated = threadRows.length > q.max_items;
    const my_threads = threadRows.slice(0, q.max_items).map((t) => ({
      root: this.#view(this.#msg(t.thread_root)!), replies: t.n, edited_replies: t.edited, latest_activity_seq: t.newest,
      newest: this.#view(this.#q<MsgRow>(`${MSG_SELECT} WHERE m.last_seq = ?`, t.newest)[0]!),
    }));
    const threads = this.#q<{ thread_root: string; n: number }>(
      "SELECT thread_root, COUNT(*) AS n FROM msg WHERE kind = 'say' AND retracted = 0 AND first_seq > ? AND thread_root IS NOT NULL GROUP BY thread_root ORDER BY n DESC, thread_root LIMIT 5", since,
    ).map((t) => ({ root: this.#view(this.#msg(t.thread_root)!), replies: t.n }));
    const authors = this.#q<{ author_id: string }>("SELECT author_id FROM msg WHERE kind = 'say' AND first_seq > ? GROUP BY author_id ORDER BY MIN(first_seq)", since)
      .map((r) => r.author_id);
    const refs = this.#q<{ kind: string; key: string; title: string | null }>(
      "SELECT kind, key, MAX(title_snapshot) AS title FROM ref WHERE seq > ? GROUP BY kind, key ORDER BY MIN(seq) LIMIT 20", since,
    ).map((r) => ({ kind: r.kind as StoredRef["kind"], key: r.key, title: r.title }));
    return { head: this.#head(), since, new_messages: counts.n, agent_messages: counts.agents, mentions_me, mentions_truncated, my_threads, my_threads_truncated, threads, authors, refs };
  }

  async alarm(): Promise<void> {
    const b = storedBinding(this.ctx.storage.sql);
    if (!b) return;
    this.#tenant = b.tenant_id;
    this.#id = b.owner_id;
    await this.#drain();
  }

  #backoff(attempts: number): number {
    return Math.min(LIMITS.OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), LIMITS.OUTBOX_BACKOFF_MAX_MS);
  }

  /**
   * One row failed: retry later with a capped exponential backoff. Only a wake (or an unreadable row) is given up on after
   * OUTBOX_MAX_ATTEMPTS (ruling C-9); an index row and a human's notification retry at the capped backoff for as long as it takes.
   */
  #fail(table: OutboxTable, col: "key" | "seq", id: string | number, attempts: number, now: number, droppable = true): void {
    const n = attempts + 1;
    if (table === "inbox_outbox" && droppable && n >= LIMITS.OUTBOX_MAX_ATTEMPTS) {
      console.log(`${table} row dropped after ${n} attempts`);
      this.#run(`DELETE FROM ${table} WHERE ${col} = ?`, id);
      return;
    }
    this.#run(`UPDATE ${table} SET attempts = ?, next_at = ? WHERE ${col} = ?`, n, now + this.#backoff(n), id);
  }

  /** Drains run one after another (spec 9.2, 9.3): a second caller waits for the first instead of racing it. */
  #drain(): Promise<void> {
    const run = this.#draining.then(() => this.#drainOnce());
    this.#draining = run.catch(() => undefined);
    return run;
  }

  /**
   * Spec 6.7: the Worker checked D1 when the message was posted; a wake is checked again when it is delivered, so a
   * mute, the kill switch, or a muted channel that arrived since drops the wake. Notifications to humans are unaffected.
   */
  async #wakeGate(now: number): Promise<(identity_id: string) => boolean> {
    const [controls, ch] = await Promise.all([
      getControls(this.env.HUB_DB, this.#tenant, now),
      this.env.HUB_DB.prepare("SELECT agent_policy FROM channel WHERE project_id = ? AND tenant_id = ?").bind(this.#id, this.#tenant).first<{ agent_policy: string }>(),
    ]);
    if (!controls.agents_enabled || ch?.agent_policy === "muted") return () => false;
    const muted = new Set(controls.muted);
    return (id) => !muted.has(id);
  }

  /** Deliver queued inbox items and index rows now; anything that fails stays queued, with backoff, for the alarm. */
  async #drainOnce(): Promise<void> {
    const now = Date.now();
    const rows = this.#q<{ key: string; identity_id: string; item_json: string; attempts: number }>(
      "SELECT key, identity_id, item_json, attempts FROM inbox_outbox WHERE next_at <= ? ORDER BY rowid LIMIT 200", now,
    );
    const parsed: Array<{ key: string; identity_id: string; item: WakeItem; attempts: number }> = [];
    for (const r of rows) {
      try {
        parsed.push({ key: r.key, identity_id: r.identity_id, item: JSON.parse(r.item_json) as WakeItem, attempts: r.attempts });
      } catch {
        this.#fail("inbox_outbox", "key", r.key, r.attempts, now);
      }
    }
    let allows: ((identity_id: string) => boolean) | null = null;
    if (parsed.some((p) => p.item.wake)) {
      try {
        allows = await this.#wakeGate(now);
      } catch (e) {
        console.log("wake gate failed", e instanceof Error ? e.name : "error");
      }
    }
    const byIdentity = new Map<string, typeof parsed>();
    for (const p of parsed) {
      if (p.item.wake) {
        if (!allows) {
          this.#fail("inbox_outbox", "key", p.key, p.attempts, now);
          continue;
        }
        if (!allows(p.identity_id)) {
          this.#run("DELETE FROM inbox_outbox WHERE key = ?", p.key);
          continue;
        }
      }
      const list = byIdentity.get(p.identity_id) ?? [];
      list.push(p);
      byIdentity.set(p.identity_id, list);
    }
    for (const [identity, list] of byIdentity) {
      const send = (xs: typeof list) => inboxStub(this.env, this.#tenant, identity).deliver(this.#tenant, identity, xs.map((x) => x.item));
      try {
        await send(list);
        for (const x of list) this.#run("DELETE FROM inbox_outbox WHERE key = ?", x.key);
      } catch (e) {
        console.log("inbox delivery failed", e instanceof Error ? e.name : "error");
        // One bad row must not hold back the others: retry each on its own.
        for (const x of list) {
          try {
            await send([x]);
            this.#run("DELETE FROM inbox_outbox WHERE key = ?", x.key);
          } catch {
            this.#fail("inbox_outbox", "key", x.key, x.attempts, now, x.item.wake);
          }
        }
      }
    }
    await this.#flushIndex(now);
    const next = this.#q<{ n: number | null }>(
      "SELECT MIN(n) AS n FROM (SELECT MIN(next_at) AS n FROM inbox_outbox UNION ALL SELECT MIN(next_at) FROM index_outbox)",
    )[0]?.n ?? null;
    if (next !== null) {
      // Pull the alarm earlier when a sooner retry is due; never push one that is already set earlier.
      const due = Math.max(next, Date.now() + 1_000);
      const set = await this.ctx.storage.getAlarm();
      if (set === null || set > due) await this.ctx.storage.setAlarm(due);
    }
  }

  /** The D1 statements for one artifact: its index row, and for a new version, replace the message's refs. */
  #indexStatements(seq: number): D1PreparedStatement[] {
    const a = this.#q<ArtifactRow>("SELECT seq, msg_id, rev, kind, author_id, session_id, session_kind, thread_root, body, meta_json, hop, created_at FROM artifact WHERE seq = ?", seq)[0];
    if (!a) return [];
    const db = this.env.HUB_DB;
    const stmts: D1PreparedStatement[] = [];
    const retracted = (JSON.parse(a.meta_json) as Meta).retracted === true;
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO msg_index (tenant_id, conversation_id, msg_id, seq, rev, kind, author_id, session_id, thread_root, hop, title, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(this.#tenant, this.#id, a.msg_id, a.seq, a.rev, a.kind, a.author_id, a.session_id, a.thread_root, a.hop, retracted ? "retracted" : "live", a.created_at));
    if (a.rev > 1) stmts.push(db.prepare("DELETE FROM msg_ref WHERE conversation_id = ? AND msg_id = ? AND rev < ?").bind(this.#id, a.msg_id, a.rev));
    for (const r of this.#q<{ kind: string; key: string }>("SELECT kind, key FROM ref WHERE seq = ?", seq)) {
      // Skipped when a newer version is already indexed: an old flush arriving late must not bring back refs the newer one replaced (B-I3).
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO msg_ref (tenant_id, target_kind, target_key, conversation_id, msg_id, rev, seq, msg_kind, author_id, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
          WHERE NOT EXISTS (SELECT 1 FROM msg_index WHERE conversation_id = ?4 AND msg_id = ?5 AND rev > ?6)`,
      ).bind(this.#tenant, r.kind, r.key, this.#id, a.msg_id, a.rev, a.seq, a.kind, a.author_id, a.created_at));
    }
    return stmts;
  }

  /** Idempotent upserts keyed by (conversation_id, seq); a new version replaces the message's refs in msg_ref. */
  async #flushIndex(now: number): Promise<void> {
    const rows = this.#q<{ seq: number; attempts: number }>("SELECT seq, attempts FROM index_outbox WHERE next_at <= ? ORDER BY seq LIMIT 50", now);
    if (rows.length === 0) return;
    const db = this.env.HUB_DB;
    try {
      const stmts = rows.flatMap((r) => this.#indexStatements(r.seq));
      if (stmts.length > 0) await db.batch(stmts);
      for (const r of rows) this.#run("DELETE FROM index_outbox WHERE seq = ?", r.seq);
    } catch (e) {
      console.log("index flush failed", e instanceof Error ? e.name : "error");
      // Isolate the failure: each seq on its own, so one bad row does not stall the rest.
      for (const r of rows) {
        try {
          const stmts = this.#indexStatements(r.seq);
          if (stmts.length > 0) await db.batch(stmts);
          this.#run("DELETE FROM index_outbox WHERE seq = ?", r.seq);
        } catch {
          this.#fail("index_outbox", "seq", r.seq, r.attempts, now);
        }
      }
    }
  }
}
