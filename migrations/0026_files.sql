CREATE TABLE file_revision (
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  uploader_id TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  item_id TEXT REFERENCES work_item(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES identity(id) ON DELETE SET NULL,
  text TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  PRIMARY KEY(tenant_id, project_id, path, revision),
  UNIQUE(tenant_id, project_id, source)
);
CREATE TABLE file_upload (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  params TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
