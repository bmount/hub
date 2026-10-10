-- Completed imports are selected by data, never by a per-tenant deployment.
CREATE TABLE git_repository (
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  imported_at INTEGER NOT NULL
);

-- Durable attribution and private recovery tombstones for Artifacts pushes. They keep namespace/shadow/replay pointers after tenant or project deletion, but never credentials.
CREATE TABLE git_push (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  identity_id TEXT REFERENCES identity(id) ON DELETE SET NULL,
  session_id TEXT,
  namespace TEXT NOT NULL,
  repo TEXT NOT NULL,
  shadow TEXT NOT NULL,
  replay_key TEXT NOT NULL,
  updates_json TEXT NOT NULL,
  outcomes_json TEXT,
  published_json TEXT,
  commits_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('staging', 'publishing', 'complete', 'refused', 'unknown')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX git_push_pending ON git_push(state, created_at);

-- Derived commit graph only; Artifacts remains the sole Git object store.
CREATE TABLE git_commit (
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  oid TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  parents_json TEXT NOT NULL,
  generation INTEGER NOT NULL,
  commit_time INTEGER NOT NULL,
  PRIMARY KEY (project_id, oid)
);
