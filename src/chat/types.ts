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

export type PostInput = {
  tenant_id: string; conversation_id: string; now: number; author: Author; policy: "open" | "mention_only";
  body: string; body_sha256: string; after: number | null; reply_to: string | null;
  refs: StoredRef[]; mentions: Mention[]; wake_hop: number | null; idempotency_key: string | null; audience: Audience;
};

export type VersionInput = {
  tenant_id: string; conversation_id: string; now: number; actor: Author; msg: string;
  /** null retracts. */
  body: string | null; body_sha256: string; after: number | null; refs: StoredRef[]; mentions: Mention[];
  /** Agents this actor operates (may retract their messages). */
  operator_of: string[]; is_admin: boolean; idempotency_key: string | null;
};

export type MsgView = {
  seq: number; msg_id: string; rev: number; kind: "say" | "system"; thread_root: string | null; root_seq: number | null;
  author_id: string; author_kind: AuthorKind; session_id: string | null; session_kind: ChatSessionKind; hop: number;
  body: string; edited: boolean; retracted: boolean; reply_count: number; last_reply_seq: number | null;
  refs: StoredRef[]; mentions: string[]; hop_limited: boolean; created_at: number; updated_at: number;
};

export type Version = {
  seq: number; rev: number; body: string; retracted: boolean; author_id: string; session_id: string | null;
  session_kind: ChatSessionKind; created_at: number;
};

export type WakeKind = "mention" | "reply" | "loop_tripped" | "tripwire";
export type WakeItem = {
  key: string; kind: WakeKind; conversation_id: string; seq: number; msg_id: string; thread_root: string | null;
  hop: number; author_id: string; wake: boolean; created_at: number;
};
export type InboxItem = WakeItem & { item_seq: number; acked_at: number | null };

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
export type ReadPage = { head: number; found: boolean; root: MsgView | null; messages: MsgView[]; has_more: boolean };

export type DigestQuery = { tenant_id: string; conversation_id: string; since: number; me: string; max_items: number };
export type Digest = {
  head: number; since: number; new_messages: number; agent_messages: number; mentions_me: MsgView[];
  my_threads: Array<{ root: MsgView; replies: number; newest: MsgView }>; threads: Array<{ root: MsgView; replies: number }>;
  authors: string[]; refs: StoredRef[];
};
