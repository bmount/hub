-- System-owned fixture. No membership or repository from a real organization is used.
ALTER TABLE identity ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0;
INSERT INTO tenant (id, slug, display_name, created_at, is_synthetic) VALUES ('perf-synthetic-tenant', 'perf-synthetic', 'Performance synthetic checks', 0, 1);
INSERT INTO identity (id, kind, display_name, email, created_at, is_synthetic) VALUES ('perf-synthetic-member', 'human', 'Synthetic checks', 'synthetic@perf-synthetic.invalid', 0, 1);
INSERT INTO membership (id, identity_id, tenant_id, role, handle, handle_skeleton, created_at) VALUES ('perf-synthetic-membership', 'perf-synthetic-member', 'perf-synthetic-tenant', 'member', 'synthetic', 'synthetic', 0);
INSERT INTO project (id, tenant_id, slug, kind, display_name, created_at) VALUES ('perf-synthetic-workspace', 'perf-synthetic-tenant', 'perf-synthetic', 'workspace', 'Performance fixture', 0);
INSERT INTO project (id, tenant_id, slug, kind, display_name, created_at) VALUES ('perf-synthetic-repo', 'perf-synthetic-tenant', 'fixture', 'repo', 'Synthetic Git fixture', 0);
INSERT INTO project (id, tenant_id, slug, kind, display_name, created_at) VALUES ('perf-synthetic-channel', 'perf-synthetic-tenant', 'synthetic', 'channel', 'Synthetic checks', 0);
INSERT INTO channel (project_id, tenant_id, created_by, created_at) VALUES ('perf-synthetic-channel', 'perf-synthetic-tenant', 'perf-synthetic-member', 0);
INSERT INTO conversation_member (conversation_id, tenant_id, identity_id, role, added_by, added_at) VALUES ('perf-synthetic-channel', 'perf-synthetic-tenant', 'perf-synthetic-member', 'member', 'perf-synthetic-member', 0);
INSERT INTO work_item (id, tenant_id, project_id, number, kind, title, body, state, created_by, created_at, updated_at) VALUES ('perf-synthetic-item', 'perf-synthetic-tenant', 'perf-synthetic-workspace', 1, 'errand', 'Synthetic fixture', 'Permanent synthetic journey fixture.', 'open', 'perf-synthetic-member', 0, 0);
CREATE TABLE synthetic_run (
  journey TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  duration REAL NOT NULL,
  failed INTEGER NOT NULL,
  version TEXT NOT NULL,
  colo TEXT NOT NULL
);
