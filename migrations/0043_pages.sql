CREATE TABLE page_revision (
 tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, slug TEXT NOT NULL,
 revision INTEGER NOT NULL, title TEXT NOT NULL, entry TEXT NOT NULL,
 object_key TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL,
 author_id TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, project_id, slug, revision)
);
CREATE INDEX page_object ON page_revision(object_key);
CREATE TABLE page_upload (
 token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
 identity_id TEXT NOT NULL, expires_at INTEGER NOT NULL, params TEXT NOT NULL
);
