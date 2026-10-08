-- Code views and push sync through Ardi (2026-10-07). Ardi keeps repositories in Durable Objects the hub cannot bind,
-- so the hub reads through Ardi's JSON API over the service binding, with an Ardi-acceptable credential.

-- Sealed (HUB_SECRETS_KEY) credentials the hub uses on someone's behalf: a person's git session for code views, or a
-- sync agent's long-lived token. Never shown, never logged.
CREATE TABLE ardi_cred (
  identity_id TEXT NOT NULL REFERENCES identity(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  kind TEXT NOT NULL CHECK (kind IN ('git_session', 'api_token')),
  ref_id TEXT NOT NULL,                       -- the session or api_token id, so it can be revoked
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, tenant_id)
);

-- How far push sync has read each repository's Ardi timeline.
CREATE TABLE code_sync (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id) PRIMARY KEY,
  cursor TEXT,
  last_run_at INTEGER,
  last_error TEXT
);

-- What happened in each repository, mirrored from Ardi's timeline: commits and ref moves, with who pushed them.
CREATE TABLE code_event (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  ardi_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  identity_id TEXT,                           -- the hub identity Ardi recorded as the pusher, when it is one of ours
  session_id TEXT,
  ref TEXT,
  target TEXT,
  summary TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (project_id, ardi_id)
);
CREATE INDEX code_event_recent ON code_event (tenant_id, at);
