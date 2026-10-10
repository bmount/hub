-- Private migration control for cutting one repository from legacy Git to Artifacts.
-- Operators set legacy_write_fenced_at in D1, wait until tracked legacy receive-pack rows for the repository are complete, copy the legacy source, then select Artifacts by enabling the completed import.
ALTER TABLE git_repository ADD COLUMN legacy_write_fenced_at INTEGER;

CREATE TABLE git_legacy_forward (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('forwarding', 'complete', 'unknown')),
  status INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX git_legacy_forward_repo_state ON git_legacy_forward(project_id, state, created_at);
