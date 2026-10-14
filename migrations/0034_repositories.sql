-- A storage name is independent of the public URL. Existing Artifacts names stay put.
CREATE TABLE repository (
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  storage_name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, name),
  UNIQUE(tenant_id, storage_name)
);
CREATE UNIQUE INDEX repository_default ON repository(project_id) WHERE is_default = 1;
INSERT INTO repository SELECT tenant_id, project_id, 'default', (SELECT slug FROM project WHERE id = project_id), 1, imported_at FROM git_repository;
CREATE TRIGGER repository_import AFTER INSERT ON git_repository BEGIN
  INSERT OR IGNORE INTO repository SELECT NEW.tenant_id, NEW.project_id, 'default', slug, 1, NEW.imported_at FROM project WHERE id = NEW.project_id;
END;
CREATE TABLE repository_commit (
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  repo TEXT NOT NULL DEFAULT '',
  oid TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  parents_json TEXT NOT NULL,
  generation INTEGER NOT NULL,
  commit_time INTEGER NOT NULL,
  PRIMARY KEY(project_id, repo, oid)
);
INSERT INTO repository_commit SELECT tenant_id, project_id, '', oid, tree_hash, parents_json, generation, commit_time FROM git_commit;
CREATE TRIGGER repository_commit_legacy AFTER INSERT ON git_commit BEGIN
  INSERT OR IGNORE INTO repository_commit VALUES(NEW.tenant_id, NEW.project_id, '', NEW.oid, NEW.tree_hash, NEW.parents_json, NEW.generation, NEW.commit_time);
END;
ALTER TABLE code_event ADD COLUMN repo TEXT NOT NULL DEFAULT '';
ALTER TABLE review ADD COLUMN repo TEXT NOT NULL DEFAULT '';
ALTER TABLE app_source ADD COLUMN repo TEXT NOT NULL DEFAULT '';
ALTER TABLE app_deploy ADD COLUMN repo TEXT NOT NULL DEFAULT '';
CREATE TABLE repository_sync (
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  cursor TEXT,
  last_run_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(project_id, repo)
);
