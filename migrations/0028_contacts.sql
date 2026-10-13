-- Workspace contacts are content, not identities or organization memberships.
CREATE TABLE contact_entity (
 tenant_id TEXT NOT NULL REFERENCES tenant(id), project_id TEXT NOT NULL REFERENCES project(id),
 id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('person','company')), name TEXT NOT NULL,
 data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, project_id, id)
);
CREATE TABLE contact_connection (
 tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
 type TEXT NOT NULL, strength REAL, source TEXT NOT NULL, date TEXT NOT NULL,
 PRIMARY KEY (tenant_id, project_id, id), CHECK(a <> b),
 FOREIGN KEY (tenant_id, project_id, a) REFERENCES contact_entity(tenant_id, project_id, id),
 FOREIGN KEY (tenant_id, project_id, b) REFERENCES contact_entity(tenant_id, project_id, id)
);
CREATE INDEX contact_connection_a ON contact_connection(tenant_id, project_id, a);
CREATE INDEX contact_connection_b ON contact_connection(tenant_id, project_id, b);
CREATE TABLE contact_link (
 tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, entity_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('item','research','file','mail')), ref TEXT NOT NULL,
 PRIMARY KEY (tenant_id, project_id, entity_id, kind, ref),
 FOREIGN KEY (tenant_id, project_id, entity_id) REFERENCES contact_entity(tenant_id, project_id, id)
);
