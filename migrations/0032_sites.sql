-- A site names the running product, separately from the project containing its code.
CREATE TABLE site (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL,
  hostnames TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX site_project ON site(tenant_id, project_id);
CREATE TABLE site_app (
  site_id TEXT NOT NULL REFERENCES site(id),
  app_id TEXT NOT NULL REFERENCES app_source(id),
  PRIMARY KEY (site_id, app_id)
);
-- Seed only MCC's existing top-level code projects, never similarly named tenant projects.
INSERT INTO site (id, tenant_id, project_id, name, hostnames, created_at)
SELECT 'site:' || p.id, p.tenant_id, p.id,
  CASE p.slug WHEN 'pimwell' THEN 'pimwell.com' ELSE 'agentfeeds.dev' END,
  CASE p.slug WHEN 'pimwell' THEN '["pimwell.com","*.pimwell.com"]' ELSE '["agentfeeds.dev","*.agentfeeds.dev"]' END,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM project p JOIN tenant t ON t.id = p.tenant_id
WHERE t.slug = 'mcc' AND p.slug IN ('pimwell','agentfeed') AND p.namespace_id IS NULL AND p.kind = 'repo';
INSERT INTO site_app (site_id, app_id)
SELECT s.id, a.id FROM site s JOIN app_source a ON a.tenant_id = s.tenant_id AND a.project_id = s.project_id;
