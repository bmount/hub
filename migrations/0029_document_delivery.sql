CREATE TABLE document_delivery (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  document_kind TEXT NOT NULL CHECK (document_kind IN ('file', 'page')),
  document_ref TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  sent_by TEXT NOT NULL REFERENCES identity(id),
  mode TEXT NOT NULL CHECK (mode IN ('share', 'dispatch')),
  status TEXT NOT NULL,
  outbound_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX document_delivery_history ON document_delivery (tenant_id, project_id, document_kind, document_ref, created_at);
