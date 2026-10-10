/** Shapes shared by the Worker and the chat Durable Objects (messaging spec 4, 6, 9). */
export type AuthorKind = "human" | "agent" | "hub";
export type ChatSessionKind = "browser" | "agent_run" | "oauth" | "hub";
export type RefKind = "commit" | "ticket" | "session" | "msg";
export type AgentPolicy = "open" | "mention_only" | "muted";

/** A resolved reference stored with one message version (spec 5.2). `title` is null when unverified. */
export type StoredRef = { kind: RefKind; key: string; title: string | null };
/** A reference as one viewer may see it: re-checked at render (spec 5.2). */
export type ViewRef = StoredRef & { no_access: boolean };

export type Author = { id: string; kind: "human" | "agent"; session_id: string; session_kind: ChatSessionKind };
export type Mention = { identity_id: string; kind: "human" | "agent" };

/** What the Worker read from D1 for this command; the Conversation trusts it (spec 9.3: D1 is the truth). */
export type Audience = { agent_members: string[]; operators: Record<string, string>; muted_agents: string[]; agents_enabled: boolean };

/** Exact source evidence, not a grant of execution authority. */
export type ResponseSource = { msg_id: string; rev: number; author_id: string };
export type ResponseStage = "progress" | "result";
export type ResponseTarget = ResponseSource & { stage?: ResponseStage };
/** Public message attribution, not the caller-private ledger or a task execution status. */
export type ResponseAttribution = ResponseSource & { seq: number; stage: ResponseStage };
export type ResponseIntent = { source: ResponseSource; fingerprint: string; stage?: ResponseStage };
/** A recorded chat post, not a task/execution status. No body, fingerprint, wake recipients or other callers' records. */
export type ResponseSlot = {
  source: ResponseSource;
  committed: { msg_id: string; seq: number; rev: number };
  current: { rev: number; retracted: boolean } | null;
};
export type ResponseStatus = {
  head: number;
  source: ResponseSource & { seq: number; retracted: boolean };
  progress: ResponseSlot | null;
  result: ResponseSlot | null;
  /** Optional equality with original persisted posting intent, not current evidence or permission to send. Null means no slot. */
  intent_check?: { stage: ResponseStage; matches: boolean | null };
};

/** Caller-only bounded-window posting evidence, not current-text validation or execution status. */
export type PostStatus = {
  head: number; observed_at: number;
  record: {
    committed: { msg_id: string; seq: number; rev: number };
    current: { rev: number; retracted: boolean } | null;
    expires_at: number; intent_bound: boolean;
  } | null;
  /** Original intent comparison only. Missing/legacy unbound records cannot verify a payload. */
  intent_check?: { matches: boolean | null; reason: "match" | "mismatch" | "missing" | "unbound" };
};

/** Caller-only edit/retraction original commitment/intent evidence, not current-text validation or write permission. */
export type VersionStatus = PostStatus & { operation: "edit" | "retract" };

export type PostInput = {
  tenant_id: string; conversation_id: string; now: number; author: Author; policy: AgentPolicy;
  body: string; body_sha256: string; after: number | null; reply_to: string | null;
  refs: StoredRef[]; mentions: Mention[];
  /** One durable response per authenticated caller/source/stage, atomically committed with the message. */
  response?: ResponseIntent;
  /** Internal Worker-computed ordinary intent digest before ref resolution, never parsed from public input. */
  intent_fingerprint?: string;
  /** Hop of the author's newest open top-level wake here, and of the newest open wake per thread (ruling C-4), from the author's Inbox. */
  wake_hop: number | null; thread_wake_hops: Record<string, number>;
  idempotency_key: string | null; audience: Audience;
};

export type VersionInput = {
  tenant_id: string; conversation_id: string; now: number; actor: Author; msg: string;
  /** null retracts. */
  body: string | null; body_sha256: string; after: number | null; refs: StoredRef[]; mentions: Mention[];
  /** Internal Worker-computed parsed message/body digest before ref resolution; never public input. */
  intent_fingerprint?: string;
  /** Agents this actor operates (may retract their messages). */
  operator_of: string[]; is_admin: boolean; idempotency_key: string | null;
};

export type MsgView = {
  seq: number; msg_id: string; rev: number; kind: "say" | "system"; thread_root: string | null; root_seq: number | null;
  author_id: string; author_kind: AuthorKind; session_id: string | null; session_kind: ChatSessionKind; hop: number;
  body: string; edited: boolean; retracted: boolean; reply_count: number; last_reply_seq: number | null;
  refs: StoredRef[]; mentions: string[]; hop_limited: boolean; created_at: number; updated_at: number;
  /** Server-recorded original response binding; absent on older/untracked messages. */
  response_to?: ResponseAttribution | null;
};

export type Version = {
  seq: number; rev: number; body: string; retracted: boolean; author_id: string; session_id: string | null;
  session_kind: ChatSessionKind; created_at: number;
};

export type WakeKind = "mention" | "reply" | "loop_tripped" | "tripwire" | "mail";
export type WakeItem = {
  key: string; kind: WakeKind; conversation_id: string; seq: number; msg_id: string; thread_root: string | null;
  hop: number; author_id: string; wake: boolean; created_at: number;
};
export type InboxItem = WakeItem & { item_seq: number; acked_at: number | null };
/** Bounded open-item scan, before viewer filtering. `next_after` is not an acknowledgement or processing proof. */
export type InboxPage = { head: number; items: InboxItem[]; next_after: number; has_more: boolean };

export type Suppressed = { identity_id: string; reason: "hop_limit" | "pair_block" | "not_member" | "muted" };
export type PostOk = {
  refused: null; seq: number; msg_id: string; rev: number; hop: number; head: number; woke: string[]; suppressed: Suppressed[];
  loop_tripped: { a: string; b: string } | null; replayed: boolean;
};
export type Refusal =
  | { refused: "stale_view"; head: number; missed: MsgView[] }
  | { refused: "duplicate" }
  | { refused: "rate"; retry_after_s: number }
  | { refused: "needs_human" }
  | { refused: "not_found" }
  | { refused: "forbidden"; detail: string }
  | { refused: "edit_cap" }
  | { refused: "conflict"; detail: string };
export type PostOutcome = PostOk | Refusal;

export type ReadQuery = { tenant_id: string; conversation_id: string; after: number | null; before: number | null; thread: string | null; limit: number };
/** `cursors` (reads after a cursor only): for each message number, the position the read ordered and filtered it by; pass the last one shown as the next `after`. */
export type ReadPage = { head: number; found: boolean; root: MsgView | null; messages: MsgView[]; has_more: boolean; cursors: Record<number, number> };

export type DigestQuery = { tenant_id: string; conversation_id: string; since: number; me: string; max_items: number };
export type Digest = {
  head: number; since: number; new_messages: number; agent_messages: number; mentions_me: MsgView[];
  /** The lists were cut at the cap (one more row existed). */
  mentions_truncated: boolean; my_threads_truncated: boolean;
  /** Disjoint reply counts exclude roots; root flags describe incoming current changes after since. */
  my_threads: Array<{ root: MsgView; replies: number; edited_replies: number; retracted_replies: number; root_edited: boolean; root_retracted: boolean; latest_activity_seq: number; newest: MsgView }>; threads: Array<{ root: MsgView; replies: number }>;
  authors: string[]; refs: StoredRef[];
};
