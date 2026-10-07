-- Super-admin deletion of organizations (admin spec 8.1). A tombstone stays after the rows are gone: who deleted
-- what, when, and how much. The name stays reserved until the git host has purged its own copy of the data,
-- because Ardi keys repositories by the organization's name and would otherwise hand old repos to a new owner.
CREATE TABLE deleted_tenant (
  id TEXT PRIMARY KEY,               -- the deleted tenant's id
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  deleted_by TEXT REFERENCES identity(id),
  deleted_at INTEGER NOT NULL,
  counts TEXT NOT NULL,              -- JSON: rows removed per table
  git_purged_at INTEGER              -- NULL until Ardi confirms its data for this name is gone
);
CREATE INDEX deleted_tenant_slug ON deleted_tenant (slug);
