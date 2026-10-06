CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE namespace (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  namespace_id TEXT REFERENCES namespace(id),
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX project_top_slug ON project (tenant_id, slug) WHERE namespace_id IS NULL;
CREATE UNIQUE INDEX project_ns_slug ON project (tenant_id, namespace_id, slug) WHERE namespace_id IS NOT NULL;
CREATE INDEX project_tenant_state ON project (tenant_id, state);

CREATE TABLE identity (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL UNIQUE,
  operator_id TEXT REFERENCES identity(id),
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE membership (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  UNIQUE (identity_id, tenant_id)
);
CREATE INDEX membership_tenant ON membership (tenant_id);

CREATE TABLE invite (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenant(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_session_id TEXT,
  revoked_at INTEGER
);
CREATE INDEX invite_tenant ON invite (tenant_id, created_at);

CREATE TABLE consent (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenant(id),
  kind TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  source_message_id TEXT,
  evidence TEXT
);
CREATE INDEX consent_email ON consent (email);

CREATE TABLE auth_link (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT REFERENCES tenant(id),
  kind TEXT NOT NULL,
  label TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_proof_at INTEGER NOT NULL,
  revoked_at INTEGER,
  parent_token_id TEXT
);
CREATE INDEX session_identity ON session (identity_id, created_at);

CREATE TABLE api_token (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE proof (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE event (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenant(id),
  identity_id TEXT REFERENCES identity(id),
  session_id TEXT REFERENCES session(id),
  kind TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX event_tenant_time ON event (tenant_id, created_at);
