CREATE TABLE file_download_day (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  day INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, identity_id, day)
);
CREATE TABLE file_download (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  identity_id TEXT NOT NULL REFERENCES identity(id),
  path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX file_download_project ON file_download(tenant_id, project_id, path, created_at);
CREATE TRIGGER file_download_event AFTER INSERT ON file_download BEGIN
  INSERT INTO event (id, tenant_id, identity_id, session_id, kind, target_kind, target_id, summary, created_at)
  VALUES (NEW.id, NEW.tenant_id, NEW.identity_id, NULL, 'file.download', 'project', NEW.project_id,
    NEW.operation || ' ' || NEW.path || ' revision ' || NEW.revision || ': ' || NEW.bytes || ' bytes (' || NEW.source || ')', NEW.created_at);
END;
ALTER TABLE situation ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0;
-- Non-login system owner: alert threads must not become readable after an admin loses their role.
INSERT INTO identity (id, kind, display_name, email, created_at, is_synthetic)
VALUES ('file-download-monitor', 'human', 'File download monitor', 'file-download-monitor@pimwell.invalid', 0, 1);
