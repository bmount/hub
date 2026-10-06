-- MCP phase 1: assistant grants (MCP spec 5.3) and the redirect allowlist (MCP spec 6.2).
CREATE TABLE oauth_grant (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES session(id),
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  redirect_host TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  library_grant_id TEXT UNIQUE,
  refresh_hash TEXT,
  refreshed_at INTEGER,
  approved_by_session_id TEXT NOT NULL REFERENCES session(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT
);
CREATE INDEX oauth_grant_identity ON oauth_grant (identity_id, created_at);
CREATE INDEX oauth_grant_tenant ON oauth_grant (tenant_id);

CREATE TABLE oauth_redirect_allow (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO oauth_redirect_allow (id, pattern, label, created_by, created_at) VALUES
  ('seed-claude', 'https://claude.ai/api/mcp/auth_callback', 'Claude', NULL, 0),
  ('seed-localhost', 'http://localhost/callback', 'Local app (loopback)', NULL, 0),
  ('seed-127', 'http://127.0.0.1/callback', 'Local app (loopback)', NULL, 0);

UPDATE meta SET value = '2' WHERE key = 'schema_version';
