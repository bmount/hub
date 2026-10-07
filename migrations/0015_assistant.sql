-- The Assistant (owner, 2026-10-07): a chat that calls Pimwell's MCP tools for people who don't use an MCP client.
-- Conversations are the person's own, in one organization. History is read from here, never from the browser, so a
-- page can't put words in the assistant's mouth or invent tool results.
CREATE TABLE assistant_thread (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  title TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (scopes IN ('read', 'write')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX assistant_thread_owner ON assistant_thread (identity_id, tenant_id, updated_at);

CREATE TABLE assistant_message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_thread(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  steps TEXT,                                  -- JSON: the tool calls made for this answer (tool, arguments, ok, summary)
  created_at INTEGER NOT NULL
);
CREATE INDEX assistant_message_thread ON assistant_message (thread_id, created_at);
