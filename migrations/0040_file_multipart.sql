CREATE TABLE file_multipart (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  params TEXT NOT NULL,
  object_key TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  result TEXT
);
CREATE INDEX file_multipart_expiry ON file_multipart(expires_at);
CREATE TABLE file_multipart_gc (
  object_key TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL
);
CREATE TRIGGER file_multipart_gc_enqueue BEFORE DELETE ON file_multipart BEGIN
  INSERT OR IGNORE INTO file_multipart_gc (object_key, upload_id) VALUES (OLD.object_key, OLD.upload_id);
END;
CREATE TABLE file_multipart_part (
  token_hash TEXT NOT NULL REFERENCES file_multipart(token_hash) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  etag TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(token_hash, part)
);
