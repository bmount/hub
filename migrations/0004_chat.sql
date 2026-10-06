-- Messaging phase 1 (messaging spec 4.1, 4.6, 9.3). Index tables carry no foreign keys: they are rebuildable from
-- the Conversation objects and are written by them.
ALTER TABLE membership ADD COLUMN handle TEXT;
ALTER TABLE membership ADD COLUMN handle_skeleton TEXT;
CREATE UNIQUE INDEX membership_handle ON membership (tenant_id, handle_skeleton) WHERE handle_skeleton IS NOT NULL;

CREATE TABLE channel (
  project_id TEXT PRIMARY KEY REFERENCES project(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  topic TEXT NOT NULL DEFAULT '',
  agent_policy TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX channel_tenant ON channel (tenant_id);

CREATE TABLE conversation_member (
  conversation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  role TEXT NOT NULL,
  added_by TEXT NOT NULL REFERENCES identity(id),
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (conversation_id, identity_id)
);
CREATE INDEX conversation_member_identity ON conversation_member (tenant_id, identity_id);

CREATE TABLE msg_index (
  tenant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  session_id TEXT,
  thread_root TEXT,
  hop INTEGER NOT NULL,
  title TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX msg_index_msg ON msg_index (tenant_id, msg_id, rev);

CREATE TABLE msg_ref (
  tenant_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  msg_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq, target_kind, target_key)
);
CREATE INDEX msg_ref_target ON msg_ref (tenant_id, target_kind, target_key, created_at);
CREATE INDEX msg_ref_msg ON msg_ref (conversation_id, msg_id, rev);

CREATE TABLE chat_control (
  tenant_id TEXT PRIMARY KEY REFERENCES tenant(id),
  agents_enabled INTEGER NOT NULL DEFAULT 1,
  changed_by TEXT,
  changed_at INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE agent_chat_state (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  muted_until INTEGER,
  muted_by TEXT,
  reason TEXT,
  PRIMARY KEY (tenant_id, identity_id)
);

UPDATE meta SET value = '4' WHERE key = 'schema_version';
