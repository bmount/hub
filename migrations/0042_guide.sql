CREATE TABLE guide_notice (
  id TEXT PRIMARY KEY REFERENCES attention(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  version TEXT NOT NULL,
  skills TEXT NOT NULL,
  required TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, identity_id, version)
);
CREATE INDEX guide_notice_agent ON guide_notice(tenant_id, identity_id, created_at);
CREATE TABLE guide_read (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id, identity_id, name, version)
);
