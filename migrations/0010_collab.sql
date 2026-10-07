-- Collaboration on work (2026-10-07): comments, following, and one list of what needs each person.

-- Comments on a work item. @handles in the body put the item in the mentioned person's attention list.
CREATE TABLE work_comment (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  author_id TEXT NOT NULL REFERENCES identity(id),
  session_id TEXT,                              -- the sign-in or run it came from; no FK, sessions are pruned
  body TEXT NOT NULL,
  reply_to TEXT REFERENCES work_comment(id),
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX work_comment_item ON work_comment (item_id, created_at);

-- Who follows what: an item, or a whole project. Filing, owning and commenting follow an item automatically.
CREATE TABLE follow (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('item', 'project')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, target_kind, target_id)
);
CREATE INDEX follow_target ON follow (target_kind, target_id);

-- What needs a person: mentions, comments and changes on what they follow, work assigned to them. Done when seen.
CREATE TABLE attention (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  reason TEXT NOT NULL CHECK (reason IN ('mention', 'comment', 'assigned', 'changed', 'filed')),
  item_id TEXT REFERENCES work_item(id),
  actor_id TEXT REFERENCES identity(id),
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX attention_open ON attention (identity_id, tenant_id, done_at, created_at);
CREATE INDEX attention_item ON attention (item_id);
