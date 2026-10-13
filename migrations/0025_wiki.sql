CREATE TABLE wiki_revision (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  slug TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  links TEXT NOT NULL,
  note TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES identity(id),
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, project_id, slug, revision)
);
CREATE INDEX wiki_current ON wiki_revision(tenant_id, project_id, slug, revision DESC);
